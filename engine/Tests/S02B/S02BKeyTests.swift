import CryptoKit
import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02BKeyTests {
    let utc = DayCalendar(timeZone: TimeZone(identifier: "UTC")!)
    let ts: Int64 = 1_792_490_400_000  // 2026-10-20 10:00 UTC
    let day = "2026-10-20"

    func event(_ n: Int = 0) -> Event {
        Event(id: "01JKEY\(n)", ts: ts + Int64(n), kind: .focus, app: "com.apple.mail", appName: "Mail", title: "Inbox")
    }

    func keychainStore(_ layout: StoreLayout, _ secrets: SecretStore) -> DayStore {
        DayStore(layout: layout, plain: false, days: utc,
                 keys: DayKeyVault(layout: layout, mode: .keychain, secrets: secrets))
    }

    @Test func modeComesFromTheEnvironmentAndDefaultsToKeychain() {
        #expect(KeyMode.fromEnvironment([:]) == .keychain)
        #expect(KeyMode.fromEnvironment(["OFFLOAD_KEYS": "file"]) == .file)
        #expect(KeyMode.fromEnvironment(["OFFLOAD_KEYS": "keychain"]) == .keychain)
    }

    @Test func keychainModeWritesWrappedDayKeysNotRawOnes() throws {
        let layout = StoreLayout(home: tempHome())
        let secrets = MemorySecretStore()
        try keychainStore(layout, secrets).append(event())
        let file = try Data(contentsOf: layout.keyFile(day))
        #expect(file.count == DayKeyVault.wrappedSize)
        #expect(file.prefix(4) == DayKeyVault.wrappedMagic)
        #expect(DayKeyVault.isWrapped(file))
        let master = try #require(secrets.items[DayKeyVault.masterAccount])
        #expect(master.count == 32)
        let mode = try FileManager.default.attributesOfItem(atPath: layout.keyFile(day).path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func wrappedKeysRoundTripThroughAFreshStore() throws {
        let layout = StoreLayout(home: tempHome())
        let secrets = MemorySecretStore()
        let events = (0..<3).map(event)
        for e in events { try keychainStore(layout, secrets).append(e) }
        #expect(try keychainStore(layout, secrets).read(day: day) == events)
    }

    @Test func aWrappedKeyCannotBeOpenedWithAnotherMasterKey() throws {
        let layout = StoreLayout(home: tempHome())
        try keychainStore(layout, MemorySecretStore()).append(event())
        #expect(throws: StoreError.self) { try keychainStore(layout, MemorySecretStore()).read(day: day) }
    }

    @Test func aWrappedKeyIsBoundToItsDay() throws {
        let layout = StoreLayout(home: tempHome())
        let secrets = MemorySecretStore()
        let store = keychainStore(layout, secrets)
        try store.append(event())
        let other = "2026-10-21"
        try FileManager.default.copyItem(at: layout.keyFile(day), to: layout.keyFile(other))
        let vault = DayKeyVault(layout: layout, mode: .keychain, secrets: secrets)
        #expect(throws: StoreError.badKey(other)) { _ = try vault.key(for: other, create: false) }
    }

    @Test func startMigrationWrapsExistingRawKeysAndKeepsDataReadable() throws {
        let layout = StoreLayout(home: tempHome())
        let events = (0..<2).map(event)
        let fileStore = DayStore(layout: layout, plain: false, days: utc)  // old raw-file mode
        for e in events { try fileStore.append(e) }
        #expect(try Data(contentsOf: layout.keyFile(day)).count == 32)

        let secrets = MemorySecretStore()
        let vault = DayKeyVault(layout: layout, mode: .keychain, secrets: secrets)
        #expect(try vault.migrateRawKeys() == [day])
        #expect(DayKeyVault.isWrapped(try Data(contentsOf: layout.keyFile(day))))
        #expect(try vault.migrateRawKeys().isEmpty)  // idempotent
        #expect(try keychainStore(layout, secrets).read(day: day) == events)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: layout.keysDir.path)
        #expect(leftovers == ["\(day).key"])
    }

    @Test func fileModeNeverTouchesTheSecretStoreAndWritesRawKeys() throws {
        let layout = StoreLayout(home: tempHome())
        let secrets = MemorySecretStore()
        let store = DayStore(layout: layout, plain: false, days: utc,
                             keys: DayKeyVault(layout: layout, mode: .file, secrets: secrets))
        try store.append(event())
        #expect(try Data(contentsOf: layout.keyFile(day)).count == 32)
        #expect(secrets.calls == 0)
        let vault = DayKeyVault(layout: layout, mode: .file, secrets: secrets)
        #expect(try vault.migrateRawKeys().isEmpty)
        #expect(try Data(contentsOf: layout.keyFile(day)).count == 32)
    }

    @Test func fileModeRefusesAWrappedKeyWithAClearError() throws {
        let layout = StoreLayout(home: tempHome())
        try keychainStore(layout, MemorySecretStore()).append(event())
        let fileStore = DayStore(layout: layout, plain: false, days: utc)
        #expect(throws: StoreError.keyWrapped(day)) { try fileStore.read(day: day) }
    }

    @Test func keychainModeStillReadsAnUnmigratedRawKey() throws {
        let layout = StoreLayout(home: tempHome())
        try DayStore(layout: layout, plain: false, days: utc).append(event())
        let secrets = MemorySecretStore()
        #expect(try keychainStore(layout, secrets).read(day: day) == [event()])
        #expect(secrets.items.isEmpty)  // reading a raw key does not create a master key
    }

    @Test func aFailingSecretStoreFailsTheWriteInsteadOfFallingBackToRaw() throws {
        let layout = StoreLayout(home: tempHome())
        let secrets = MemorySecretStore()
        secrets.failure = StoreError.keychain(-25308)
        #expect(throws: StoreError.keychain(-25308)) { try keychainStore(layout, secrets).append(event()) }
        #expect(!FileManager.default.fileExists(atPath: layout.keyFile(day).path))
    }

    @Test func exportDayWorksInBothKeyModes() throws {
        let local = DayCalendar()
        let noon = try #require(local.date(ofDay: day)).addingTimeInterval(12 * 3600)
        let e = Event(id: "01EXP", ts: epochMillis(noon), kind: .focus, app: "com.apple.mail", appName: "Mail")
        let line = String(decoding: try e.jsonLine(), as: UTF8.self)
        for mode in [KeyMode.file, .keychain] {
            let home = tempHome()
            let layout = StoreLayout(home: home)
            let secrets = MemorySecretStore()
            try DayStore(layout: layout, plain: false, days: local,
                         keys: DayKeyVault(layout: layout, mode: mode, secrets: secrets)).append(e)
            var out: [String] = []
            var err: [String] = []
            let env = mode == .file ? ["OFFLOAD_KEYS": "file"] : [:]
            let code = ObserverCLI.runOffline(try ObserverCLI.parse(["export-day", day, "--home", home.path]),
                                              environment: env, now: Date(), days: local, secrets: secrets,
                                              out: { out.append($0) }, err: { err.append($0) })
            #expect(code == 0, "mode \(mode): \(err)")
            #expect(out == [line])
        }
    }

    /// Opt-in: touches the real login Keychain with a throwaway account, then deletes it.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OFFLOAD_LIVE_KEYCHAIN"] == "1"))
    func liveKeychainRoundTrip() throws {
        let store = KeychainSecretStore(service: KeychainSecretStore.defaultService)
        let account = "s02b-live-test-\(UUID().uuidString.prefix(8))"
        defer { try? store.delete(account: account) }
        #expect(try store.read(account: account) == nil)
        let secret = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        try store.write(secret, account: account)
        #expect(try store.read(account: account) == secret)
        let next = Data(repeating: 7, count: 32)
        try store.write(next, account: account)
        #expect(try store.read(account: account) == next)
        try store.delete(account: account)
        #expect(try store.read(account: account) == nil)
    }
}
