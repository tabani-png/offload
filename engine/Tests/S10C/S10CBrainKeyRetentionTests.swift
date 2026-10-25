import Foundation
import Testing
@testable import OffloadCore

/// REVIEW-2 N4: observer retention also deletes `keys/brain-YYYY-MM-DD.key` past the 7-day window, so the brain's
/// sealed files become unreadable even when the brain never runs; `unwrap-key` refuses expired day names.
@Suite struct S10CBrainKeyRetentionTests {
    func seedDay(_ layout: StoreLayout, _ day: String) throws {
        let noon = try #require(s10cUTC.date(ofDay: day)).addingTimeInterval(12 * 3600)
        try DayStore(layout: layout, plain: false, days: s10cUTC)
            .append(Event(id: "01N4\(day)", ts: epochMillis(noon), kind: .focus, app: "com.apple.mail", appName: "Mail"))
    }

    @Test func purgeDeletesBrainKeysNamedForExpiredDaysOnly() throws {
        let layout = StoreLayout(home: tempHome())
        let secrets = MemorySecretStore()
        for name in ["2026-10-14", "2026-10-16", "2026-10-17", "2026-10-24", "vault", "2026-13-45", "2026-02-30"] {
            try s10cBrainKey(layout, name, secrets: secrets)
        }
        let outcome = Retention(layout: layout, days: s10cUTC).purgeAll(now: s10cNow)
        #expect(outcome.brainKeys == ["2026-10-14", "2026-10-16"])
        #expect(!s10cExists(layout.brainKeyFile("2026-10-14")))
        #expect(!s10cExists(layout.brainKeyFile("2026-10-16")))
        for kept in ["2026-10-17", "2026-10-24", "vault", "2026-13-45", "2026-02-30"] {
            #expect(s10cExists(layout.brainKeyFile(kept)), "\(kept) must be left alone")
        }
    }

    @Test func aDayWithFilesAndABrainKeyLosesAllOfThemAndLogsOneLine() throws {
        let layout = StoreLayout(home: tempHome())
        try seedDay(layout, "2026-10-14")
        try s10cBrainKey(layout, "2026-10-14", secrets: MemorySecretStore())
        let outcome = Retention(layout: layout, days: s10cUTC).purgeAll(now: s10cNow)
        #expect(outcome.days.map(\.day) == ["2026-10-14"])
        #expect(outcome.brainKeys == ["2026-10-14"])
        #expect(!s10cExists(layout.encryptedDayFile("2026-10-14")))
        #expect(!s10cExists(layout.keyFile("2026-10-14")))
        #expect(!s10cExists(layout.brainKeyFile("2026-10-14")))
        let log = try String(contentsOf: layout.purgeLog, encoding: .utf8)
        #expect(log.split(separator: "\n").count == 1)
    }

    @Test func aBrainKeyIsNotAStoredDay() throws {
        let layout = StoreLayout(home: tempHome())
        try s10cBrainKey(layout, "2026-10-14", secrets: MemorySecretStore())
        let retention = Retention(layout: layout, days: s10cUTC)
        #expect(retention.storedDays().isEmpty)
        #expect(retention.purge(now: s10cNow).isEmpty)  // no day record for a key-only day
        #expect(!s10cExists(layout.brainKeyFile("2026-10-14")))
    }

    @Test func purgeNowReportsDeletedBrainKeys() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        try s10cBrainKey(StoreLayout(home: home), "2026-10-10", secrets: secrets)
        let r = try s10cCLI(["purge-now"], home: home, secrets: secrets)
        #expect(r.code == 0)
        #expect(r.out.joined().hasPrefix("purged 0"))
        #expect(r.out.joined().contains("1 expired brain key(s): 2026-10-10"))
    }

    @Test func theRunningObserverPurgesExpiredBrainKeysAtStart() throws {
        let layout = StoreLayout(home: tempHome())
        try s10cBrainKey(layout, "2026-10-01", secrets: MemorySecretStore())
        let clock = ManualClock(s10cNow)
        let observer = Observer(clock: clock, workspace: FakeWorkspace(), idle: FakeIdle(), input: FakeInput(),
                                screenText: nil, pauseState: FakePause(), sink: MemorySink(),
                                retention: Retention(layout: layout, days: s10cUTC), days: s10cUTC)
        observer.start()
        #expect(!s10cExists(layout.brainKeyFile("2026-10-01")))
        #expect(observer.counters.purgedBrainKeys == 1)
    }

    @Test func statusListsBrainKeysThatAreNotDatesAsOtherBrainKeys() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        for name in ["vault", "2026-10-20", "2026-13-45"] { try s10cBrainKey(layout, name, secrets: secrets) }
        let report = StatusReport.build(layout: layout, now: s10cNow, days: s10cUTC)
        #expect(report.otherBrainKeys == ["2026-13-45", "vault"])
        #expect(report.daysStored.isEmpty)
        let r = try s10cCLI(["status", "--json"], home: home, secrets: secrets)
        let json = try #require(JSONSerialization.jsonObject(with: Data(r.out.joined().utf8)) as? [String: Any])
        #expect(json["otherBrainKeys"] as? [String] == ["2026-13-45", "vault"])
        #expect(json["schemaVersion"] as? Int == 1)
    }

    @Test func unwrapRefusesAnExpiredDayNameWithExit3AndPurgesIt() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        try s10cBrainKey(layout, "2026-10-16", secrets: secrets)
        let r = try s10cCLI(["unwrap-key", "--name", "2026-10-16"], home: home, secrets: secrets)
        #expect(r.code == 3)
        #expect(r.out.isEmpty)
        #expect(r.err.first?.contains("older than 7 days") == true)
        #expect(!s10cExists(layout.brainKeyFile("2026-10-16")))
    }

    @Test func unwrapStillServesTheLastKeptDayAndNonDateNames() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        for name in ["2026-10-17", "vault", "2026-02-30"] {
            try s10cBrainKey(layout, name, secrets: secrets)
            let r = try s10cCLI(["unwrap-key", "--name", name], home: home, secrets: secrets)
            #expect(r.code == 0, "\(name): \(r.err)")
            #expect(r.out.count == 1)
        }
    }

    @Test func wrapRefusesAnExpiredDayNameWithExit3AndStoresNothing() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        let r = try s10cCLI(["wrap-key", "--name", "2026-10-10"], home: home, secrets: secrets)
        #expect(r.code == 3)
        #expect(r.out.isEmpty)
        #expect(!s10cExists(StoreLayout(home: home).brainKeyFile("2026-10-10")))
    }
}
