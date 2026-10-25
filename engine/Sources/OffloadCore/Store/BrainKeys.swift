import Foundation

/// Brain keys (REVIEW-1 H4): 32-byte keys the brain uses for its own sealed files, kept in
/// `$OFFLOAD_HOME/keys/brain-NAME.key` in the same OKW1 format as day keys (64 bytes, "OKW1" | AES-GCM(nonce 12 |
/// key 32 | tag 16)) under the Keychain master key, with `ai.offload.observer/brain-key/v1/NAME` as associated data
/// (a file copied to another name fails to open). A stored key is never replaced. Keychain mode only.
/// Nothing here logs or formats key bytes.
public struct BrainKeys {
    public let layout: StoreLayout
    private let vault: DayKeyVault

    public init(layout: StoreLayout, secrets: SecretStore?) {
        self.layout = layout
        self.vault = DayKeyVault(layout: layout, mode: .keychain, secrets: secrets)
    }

    /// 1-32 chars of `a-z 0-9 -`, starting with a letter or digit (safe as a file name part).
    public static func isValidName(_ name: String) -> Bool {
        guard (1...32).contains(name.count), let first = name.first, first != "-" else { return false }
        return name.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    private static func associatedData(_ name: String) -> Data { Data("ai.offload.observer/brain-key/v1/\(name)".utf8) }

    /// Stores `key` (nil = a new random key) and returns the key now stored. When a key is already stored for `name`,
    /// returns it if `key` is nil or equal, else throws `brainKeyConflict` and leaves the file alone.
    public func wrap(name: String, key: Data?) throws -> Data {
        guard Self.isValidName(name) else { throw StoreError.io("invalid brain key name") }
        if let key, key.count != StoreCrypto.keySize { throw StoreError.io("brain key must be \(StoreCrypto.keySize) bytes") }
        let url = layout.brainKeyFile(name)
        if FileManager.default.fileExists(atPath: url.path) { return try existing(name: name, matching: key) }
        try layout.ensureDirectories()
        let raw = try key ?? DayKeyVault.randomKeyData()
        let sealed = try vault.seal(raw, associatedData: Self.associatedData(name), label: url.lastPathComponent)
        let tmp = layout.keysDir.appendingPathComponent(".brain-\(name).key.\(UUID().uuidString.prefix(8)).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: sealed, attributes: [.posixPermissions: 0o600])
        else { throw StoreError.io("create temp file for \(url.lastPathComponent)") }
        defer { unlink(tmp.path) }
        // link() never overwrites: if another wrap-key won the race, compare against what it stored.
        if link(tmp.path, url.path) != 0 {
            let code = errno
            guard code == EEXIST else { throw StoreError.io("store \(url.lastPathComponent): errno \(code)") }
            return try existing(name: name, matching: raw)
        }
        return raw
    }

    /// The stored key for `name`. Never creates a master key.
    public func unwrap(name: String) throws -> Data {
        guard Self.isValidName(name) else { throw StoreError.io("invalid brain key name") }
        let url = layout.brainKeyFile(name)
        guard FileManager.default.fileExists(atPath: url.path) else { throw StoreError.brainKeyMissing(url.lastPathComponent) }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw StoreError.io("read \(url.lastPathComponent)") }
        return try vault.open(data, associatedData: Self.associatedData(name),
                              failure: StoreError.brainKeyBad(url.lastPathComponent))
    }

    private func existing(name: String, matching key: Data?) throws -> Data {
        let stored = try unwrap(name: name)
        if let key, key != stored { throw StoreError.brainKeyConflict(layout.brainKeyFile(name).lastPathComponent) }
        return stored
    }

    /// A one-line reason for stderr. Carries file names and status codes only, never key bytes.
    public static func describe(_ error: Error) -> String {
        switch error as? StoreError {
        case .brainKeyMissing(let f)?: return "no key in keys/\(f)"
        case .brainKeyConflict(let f)?: return "keys/\(f) already holds a different key; it is never replaced"
        case .brainKeyBad(let f)?: return "keys/\(f) cannot be opened with this Keychain master key and name"
        case .masterKeyMissing?: return "the Keychain master key is missing"
        case .keychain(let status)?: return "Keychain error \(status)"
        case .io(let m)?: return m
        default: return "failed"
        }
    }
}
