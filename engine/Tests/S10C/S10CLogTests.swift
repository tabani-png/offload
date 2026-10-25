import Foundation
import Testing
@testable import OffloadCore

/// REVIEW-2 privacy table: observer logs rotate at 5 MB and keep 2 old files, and never carry titles, URLs, OCR
/// text or keys.
@Suite struct S10CLogTests {
    func logsDir() throws -> URL {
        let dir = tempHome().appendingPathComponent("logs", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func write(_ url: URL, bytes: Int, fill: UInt8 = 0x61) throws {
        try Data(repeating: fill, count: bytes).write(to: url)
    }

    func size(_ url: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? -1
    }

    @Test func defaultsAre5MBAndKeep2() {
        #expect(LogRotation.defaultMaxBytes == 5 * 1024 * 1024)
        #expect(LogRotation.defaultKeep == 2)
        #expect(LogRotation.defaultNames == ["observer.out.log", "observer.err.log"])
    }

    @Test func aLogUnderTheLimitIsLeftAlone() throws {
        let dir = try logsDir()
        let err = dir.appendingPathComponent("observer.err.log")
        try write(err, bytes: 1000)
        #expect(LogRotation(directory: dir, maxBytes: 1001).rotateIfNeeded().isEmpty)
        #expect(try size(err) == 1000)
        #expect(!s10cExists(dir.appendingPathComponent("observer.err.log.1")))
    }

    @Test func atTheLimitTheLogMovesToDot1AndIsEmptiedInPlace() throws {
        let dir = try logsDir()
        let err = dir.appendingPathComponent("observer.err.log")
        try write(err, bytes: 5 * 1024 * 1024)
        let inode = try FileManager.default.attributesOfItem(atPath: err.path)[.systemFileNumber] as? NSNumber
        #expect(LogRotation(directory: dir).rotateIfNeeded() == ["observer.err.log"])
        #expect(try size(err) == 0)
        #expect(try FileManager.default.attributesOfItem(atPath: err.path)[.systemFileNumber] as? NSNumber == inode)
        let old = dir.appendingPathComponent("observer.err.log.1")
        #expect(try size(old) == 5 * 1024 * 1024)
        let mode = try FileManager.default.attributesOfItem(atPath: old.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func onlyTwoOldFilesAreKept() throws {
        let dir = try logsDir()
        let out = dir.appendingPathComponent("observer.out.log")
        let rotation = LogRotation(directory: dir, maxBytes: 10)
        for fill: UInt8 in [0x31, 0x32, 0x33, 0x34] {
            try write(out, bytes: 10, fill: fill)
            #expect(rotation.rotateIfNeeded() == ["observer.out.log"])
        }
        #expect(try Data(contentsOf: dir.appendingPathComponent("observer.out.log.1")).first == 0x34)
        #expect(try Data(contentsOf: dir.appendingPathComponent("observer.out.log.2")).first == 0x33)
        #expect(!s10cExists(dir.appendingPathComponent("observer.out.log.3")))
    }

    @Test func aWriterHoldingAnAppendHandleKeepsWritingToTheEmptiedLog() throws {
        let dir = try logsDir()
        let err = dir.appendingPathComponent("observer.err.log")
        FileManager.default.createFile(atPath: err.path, contents: nil)
        let fd = open(err.path, O_WRONLY | O_APPEND)  // what launchd holds for StandardErrorPath
        #expect(fd >= 0)
        defer { close(fd) }
        let before = Array(repeating: UInt8(0x62), count: 64)
        _ = before.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, 64) }
        #expect(LogRotation(directory: dir, maxBytes: 64).rotateIfNeeded() == ["observer.err.log"])
        let after = Array("after\n".utf8)
        _ = after.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, after.count) }
        #expect(try String(contentsOf: err, encoding: .utf8) == "after\n")
    }

    @Test func theObserverRotatesAtStartAndAgainWithinAMinute() throws {
        let dir = try logsDir()
        let err = dir.appendingPathComponent("observer.err.log")
        try write(err, bytes: 100)
        let clock = ManualClock(s10cNow)
        let observer = Observer(clock: clock, workspace: FakeWorkspace(), idle: FakeIdle(), input: FakeInput(),
                                screenText: nil, pauseState: FakePause(), sink: MemorySink(), retention: nil,
                                logRotation: LogRotation(directory: dir, maxBytes: 100))
        observer.start()
        #expect(try size(err) == 0)
        try write(err, bytes: 100)
        for _ in 0..<60 {
            clock.advance(by: 1)
            observer.tick()
        }
        #expect(try size(err) == 0)
        #expect(s10cExists(dir.appendingPathComponent("observer.err.log.2")))
    }

