import Foundation
import Testing
@testable import OffloadCore

/// REVIEW-1 M4: `export-day` must not serve a day older than the 7-day window, and asking for one purges it.
@Suite struct S02CExportAgeTests {
    let utc = DayCalendar(timeZone: TimeZone(identifier: "UTC")!)
    let now = ISO8601DateFormatter().date(from: "2026-10-24T09:00:00Z")!

    func seed(_ layout: StoreLayout, day: String) throws -> Event {
        let noon = try #require(utc.date(ofDay: day)).addingTimeInterval(12 * 3600)
        let e = Event(id: "01M4\(day)", ts: epochMillis(noon), kind: .focus, app: "com.apple.mail", appName: "Mail",
                      title: "secret thread")
        try DayStore(layout: layout, plain: false, days: utc).append(e)
        return e
    }

    func export(_ day: String, home: URL) throws -> (code: Int32, out: [String], err: [String]) {
        var out: [String] = []
        var err: [String] = []
        let code = ObserverCLI.runOffline(try ObserverCLI.parse(["export-day", day, "--home", home.path]),
                                          environment: ["OFFLOAD_KEYS": "file"], now: now, days: utc,
                                          out: { out.append($0) }, err: { err.append($0) })
        return (code, out, err)
    }

    @Test func aDayOlderThan7DaysIsRefusedWithExit3AndAClearMessage() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        _ = try seed(layout, day: "2026-10-14")  // 10 days old
        let r = try export("2026-10-14", home: home)
        #expect(r.code == 3)
        #expect(r.out.isEmpty)
        #expect(r.err.count == 1)
        #expect(r.err.first?.contains("older than 7 days") == true)
        #expect(r.err.first?.contains("secret thread") == false)
    }

    @Test func refusingAnOldDayPurgesItsFileAndKeyAndLogsThePurge() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        _ = try seed(layout, day: "2026-10-14")
        _ = try seed(layout, day: "2026-10-23")
        #expect(try export("2026-10-14", home: home).code == 3)
        #expect(!FileManager.default.fileExists(atPath: layout.encryptedDayFile("2026-10-14").path))
        #expect(!FileManager.default.fileExists(atPath: layout.keyFile("2026-10-14").path))
        #expect(FileManager.default.fileExists(atPath: layout.encryptedDayFile("2026-10-23").path))
        let log = try String(contentsOf: layout.purgeLog, encoding: .utf8)
        #expect(log.contains("\"day\":\"2026-10-14\""))
    }

    @Test func theOldestKeptDayStillExports() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let e = try seed(layout, day: "2026-10-17")  // age 7: kept
        let r = try export("2026-10-17", home: home)
        #expect(r.code == 0, "\(r.err)")
        #expect(r.out == [String(decoding: try e.jsonLine(), as: UTF8.self)])
    }

    @Test func anOldDayWithNoFilesIsStillRefusedAsExpiredNotNotFound() throws {
        let r = try export("2026-09-01", home: tempHome())
        #expect(r.code == 3)
        #expect(r.err.first?.contains("older than 7 days") == true)
    }

    @Test func todayAndInvalidDaysKeepTheirOldExitCodes() throws {
        let home = tempHome()
        #expect(try export("2026-10-24", home: home).code == 1)  // not found
        #expect(try export("2026-13-40", home: home).code == 1)  // invalid day
    }

    @Test func builtBinaryExitsWith3ForAnExpiredDay() throws {
        let build = ProcessInfo.processInfo.environment["OFFLOAD_BUILD_DIR"] ?? engineDir().appendingPathComponent(".build").path
        let home = tempHome()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: build + "/offload-observer")
        p.arguments = ["export-day", "2020-01-01", "--home", home.path]
        p.environment = ["OFFLOAD_KEYS": "file"]
        let errPipe = Pipe()
        p.standardOutput = FileHandle.nullDevice
        p.standardError = errPipe
        try p.run()
        let err = String(decoding: errPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        #expect(p.terminationStatus == 3)
        #expect(err.contains("older than 7 days"))
    }
}
