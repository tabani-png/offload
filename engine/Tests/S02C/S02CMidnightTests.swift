import Foundation
import Testing
@testable import OffloadCore

/// REVIEW-1 L4: at the first tick of a new local day while focused, the observer writes a synthetic `focus` carrying
/// the current app/title/url, so each day file starts with the active focus.
@Suite struct S02CMidnightTests {
    final class MidnightRig {
        let days: DayCalendar
        let clock: ManualClock
        let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.google.Chrome", appName: "Google Chrome",
                                                    windowTitle: "Inbox", url: "https://mail.google.com/mail/u/0/?x=1"))
        let idle = FakeIdle()
        let input = FakeInput()
        let pause = FakePause()
        let sink = MemorySink()
        let observer: Observer

        init(zone: String, start: Date) {
            days = DayCalendar(timeZone: TimeZone(identifier: zone)!)
            clock = ManualClock(start)
            observer = Observer(clock: clock, workspace: workspace, idle: idle, input: input, screenText: nil,
                                pauseState: pause, sink: sink, retention: nil, days: days)
            observer.start()
            observer.tick()
        }

        func run(seconds: Int) {
            for _ in 0..<seconds {
                clock.advance(by: 1)
                observer.tick()
            }
        }

        func day(_ e: Event) -> String { days.day(of: Date(timeIntervalSince1970: TimeInterval(e.ts) / 1000)) }

        /// Events grouped by local day, in write order.
        func byDay() -> [String: [Event]] { Dictionary(grouping: sink.events, by: day) }
    }

    /// `HH:MM:SS` on a local day in a zone.
    static func local(_ zone: String, _ day: String, _ h: Int, _ m: Int = 0, _ s: Int = 0) -> Date {
        let cal = DayCalendar(timeZone: TimeZone(identifier: zone)!)
        return cal.date(ofDay: day)!.addingTimeInterval(TimeInterval(h * 3600 + m * 60 + s))
    }

    @Test func crossingMidnightWhileFocusedWritesOneSyntheticFocusInTheNewDay() throws {
        let rig = MidnightRig(zone: "Europe/London", start: Self.local("Europe/London", "2026-10-20", 23, 59, 50))
        rig.run(seconds: 60)
        let focus = rig.sink.of(.focus)
        #expect(focus.count == 2)
        let carried = try #require(focus.last)
        #expect(rig.day(carried) == "2026-10-21")
        #expect(carried.app == "com.google.Chrome")
        #expect(carried.appName == "Google Chrome")
        #expect(carried.title == "Inbox")
        #expect(carried.url == "https://mail.google.com/mail/u/0/")
        #expect(carried.host == "mail.google.com")
        #expect(carried.id != focus.first?.id)
        // Written on the first tick of the new day.
        let midnight = try #require(rig.days.date(ofDay: "2026-10-21"))
        #expect(carried.ts - epochMillis(midnight) <= 1000)
    }

    @Test func eachDayFileStartsWithTheActiveFocus() throws {
        let rig = MidnightRig(zone: "Asia/Tokyo", start: Self.local("Asia/Tokyo", "2026-10-20", 23, 59, 0))
        rig.input.pending = InputCounts(keys: 5, clicks: 1)
        rig.run(seconds: 120)
        let grouped = rig.byDay()
        #expect(grouped["2026-10-21"]?.first?.kind == .focus)
        #expect(grouped["2026-10-20"]?.first?.kind == .focus)
    }

    @Test func noSyntheticFocusWithoutAMidnight() {
        let rig = MidnightRig(zone: "UTC", start: Self.local("UTC", "2026-10-20", 10))
        rig.run(seconds: 3600)
        #expect(rig.sink.of(.focus).count == 1)
    }

    @Test func aRealFocusChangeRightAfterMidnightIsNotDoubled() {
        let rig = MidnightRig(zone: "UTC", start: Self.local("UTC", "2026-10-20", 23, 59, 59))
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.mail", appName: "Mail", windowTitle: "Inbox")
        rig.run(seconds: 10)
        let focus = rig.sink.of(.focus)
        #expect(focus.map(\.app) == ["com.google.Chrome", "com.apple.mail"])
        #expect(rig.day(focus[1]) == "2026-10-21")
    }

    @Test func pausedAcrossMidnightWritesNoSyntheticFocus() {
        let rig = MidnightRig(zone: "UTC", start: Self.local("UTC", "2026-10-20", 23, 59, 0))
        rig.pause.isPaused = true
        rig.run(seconds: 120)
        #expect(rig.sink.of(.focus).count == 1)
        #expect(rig.sink.kinds().last == .pause)
    }

    @Test func idleAcrossMidnightWaitsUntilIdleEndsThenWritesTheFocus() throws {
        let rig = MidnightRig(zone: "UTC", start: Self.local("UTC", "2026-10-20", 23, 50))
        rig.idle.seconds = 600
        rig.run(seconds: 20 * 60)  // to 00:10, idle the whole time
        #expect(rig.sink.of(.focus).count == 1)
        rig.idle.seconds = 0
        rig.run(seconds: 3)
        let newDay = try #require(rig.byDay()["2026-10-21"])
        #expect(newDay.map(\.kind).prefix(2) == [.idleEnd, .focus])
        #expect(rig.sink.of(.focus).count == 2)
    }

    @Test func nothingFrontmostAtMidnightCarriesTheLastSnapshot() throws {
        let rig = MidnightRig(zone: "UTC", start: Self.local("UTC", "2026-10-20", 23, 59, 50))
        rig.run(seconds: 5)
        rig.workspace.current = nil
        rig.run(seconds: 20)
        let carried = try #require(rig.sink.of(.focus).last)
        #expect(rig.sink.of(.focus).count == 2)
        #expect(rig.day(carried) == "2026-10-21")
        #expect(carried.title == "Inbox")
    }

    @Test func fallBackDSTDayGetsExactlyOneSyntheticFocusPerMidnight() throws {
        // New York leaves DST on 2026-11-01 at 02:00 EDT (01:00-02:00 repeats); that day has 25 hours.
        let zone = "America/New_York"
        let start = Self.local(zone, "2026-10-31", 23, 59, 30)
        let end = Self.local(zone, "2026-11-02", 0, 0, 30)
        let rig = MidnightRig(zone: zone, start: start)
        #expect(Int(end.timeIntervalSince(start)) == 24 * 3600 + 3600 + 60)
        rig.run(seconds: Int(end.timeIntervalSince(start)))
        let focus = rig.sink.of(.focus)
        #expect(focus.map(rig.day) == ["2026-10-31", "2026-11-01", "2026-11-02"])
        let nov2 = try #require(rig.days.date(ofDay: "2026-11-02"))
        #expect(focus[2].ts - epochMillis(nov2) <= 1000)
        #expect(focus[2].ts - focus[1].ts >= 25 * 3600 * 1000 - 1000)
    }

    @Test func springForwardDSTDayGetsExactlyOneSyntheticFocusPerMidnight() throws {
        // New York enters DST on 2026-03-08 at 02:00 EST (02:00-03:00 is skipped); that day has 23 hours.
        let zone = "America/New_York"
        let start = Self.local(zone, "2026-03-07", 23, 59, 30)
        let end = try #require(DayCalendar(timeZone: TimeZone(identifier: zone)!).date(ofDay: "2026-03-09"))
            .addingTimeInterval(30)
        let rig = MidnightRig(zone: zone, start: start)
        rig.run(seconds: Int(end.timeIntervalSince(start)))
        let focus = rig.sink.of(.focus)
        #expect(focus.map(rig.day) == ["2026-03-07", "2026-03-08", "2026-03-09"])
        #expect(focus[2].ts - focus[1].ts <= 23 * 3600 * 1000 + 1000)
    }

    @Test func aZoneWhoseMidnightIsSkippedStillRollsOverOnce() throws {
        // Chile (America/Santiago) enters DST at 24:00 on the first Saturday of September: 2026-09-06 starts at
        // 01:00 local, there is no 00:00. Use Foundation's own transition so the test does not hard-code tzdata.
        let zone = try #require(TimeZone(identifier: "America/Santiago"))
        let after = ISO8601DateFormatter().date(from: "2026-08-15T00:00:00Z")!
        let transition = try #require(zone.nextDaylightSavingTimeTransition(after: after))
        let rig = MidnightRig(zone: "America/Santiago", start: transition.addingTimeInterval(-90))
        let before = rig.days.day(of: transition.addingTimeInterval(-90))
        let afterDay = rig.days.day(of: transition.addingTimeInterval(1))
        rig.run(seconds: 180)
        let focus = rig.sink.of(.focus)
        if before == afterDay {
            #expect(focus.count == 1)  // tzdata moved the change off midnight: no rollover, no synthetic focus
        } else {
            #expect(focus.map(rig.day) == [before, afterDay])
        }
    }

    @Test func liveDayStoreFileForTheNewDayStartsWithFocus() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let days = DayCalendar(timeZone: TimeZone(identifier: "Europe/Berlin")!)
        let store = DayStore(layout: layout, plain: true, days: days)
        let clock = ManualClock(Self.local("Europe/Berlin", "2026-10-24", 23, 59, 55))
        let ws = FakeWorkspace(FocusSnapshot(bundleID: "com.apple.Safari", appName: "Safari", windowTitle: "Docs",
                                             url: "https://docs.example.com/a?b=c"))
        let observer = Observer(clock: clock, workspace: ws, idle: FakeIdle(), input: FakeInput(), screenText: nil,
                                pauseState: FakePause(), sink: store, retention: nil, days: days)
        observer.start()
        for _ in 0..<15 {
            observer.tick()
            clock.advance(by: 1)
        }
        let first = try #require(try store.read(day: "2026-10-25").first)
        #expect(first.kind == .focus)
        #expect(first.app == "com.apple.Safari")
        #expect(first.url == "https://docs.example.com/a")
    }
}
