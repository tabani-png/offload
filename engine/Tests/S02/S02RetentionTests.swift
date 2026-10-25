import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02RetentionTests {
    let utc = DayCalendar(timeZone: TimeZone(identifier: "UTC")!)

    /// Writes `count` encrypted events on the local day `day` (noon) in `days`' zone.
    func seed(_ layout: StoreLayout, day: String, count: Int = 2, days: DayCalendar) throws {
        let store = DayStore(layout: layout, plain: false, days: days)
        let noon = try #require(days.date(ofDay: day)).addingTimeInterval(12 * 3600)
        for i in 0..<count {
            try store.append(Event(id: "id\(i)", ts: epochMillis(noon) + Int64(i), kind: .resume))
        }
    }

    func now(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    @Test func deletesDayFileAndKeyOlderThan7LocalDaysAndKeepsTheRest() throws {
        let layout = StoreLayout(home: tempHome())
        for day in ["2026-10-12", "2026-10-16", "2026-10-17", "2026-10-24"] { try seed(layout, day: day, days: utc) }
        let records = Retention(layout: layout, days: utc).purge(now: now("2026-10-24T09:00:00Z"))
        #expect(records.map(\.day) == ["2026-10-12", "2026-10-16"])
        for day in ["2026-10-12", "2026-10-16"] {
            #expect(!FileManager.default.fileExists(atPath: layout.encryptedDayFile(day).path))
            #expect(!FileManager.default.fileExists(atPath: layout.keyFile(day).path))
        }
        #expect(Retention(layout: layout, days: utc).storedDays() == ["2026-10-17", "2026-10-24"])
    }

    @Test func eachPurgeAppendsAPurgeLogLine() throws {
        let layout = StoreLayout(home: tempHome())
        try seed(layout, day: "2026-10-01", count: 3, days: utc)
        let at = now("2026-10-24T09:00:00Z")
        Retention(layout: layout, days: utc).purge(now: at)
        let lines = try String(contentsOf: layout.purgeLog, encoding: .utf8).split(separator: "\n")
        #expect(lines.count == 1)
        let record = try JSONDecoder().decode(PurgeRecord.self, from: Data(lines[0].utf8))
        #expect(record == PurgeRecord(day: "2026-10-01", deletedAt: epochMillis(at), events: 3))
    }

    @Test func orphanKeysAndPlainFilesAreAlsoPurged() throws {
        let layout = StoreLayout(home: tempHome())
        try seed(layout, day: "2026-10-01", days: utc)
        try FileManager.default.removeItem(at: layout.encryptedDayFile("2026-10-01"))
        try DayStore(layout: layout, plain: true, days: utc)
            .append(Event(id: "p", ts: epochMillis(now("2026-10-02T12:00:00Z")), kind: .pause))
        Retention(layout: layout, days: utc).purge(now: now("2026-10-24T09:00:00Z"))
        #expect(Retention(layout: layout, days: utc).storedDays().isEmpty)
    }

    @Test func dayAgeUsesTheLocalTimeZone() throws {
        // 2026-10-24 23:30 UTC is already 2026-10-25 in Tokyo, so 2026-10-17 is 8 days old there but 7 in UTC.
        let tokyo = DayCalendar(timeZone: TimeZone(identifier: "Asia/Tokyo")!)
        let instant = now("2026-10-24T23:30:00Z")
        let utcLayout = StoreLayout(home: tempHome())
        try seed(utcLayout, day: "2026-10-17", days: utc)
        #expect(Retention(layout: utcLayout, days: utc).purge(now: instant).isEmpty)
        let tokyoLayout = StoreLayout(home: tempHome())
        try seed(tokyoLayout, day: "2026-10-17", days: tokyo)
        #expect(Retention(layout: tokyoLayout, days: tokyo).purge(now: instant).map(\.day) == ["2026-10-17"])
    }

    @Test func observerPurgesAtStartAndThenHourly() throws {
        let layout = StoreLayout(home: tempHome())
        let clock = ManualClock(now("2026-10-24T09:00:00Z"))
        try seed(layout, day: "2026-10-10", days: utc)
        let observer = Observer(clock: clock, workspace: FakeWorkspace(), idle: FakeIdle(), input: FakeInput(),
                                screenText: nil, pauseState: FakePause(),
                                sink: DayStore(layout: layout, plain: false, days: utc),
                                retention: Retention(layout: layout, days: utc))
        observer.start()
        #expect(observer.counters.purgedDays == 1)
        try seed(layout, day: "2026-10-11", days: utc)
        clock.advance(by: 3599)
        observer.tick()
        #expect(observer.counters.purgedDays == 1)
        clock.advance(by: 1)
        observer.tick()
        #expect(observer.counters.purgedDays == 2)
        #expect(Retention(layout: layout, days: utc).storedDays().isEmpty)
    }
}
