import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02BStatusTests {
    let local = DayCalendar()

    func noon(_ day: String) throws -> Date {
        try #require(local.date(ofDay: day)).addingTimeInterval(12 * 3600)
    }

    func seed(_ layout: StoreLayout, day: String, events: Int, plain: Bool = false) throws {
        let store = DayStore(layout: layout, plain: plain, days: local)
        for n in 0..<events {
            try store.append(Event(id: "01S\(n)", ts: epochMillis(try noon(day)) + Int64(n), kind: .focus,
                                   app: "com.apple.mail", appName: "Mail"))
        }
    }

    func json(_ args: [String], env: [String: String] = [:], now: Date,
              permissions: PermissionState? = nil) throws -> [String: Any] {
        var out: [String] = []
        let code = ObserverCLI.runOffline(try ObserverCLI.parse(args), environment: env, now: now, days: local,
                                          permissions: permissions, out: { out.append($0) }, err: { _ in })
        #expect(code == 0)
        return try #require(try JSONSerialization.jsonObject(with: Data(out.joined(separator: "\n").utf8))
            as? [String: Any])
    }

    @Test func statusJsonListsDaysWithEventCountsKeysModeAndPause() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        try seed(layout, day: "2026-10-20", events: 3)
        try seed(layout, day: "2026-10-22", events: 2, plain: true)
        try FilePauseControl(layout: layout).pause(at: Date())
        let now = try noon("2026-10-23")
        let report = try json(["status", "--json", "--home", home.path], env: ["OFFLOAD_KEYS": "file"], now: now,
                              permissions: PermissionState(screenRecording: true, accessibility: false,
                                                           inputMonitoring: true))
        #expect(report["schemaVersion"] as? Int == 1)
        #expect(report["paused"] as? Bool == true)
        #expect(report["running"] as? Bool == false)
        #expect(report["keysMode"] as? String == "file")
        let days = try #require(report["days"] as? [[String: Any]])
        #expect(days.map { $0["day"] as? String } == ["2026-10-20", "2026-10-22"])
        #expect(days.map { $0["events"] as? Int } == [3, 2])
        #expect(days.map { $0["encrypted"] as? Bool } == [true, false])
        let perms = try #require(report["permissions"] as? [String: Bool])
        #expect(perms == ["screenRecording": true, "accessibility": false, "inputMonitoring": true])
        #expect(report["permissionsSource"] as? String == "probe")
        let keys = try #require(report["keyFiles"] as? [String: Int])
        #expect(keys == ["raw": 1, "wrapped": 0])
    }

    @Test func nextExpiryIsWhenTheOldestDayLeavesTheThirtyDayWindow() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        try seed(layout, day: "2026-10-20", events: 1)
        let report = try json(["status", "--json", "--home", home.path], now: try noon("2026-10-23"))
        let expiry = try #require(report["nextExpiry"] as? [String: Any])
        #expect(expiry["day"] as? String == "2026-10-20")
        let at = try #require(local.date(ofDay: "2026-11-20"))  // age 31 starts on 11-20
        #expect((expiry["at"] as? NSNumber)?.int64Value == epochMillis(at))
        #expect(report["nextPurgeAt"] is NSNull || report["nextPurgeAt"] == nil)  // nothing running
        #expect(report["keysMode"] as? String == "keychain")
    }

    @Test func aRunningObserverSuppliesNextPurgeAndPermissionsFromItsHeartbeat() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let rig = Rig()
        rig.startAndTick()
        let now = rig.clock.now
        let beat = rig.observer.heartbeat(pid: getpid(), startedAt: now, now: now, plain: false,
                                          permissions: PermissionState(screenRecording: false, accessibility: true,
                                                                       inputMonitoring: false), keysMode: .keychain)
        #expect(beat.nextPurgeAt == epochMillis(now) + 3_600_000)
        writeHeartbeat(beat, layout: layout)
        let report = StatusReport.build(layout: layout, now: now, keysMode: .keychain,
                                        probe: PermissionState(screenRecording: true, accessibility: true,
                                                               inputMonitoring: true))
        #expect(report.running)
        #expect(report.nextPurgeAt == epochMillis(now) + 3_600_000)
        #expect(report.permissions == beat.permissions)
        #expect(report.permissionsSource == "heartbeat")
    }

    @Test func plainStatusIsTheSameJsonAndOldFieldsStay() throws {
        let home = tempHome()
        let now = Date()
        let a = try json(["status", "--home", home.path], now: now)
        let b = try json(["status", "--json", "--home", home.path], now: now)
        #expect(NSDictionary(dictionary: a) == NSDictionary(dictionary: b))
        for key in ["home", "running", "paused", "daysStored", "keepDays"] { #expect(a[key] != nil, "\(key)") }
    }

    @Test func builtBinaryStatusJsonAndExportInFileMode() throws {
        let build = ProcessInfo.processInfo.environment["OFFLOAD_BUILD_DIR"]
            ?? engineDir().appendingPathComponent(".build").path
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let day = local.day(of: Date())
        try DayStore(layout: layout, plain: false, days: local)
            .append(Event(id: "01BIN", ts: epochMillis(Date()), kind: .focus, app: "a", appName: "A"))
        func run(_ args: [String]) throws -> (Int32, String) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: build + "/offload-observer")
            p.arguments = args + ["--home", home.path]
            var env = ProcessInfo.processInfo.environment
            env["OFFLOAD_KEYS"] = "file"
            p.environment = env
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            try p.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return (p.terminationStatus, String(decoding: data, as: UTF8.self))
        }
        let (code, out) = try run(["status", "--json"])
        #expect(code == 0)
        let report = try JSONDecoder().decode(StatusReport.self, from: Data(out.utf8))
        #expect(report.keysMode == "file")
        #expect(report.days.map(\.events) == [1])
        #expect(report.permissions != nil)
        let (exportCode, lines) = try run(["export-day", day])
        #expect(exportCode == 0)
        #expect(lines.contains("01BIN"))
    }
}
