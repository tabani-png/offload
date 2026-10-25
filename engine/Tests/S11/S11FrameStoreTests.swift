import CryptoKit
import Foundation
import Testing
@testable import OffloadCore

@Suite struct S11FrameStoreTests {
    /// 2026-10-20 10:00:00 UTC.
    let now = Date(timeIntervalSince1970: 1_792_490_400)
    let ids = ULIDGenerator()

    func meta(_ ts: Int64, id: String? = nil) -> FrameMeta {
        FrameMeta(frameId: id ?? ids.next(millis: ts), ts: ts, app: "com.google.Chrome", appName: "Google Chrome",
                  host: "app.ledgerly.test", phash: "00ff00ff00ff00ff", width: 800, height: 400, bytes: 4, maskedRegions: 1)
    }

    func store(_ home: URL, mode: KeyMode = .file, secrets: SecretStore? = nil) -> FrameStore {
        let layout = StoreLayout(home: home)
        return FrameStore(layout: layout, days: s11UTC, keys: DayKeyVault(layout: layout, mode: mode, secrets: secrets))
    }

    func jpeg() throws -> Data {
        try KeyframeRenderer.render(ScreenFrame(image: s11Pattern(3), lines: []), masker: Masker(), config: KeyframeConfig()).jpeg
    }

    @Test func cryptoRoundTripWithTheDayKey() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let s = store(home)
        let data = try jpeg()
        let m = meta(epochMillis(now))
        try s.storeFrame(data, meta: m)
        let file = StoreLayout(home: home).frameFile("2026-10-20", m.frameId)
        let raw = try Data(contentsOf: file)
        #expect(raw.count == data.count + 28)
        #expect(raw.range(of: data.prefix(64)) == nil)          // ciphertext, not the JPEG
        #expect(raw.prefix(3) != Data([0xFF, 0xD8, 0xFF]))
        let back = try s.read(m.frameId)
        #expect(back.day == "2026-10-20")
        #expect(back.jpeg == data)
        // Same key as the day's events: the day key file is the only key.
        let key = try DayKeyVault(layout: StoreLayout(home: home), mode: .file, secrets: nil).key(for: "2026-10-20", create: false)
        #expect(FrameStore.openBlob(raw, frameId: m.frameId, key: key) == data)
        #expect(try s.list(day: "2026-10-20") == [m])
    }

    @Test func filesAre0600AndFolders0700() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let m = meta(epochMillis(now))
        try store(home).storeFrame(try jpeg(), meta: m)
        let layout = StoreLayout(home: home)
        func mode(_ u: URL) throws -> Int { (try FileManager.default.attributesOfItem(atPath: u.path)[.posixPermissions] as? Int) ?? -1 }
        #expect(try mode(layout.frameFile("2026-10-20", m.frameId)) == 0o600)
        #expect(try mode(layout.frameIndex("2026-10-20")) == 0o600)
        #expect(try mode(layout.frameDir("2026-10-20")) == 0o700)
        #expect(try mode(layout.framesDir) == 0o700)
    }

    @Test func aBlobRenamedToAnotherIdDoesNotOpen() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let s = store(home)
        let a = meta(epochMillis(now))
        try s.storeFrame(try jpeg(), meta: a)
        let other = ids.next(millis: epochMillis(now) + 5)
        let layout = StoreLayout(home: home)
        try FileManager.default.copyItem(at: layout.frameFile("2026-10-20", a.frameId), to: layout.frameFile("2026-10-20", other))
        #expect(throws: FrameStoreError.decryptFailed(other)) { _ = try s.read(other) }
    }

    @Test func keychainModeRoundTrip() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let secrets = MemorySecretStore()
        let s = store(home, mode: .keychain, secrets: secrets)
        let data = try jpeg()
        let m = meta(epochMillis(now))
        try s.storeFrame(data, meta: m)
        let keyFile = try Data(contentsOf: StoreLayout(home: home).keyFile("2026-10-20"))
        #expect(DayKeyVault.isWrapped(keyFile))
        #expect(try store(home, mode: .keychain, secrets: secrets).read(m.frameId).jpeg == data)
    }

    @Test func plainModeStillEncryptsFrames() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        // The observer passes the same vault in plain mode; frames never get a plain variant.
        let m = meta(epochMillis(now))
        try store(home).storeFrame(try jpeg(), meta: m)
        let names = try FileManager.default.contentsOfDirectory(atPath: StoreLayout(home: home).frameDir("2026-10-20").path)
        #expect(names.sorted() == ["\(m.frameId).enc", "index.jsonl.enc"])
    }

    @Test func invalidIdsAreRefused() throws {
        let home = tempHome()
        defer { try? FileManager.default.removeItem(at: home) }
        #expect(throws: FrameStoreError.invalidFrameID("../../etc")) { try store(home).storeFrame(Data([1]), meta: meta(1, id: "../../etc")) }
        #expect(!FrameStore.isFrameID("01ARZ3NDEKTSV4RRFFQ69G5FA"))   // 25 chars
        #expect(!FrameStore.isFrameID("01ARZ3NDEKTSV4RRFFQ69G5FAU"))  // U is not Crockford
        #expect(FrameStore.isFrameID("01ARZ3NDEKTSV4RRFFQ69G5FAV"))
    }

    /// Cross-language fixture for slices/s11-perception/verify.sh: with S11_FIXTURE_HOME set, writes one frame with
    /// raw file keys and records its id, day and sha256 so the brain can read it back through `export-frame` and
    /// in process.
    @Test func writesTheCrossLanguageFixtureWhenAsked() throws {
        guard let dir = ProcessInfo.processInfo.environment["S11_FIXTURE_HOME"], !dir.isEmpty else { return }
        let home = URL(fileURLWithPath: dir)
        let layout = StoreLayout(home: home)
        let s = FrameStore(layout: layout, days: DayCalendar(), keys: DayKeyVault(layout: layout, mode: .file, secrets: nil))
        let data = try jpeg()
        let ts = epochMillis(Date())
        let m = meta(ts)
        try s.storeFrame(data, meta: m)
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let info = "{\"frameId\":\"\(m.frameId)\",\"day\":\"\(DayCalendar().day(of: Date()))\",\"sha256\":\"\(sha)\",\"bytes\":\(data.count)}\n"
        try Data(info.utf8).write(to: home.appendingPathComponent("fixture.json"))
    }
}
