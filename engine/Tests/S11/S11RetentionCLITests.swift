import Foundation
import Testing
@testable import OffloadCore

@Suite struct S11RetentionCLITests {
    /// 2026-10-20 10:00:00 UTC.
    let now = Date(timeIntervalSince1970: 1_792_490_400)
    let ids = ULIDGenerator()

    func put(_ home: URL, at date: Date) throws -> String {
        let layout = StoreLayout(home: home)
        let s = FrameStore(layout: layout, days: s11UTC, keys: DayKeyVault(layout: layout, mode: .file, secrets: nil))
        let ts = epochMillis(date)
        let id = ids.next(millis: ts)
        try s.storeFrame(Data("jpeg-bytes-\(id)".utf8), meta: FrameMeta(frameId: id, ts: ts, app: "a", appName: "A", host: nil,
                                                                       phash: "0000000000000000", width: 1, height: 1, bytes: 10, maskedRegions: 0))
        return id
    }

    func cli(_ args: [String], home: URL, now: Date) -> (code: Int32, out: [String], err: [String], bytes: Data) {
        var out: [String] = []
        var err: [String] = []
        var bytes = Data()
        let parsed: ParsedArguments
        do { parsed = try ObserverCLI.parse(args + ["--home", home.path]) } catch { return (2, [], ["\(error)"], Data()) }
        let code = ObserverCLI.runOffline(parsed, environment: ["OFFLOAD_KEYS": "file"], now: now, days: s11UTC,
                                          out: { out.append($0) }, err: { err.append($0) }, outBytes: { bytes.append($0) })
        return (code, out, err, bytes)
    }

    func purgeLog(_ home: URL) throws -> [[String: Any]] {
        let data = try Data(contentsOf: StoreLayout(home: home).purgeLog)
        return try data.split(separator: UInt8(ascii: "\n")).map { try JSONSerialization.jsonObject(with: Data($0)) as! [String: Any] }
    }

    @Test func framesArePurgedWithTheirDayAndCountedInThePurgeLog() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let old = now.addingTimeInterval(-9 * 86_400)
        _ = try put(home, at: old)
        _ = try put(home, at: old.addingTimeInterval(60))
        let keep = try put(home, at: now)
        // An old day that also has events: its line keeps `events` and gains `frames`.
        let layout = StoreLayout(home: home)
        let dayStore = DayStore(layout: layout, plain: false, days: s11UTC)
        try dayStore.append(Event(id: ids.next(millis: epochMillis(old)), ts: epochMillis(old), kind: .focus, app: "a"))
        let records = Retention(layout: layout, days: s11UTC).purge(now: now)
        #expect(records.map(\.day) == ["2026-10-11"])
        #expect(records.first?.frames == 2)
        #expect(records.first?.events == 1)
        #expect(!FileManager.default.fileExists(atPath: layout.frameDir("2026-10-11").path))
        #expect(!FileManager.default.fileExists(atPath: layout.keyFile("2026-10-11").path))
        #expect(FileManager.default.fileExists(atPath: layout.frameFile("2026-10-20", keep).path))
        let line = try #require(try purgeLog(home).first)
        #expect(line["frames"] as? Int == 2)
    }

    @Test func aDayWithOnlyFramesIsAStoredDayAndIsPurged() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let layout = StoreLayout(home: home)
        _ = try put(home, at: now.addingTimeInterval(-8 * 86_400))
        // Drop the key to simulate a frames-only folder (e.g. key purged earlier by a crash midway).
        try FileManager.default.removeItem(at: layout.keyFile("2026-10-12"))
        #expect(Retention(layout: layout, days: s11UTC).storedDays() == ["2026-10-12"])
        let records = Retention(layout: layout, days: s11UTC).purge(now: now)
        #expect(records.map(\.day) == ["2026-10-12"])
        #expect(!FileManager.default.fileExists(atPath: layout.frameDir("2026-10-12").path))
    }

    @Test func purgeLinesWithoutFramesAreUnchanged() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let layout = StoreLayout(home: home)
        let old = now.addingTimeInterval(-9 * 86_400)
        try DayStore(layout: layout, plain: true, days: s11UTC).append(Event(id: ids.next(millis: epochMillis(old)), ts: epochMillis(old), kind: .focus))
        _ = Retention(layout: layout, days: s11UTC).purge(now: now)
        let line = try #require(try purgeLog(home).first)
        #expect(Set(line.keys) == ["day", "deletedAt", "events"])
    }

    @Test func exportFrameWritesOnlyTheDecryptedJPEGBytes() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let id = try put(home, at: now)
        let r = cli(["export-frame", id], home: home, now: now)
        #expect(r.code == 0)
        #expect(r.out.isEmpty)
        #expect(r.bytes == Data("jpeg-bytes-\(id)".utf8))
    }

    @Test func listFramesPrintsTheIndex() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let a = try put(home, at: now)
        let b = try put(home, at: now.addingTimeInterval(30))
        let r = cli(["list-frames", "2026-10-20"], home: home, now: now)
        #expect(r.code == 0)
        #expect(r.out.count == 2)
        #expect(r.out[0].contains("\"frameId\":\"\(a)\""))
        #expect(r.out[1].contains("\"frameId\":\"\(b)\""))
        #expect(cli(["list-frames", "2026-10-19"], home: home, now: now).out.isEmpty)
    }

    @Test func exitCodes() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        #expect(cli(["export-frame", "nope"], home: home, now: now).code == 2)
        #expect(cli(["export-frame"], home: home, now: now).code == 2)
        #expect(cli(["list-frames", "2026-13-99"], home: home, now: now).code == 2)
        #expect(cli(["export-frame", "01ARZ3NDEKTSV4RRFFQ69G5FAV"], home: home, now: now).code == 1)
        let old = try put(home, at: now.addingTimeInterval(-9 * 86_400))
        let r = cli(["export-frame", old], home: home, now: now)
        #expect(r.code == 3)
        #expect(r.bytes.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: StoreLayout(home: home).frameDir("2026-10-11").path))
        _ = try put(home, at: now.addingTimeInterval(-9 * 86_400))
        #expect(cli(["list-frames", "2026-10-11"], home: home, now: now).code == 3)
        #expect(!FileManager.default.fileExists(atPath: StoreLayout(home: home).frameDir("2026-10-11").path))
    }

    @Test func aDamagedBlobIsAnErrorNotAPartialImage() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let id = try put(home, at: now)
        let file = StoreLayout(home: home).frameFile("2026-10-20", id)
        var raw = try Data(contentsOf: file)
        raw[raw.count - 1] ^= 0xFF
        try raw.write(to: file)
        let r = cli(["export-frame", id], home: home, now: now)
        #expect(r.code == 1)
        #expect(r.bytes.isEmpty)
    }
}