    /// A run with sensitive fixtures and forced failures on every path that logs: nothing observed reaches the log.
    @Test func logsNeverCarryTitlesURLsOCRTextOrKeys() throws {
        let title = "Q4 Merger Plan - Jane Doe salary"
        let url = "https://intranet.example.com/deals/acme-merger?token=s3cr3t#notes"
        let ocrText = "Confidential: acme merger closes friday"
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        let key = Data((0..<32).map { UInt8(($0 * 29 + 3) & 0xff) })
        let keyB64 = key.base64EncodedString()
        let capture = LogCapture()
        var cliErr: [String] = []

        try Log.$capture.withValue(capture) {
            // Broken exclusions file, an expired day for retention, and an observer whose writes and OCR fail.
            try layout.ensureDirectories()
            try Data("{\"titleContains\": [\"\(title)\"".utf8).write(to: layout.exclusionsFile)
            let noon = try #require(s10cUTC.date(ofDay: "2026-10-10")).addingTimeInterval(43_200)
            try DayStore(layout: layout, plain: false, days: s10cUTC)
                .append(Event(id: "01LOG", ts: epochMillis(noon), kind: .focus, app: "com.apple.Safari",
                              appName: "Safari", title: title, url: url))
            let clock = ManualClock(s10cNow)
            let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.google.Chrome", appName: "Google Chrome",
                                                        windowTitle: title, url: url))
            let screen = FakeScreenText()
            screen.text = ocrText
            let sink = FailingSink()
            let observer = Observer(clock: clock, workspace: workspace, idle: FakeIdle(), input: FakeInput(available: false),
                                    screenText: screen, pauseState: FakePause(), sink: sink,
                                    retention: Retention(layout: layout, days: s10cUTC),
                                    exclusions: ExclusionReloader(file: ExclusionFile(layout: layout)), days: s10cUTC)
            observer.start()
            for i in 0..<70 {
                if i == 35 {
                    screen.error = NSError(domain: "SCStreamErrorDomain", code: -3801,
                                           userInfo: [NSLocalizedDescriptionKey: "cannot capture \(title) at \(url)"])
                }
                if i == 40 { sink.message = "write failed for \(title) \(ocrText)" }
                clock.advance(by: 1)
                observer.tick()
            }
            #expect(observer.counters.writeErrors > 0)
            #expect(observer.counters.ocrErrors > 0)

            // CLI paths that print to stderr: key import, conflicts, wrong master key, export and status.
            func cli(_ args: [String], stdin: String = "", store: SecretStore? = nil) throws {
                cliErr += try s10cCLI(args, home: home, secrets: store ?? secrets, stdin: stdin).err
            }
            try cli(["wrap-key", "--name", "a"], stdin: keyB64)
            try cli(["wrap-key", "--name", "a", "--import"], stdin: keyB64)
            try cli(["wrap-key", "--name", "a", "--import"], stdin: Data(repeating: 7, count: 32).base64EncodedString())
            try cli(["unwrap-key", "--name", "a"], store: MemorySecretStore())
            try cli(["unwrap-key", "--name", "2026-10-01"])
            try cli(["export-day", "2026-10-10"])
            try cli(["export-day", "2026-10-24"])
            try Data("not json".utf8).write(to: layout.statusFile)
            try cli(["status", "--json"])
        }

        let lines = capture.lines
        #expect(!lines.isEmpty, "the run must have logged something, or the check is vacuous")
        #expect(lines.contains { $0.contains("[store]") })
        #expect(lines.contains { $0.contains("[ocr]") })
        #expect(lines.contains { $0.contains("[exclusions]") })
        let all = (lines + cliErr).joined(separator: "\n")
        for secret in [title, "Q4 Merger", "Jane Doe", url, "intranet.example.com", "s3cr3t", ocrText, "acme merger",
                       keyB64, String(keyB64.prefix(16))] {
            #expect(!all.contains(secret), "log leaked \(secret)")
        }
    }
}

/// A sink that always throws a system error whose description carries observed text (the log must not repeat it).
final class FailingSink: EventSink {
    var message = "injected"
    func append(_ event: Event) throws {
        throw NSError(domain: NSPOSIXErrorDomain, code: 28, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
