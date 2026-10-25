import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02CLITests {
    @Test func parsesEveryCommandAndTheHomeFlag() throws {
        #expect(try ObserverCLI.parse(["run", "--home", "/tmp/x"]) == ParsedArguments(command: .run, home: "/tmp/x"))
        #expect(try ObserverCLI.parse(["--home=/tmp/y", "status"]) == ParsedArguments(command: .status, home: "/tmp/y"))
        #expect(try ObserverCLI.parse(["purge-now"]).command == .purgeNow)
        #expect(try ObserverCLI.parse(["export-day", "2026-10-20"]).command == .exportDay("2026-10-20"))
        #expect(try ObserverCLI.parse([]).command == .help)
    }

    @Test func rejectsUnknownCommandsAndMissingValues() {
        #expect(throws: ArgumentError.unknownCommand("record")) { try ObserverCLI.parse(["record"]) }
        #expect(throws: ArgumentError.missingValue("--home")) { try ObserverCLI.parse(["run", "--home"]) }
        #expect(throws: ArgumentError.missingValue("export-day")) { try ObserverCLI.parse(["export-day"]) }
    }

    @Test func exportDayPrintsDecryptedJsonLines() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let local = DayCalendar()
        let noon = try #require(local.date(ofDay: "2026-10-20")).addingTimeInterval(12 * 3600)
        let event = Event(id: "01A", ts: epochMillis(noon), kind: .focus, app: "com.apple.mail", appName: "Mail")
        try DayStore(layout: layout, plain: false, days: local).append(event)
        var out: [String] = []
        let code = ObserverCLI.runOffline(try ObserverCLI.parse(["export-day", "2026-10-20", "--home", home.path]),
                                          environment: [:], now: Date(), days: local, out: { out.append($0) }, err: { _ in })
        #expect(code == 0)
        #expect(out == [String(decoding: try event.jsonLine(), as: UTF8.self)])
    }

    @Test func exportOfAMissingDayFailsWithAMessage() throws {
        var err: [String] = []
        let today = DayCalendar().day(of: Date())  // within retention, so the missing file is what fails (s02c: old days exit 3)
        let code = ObserverCLI.runOffline(try ObserverCLI.parse(["export-day", today, "--home", tempHome().path]),
                                          environment: [:], now: Date(), out: { _ in }, err: { err.append($0) })
        #expect(code == 1)
        #expect(err.first?.contains("notFound") == true)
    }

    @Test func builtBinaryPausesReportsStatusAndExportsOverTheRealCommandLine() throws {
        let build = ProcessInfo.processInfo.environment["OFFLOAD_BUILD_DIR"] ?? engineDir().appendingPathComponent(".build").path
        let home = tempHome()
        func run(_ args: [String]) throws -> (Int32, String) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: build + "/offload-observer")
            p.arguments = args + ["--home", home.path]
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            try p.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return (p.terminationStatus, String(decoding: data, as: UTF8.self))
        }
        #expect(try run(["pause"]).0 == 0)
        let (code, json) = try run(["status"])
        #expect(code == 0)
        let report = try JSONDecoder().decode(StatusReport.self, from: Data(json.utf8))
        #expect(report.paused)
        #expect(!report.running)
        #expect(try run(["purge-now"]).1.hasPrefix("purged 0"))
        #expect(try run(["bogus"]).0 == 2)
    }
}
