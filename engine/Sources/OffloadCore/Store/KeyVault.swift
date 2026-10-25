import CryptoKit
import Foundation
import Security

/// How day keys are kept on disk. `keychain` (default): `keys/DAY.key` holds the day key wrapped (AES-GCM) with a
/// 32-byte master key in the login Keychain. `file` (`OFFLOAD_KEYS=file`): the old raw 32-byte key files, for tests
/// and fixtures; never touches the Keychain.
public enum KeyMode: String, Codable, Sendable {
    case keychain
    case file

    public static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> KeyMode {
        env["OFFLOAD_KEYS"] == "file" ? .file : .keychain
    }
}

/// Small secrets by account name. The live one is the login Keychain; tests use `MemorySecretStore`.
public protocol SecretStore: AnyObject {
    /// Nil when there is no item for `account`.
    func read(account: String) throws -> Data?
    /// Creates or replaces the item.
    func write(_ data: Data, account: String) throws
    /// No error when the item is absent.
    func delete(account: String) throws
}

/// In-memory secret store for tests and fixtures. `failure` makes every call throw; `calls` counts calls.
public final class MemorySecretStore: SecretStore {
    public var items: [String: Data] = [:]
    public var failure: Error?
    public private(set) var calls = 0

    public init() {}

    public func read(account: String) throws -> Data? {
        calls += 1
        if let failure { throw failure }
        return items[account]
    }

    public func write(_ data: Data, account: String) throws {
        calls += 1
        if let failure { throw failure }
        items[account] = data
    }

    public func delete(account: String) throws {
        calls += 1
        if let failure { throw failure }
        items[account] = nil
    }
}

/// Generic-password items in the login Keychain, service `ai.offload.observer`, readable after first unlock and
/// never synced or migrated to another device.
public final class KeychainSecretStore: SecretStore {
    public static let defaultService = "ai.offload.observer"
    public let service: String

    public init(service: String = KeychainSecretStore.defaultService) {
        self.service = service
    }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func read(account: String) throws -> Data? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
        guard let data = item as? Data else { throw StoreError.keychain(errSecDecode) }
        return data
    }

    public func write(_ data: Data, account: String) throws {
        let update = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw StoreError.keychain(update) }
        var add = base(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        add[kSecAttrLabel as String] = "Offload observer (\(account))"
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(base(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.keychain(status) }
    }
}

/// Day keys for DayStore. Wrapped key file = "OKW1" | AES-GCM combined(nonce 12 | wrapped key 32 | tag 16), 64 bytes,
/// sealed with the master key and the day name as associated data (a key file copied to another day fails to open).
public final class DayKeyVault {
    public static let masterAccount = "master-key"
    public static let wrappedMagic = Data("OKW1".utf8)
    public static let wrappedSize = 4 + StoreCrypto.nonceSize + StoreCrypto.keySize + StoreCrypto.tagSize

    public let layout: StoreLayout
    public let mode: KeyMode
    private let secrets: SecretStore?
    private var cache: [String: SymmetricKey] = [:]
    private var master: SymmetricKey?

    public init(layout: StoreLayout, mode: KeyMode, secrets: SecretStore?) {
        self.layout = layout
        self.mode = mode
        self.secrets = secrets
    }

    public static func isWrapped(_ data: Data) -> Bool {
        data.count == wrappedSize && data.prefix(wrappedMagic.count) == wrappedMagic
    }

    private static func associatedData(_ day: String) -> Data { Data("ai.offload.observer/day-key/v1/\(day)".utf8) }

    /// The day's key; with `create`, a new random key is made (and wrapped in keychain mode) when none exists.
    public func key(for day: String, create: Bool) throws -> SymmetricKey {
        if let k = cache[day] { return k }
        let url = layout.keyFile(day)
        if FileManager.default.fileExists(atPath: url.path) {
            let data: Data
            do { data = try Data(contentsOf: url) } catch { throw StoreError.keyMissing(day) }
            let raw: Data
            if data.count == StoreCrypto.keySize {
                raw = data  // raw (file mode, or keychain mode before migration)
            } else if Self.isWrapped(data) {
                guard mode == .keychain else { throw StoreError.keyWrapped(day) }
                raw = try unwrap(data, day: day)
            } else {
                throw StoreError.badKey(day)
            }
            let key = SymmetricKey(data: raw)
            cache[day] = key
            return key
        }
        guard create else { throw StoreError.keyMissing(day) }
        let raw = try Self.randomKey()
        let body = mode == .keychain ? try wrap(raw, day: day) : raw
        guard FileManager.default.createFile(atPath: url.path, contents: body, attributes: [.posixPermissions: 0o600])
        else { throw StoreError.io("create key file for \(day)") }
        let key = SymmetricKey(data: raw)
        cache[day] = key
        return key
    }

    /// Keychain mode: rewrites every raw key file as a wrapped one (atomic rename, 0600). Returns the days migrated.
    /// File mode: does nothing.
    @discardableResult
    public func migrateRawKeys() throws -> [String] {
        guard mode == .keychain else { return [] }
        let fm = FileManager.default
        guard fm.fileExists(atPath: layout.keysDir.path) else { return [] }
        let names: [String]
        do { names = try fm.contentsOfDirectory(atPath: layout.keysDir.path) } catch {
            throw StoreError.io("list keys: \(error.localizedDescription)")
        }
        var migrated: [String] = []
        for name in names.sorted() where name.hasSuffix(".key") {
            let day = String(name.dropLast(4))
            guard StoreLayout.isDayName(day) else { continue }
            let url = layout.keyFile(day)
            let data: Data
            do { data = try Data(contentsOf: url) } catch { throw StoreError.keyMissing(day) }
            guard data.count == StoreCrypto.keySize else { continue }
            let wrapped = try wrap(data, day: day)
            let tmp = layout.keysDir.appendingPathComponent(".\(day).key.tmp")
            try? fm.removeItem(at: tmp)
            guard fm.createFile(atPath: tmp.path, contents: wrapped, attributes: [.posixPermissions: 0o600]) else {
                throw StoreError.io("create temp key for \(day)")
            }
            guard rename(tmp.path, url.path) == 0 else {
                let code = errno
                try? fm.removeItem(at: tmp)
                throw StoreError.io("rename key for \(day): errno \(code)")
            }
            migrated.append(day)
        }
        return migrated
    }

    /// Gets (or, with `create`, makes and stores) the master key. Keychain mode only.
    public func masterKey(create: Bool) throws -> SymmetricKey {
        if let master { return master }
        guard mode == .keychain else { throw StoreError.io("master key requested in file key mode") }
        guard let secrets else { throw StoreError.masterKeyMissing }
        if let data = try secrets.read(account: Self.masterAccount) {
            guard data.count == StoreCrypto.keySize else { throw StoreError.masterKeyMissing }
            let key = SymmetricKey(data: data)
            master = key
            return key
        }
        guard create else { throw StoreError.masterKeyMissing }
        let data = try Self.randomKey()
        try secrets.write(data, account: Self.masterAccount)
        let key = SymmetricKey(data: data)
        master = key
        return key
    }

    func wrap(_ raw: Data, day: String) throws -> Data {
        try seal(raw, associatedData: Self.associatedData(day), label: day)
    }

    func unwrap(_ file: Data, day: String) throws -> Data {
        try open(file, associatedData: Self.associatedData(day), failure: StoreError.badKey(day))
    }

    /// OKW1 | AES-GCM(master, raw, associatedData). Creates the master key when missing.
    func seal(_ raw: Data, associatedData: Data, label: String) throws -> Data {
        let master = try masterKey(create: true)
        do {
            let box = try AES.GCM.seal(raw, using: master, authenticating: associatedData)
            guard let combined = box.combined else { throw StoreError.io("wrap \(label)") }
            return Self.wrappedMagic + combined
        } catch let e as StoreError { throw e } catch { throw StoreError.io("wrap \(label): \(error)") }
    }

    /// Opens an OKW1 file; any failure after the master key is found becomes `failure`. Never creates a master key.
    func open(_ file: Data, associatedData: Data, failure: StoreError) throws -> Data {
        guard Self.isWrapped(file) else { throw failure }
        let master = try masterKey(create: false)
        do {
            let box = try AES.GCM.SealedBox(combined: file.dropFirst(Self.wrappedMagic.count))
            let raw = try AES.GCM.open(box, using: master, authenticating: associatedData)
            guard raw.count == StoreCrypto.keySize else { throw failure }
            return raw
        } catch let e as StoreError { throw e } catch { throw failure }
    }

    static func randomKeyData() throws -> Data { try randomKey() }

    /// Raw and wrapped key files on disk (for `status`).
    public static func keyFileCounts(layout: StoreLayout) -> (raw: Int, wrapped: Int) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: layout.keysDir.path) else { return (0, 0) }
        var raw = 0
        var wrapped = 0
        for name in names where name.hasSuffix(".key") && StoreLayout.isDayName(String(name.dropLast(4))) {
            guard let data = try? Data(contentsOf: layout.keysDir.appendingPathComponent(name)) else { continue }
            if data.count == StoreCrypto.keySize { raw += 1 } else if isWrapped(data) { wrapped += 1 }
        }
        return (raw, wrapped)
    }

    /// Drops cached keys (after a purge deleted key files). The master key stays cached.
    public func forget() { cache.removeAll() }

    private static func randomKey() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: StoreCrypto.keySize)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw StoreError.io("SecRandomCopyBytes status \(status)") }
        return Data(bytes)
    }
}
