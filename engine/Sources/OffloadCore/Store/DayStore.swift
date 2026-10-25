import CryptoKit
import Foundation
import Security

/// Where events go. The observer only appends.
public protocol EventSink: AnyObject {
    func append(_ event: Event) throws
}

/// Per-day files under `$OFFLOAD_HOME/days`. Encrypted mode: each line is base64(nonce|ct|tag) with the day's key
/// in `keys/DAY.key` (0600): raw 32 bytes in file key mode, Keychain-wrapped in keychain mode (KeyVault.swift). Plain mode (`OFFLOAD_PLAIN=1`): `DAY.jsonl`, same JSON unencrypted.
public final class DayStore: EventSink {
    public let layout: StoreLayout
    public let plain: Bool
    public let days: DayCalendar
    public let keys: DayKeyVault

    /// `keys` nil = raw key files (file mode), as before s02b.
    public init(layout: StoreLayout, plain: Bool, days: DayCalendar = DayCalendar(), keys: DayKeyVault? = nil) {
        self.layout = layout
        self.plain = plain
        self.days = days
        self.keys = keys ?? DayKeyVault(layout: layout, mode: .file, secrets: nil)
    }

    /// `OFFLOAD_PLAIN=1` selects plain mode.
    public static func plainFromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        env["OFFLOAD_PLAIN"] == "1"
    }

    public func append(_ event: Event) throws {
        let day = days.day(of: Date(timeIntervalSince1970: TimeInterval(event.ts) / 1000))
        let json: Data
        do { json = try event.jsonLine() } catch { throw StoreError.io("encode event \(event.id): \(error)") }
        try layout.ensureDirectories()
        if plain {
            try appendLine(json, to: layout.plainDayFile(day))
        } else {
            let key = try key(for: day, create: true)
            let sealed: Data
            do { sealed = try StoreCrypto.seal(json, key: key) } catch { throw StoreError.io("seal: \(error)") }
            try appendLine(Data(sealed.base64EncodedString().utf8), to: layout.encryptedDayFile(day))
        }
    }

    /// Every event of `day`, from the encrypted file and/or the plain file, in file order (encrypted first).
    public func read(day: String) throws -> [Event] {
        guard StoreLayout.isDayName(day), days.date(ofDay: day) != nil else { throw StoreError.invalidDay(day) }
        let enc = layout.encryptedDayFile(day)
        let txt = layout.plainDayFile(day)
        let fm = FileManager.default
        guard fm.fileExists(atPath: enc.path) || fm.fileExists(atPath: txt.path) else { throw StoreError.notFound(day) }
        var events: [Event] = []
        if fm.fileExists(atPath: enc.path) {
            let key = try key(for: day, create: false)
            for (n, line) in try lines(of: enc).enumerated() {
                guard let sealed = Data(base64Encoded: line) else { throw StoreError.badLine(n + 1) }
                guard let json = StoreCrypto.open(sealed, key: key) else { throw StoreError.decryptFailed(n + 1) }
                do { events.append(try Event.decode(jsonLine: json)) } catch { throw StoreError.badLine(n + 1) }
            }
        }
        if fm.fileExists(atPath: txt.path) {
            for (n, line) in try lines(of: txt).enumerated() {
                do { events.append(try Event.decode(jsonLine: line)) } catch { throw StoreError.badLine(n + 1) }
            }
        }
        return events
    }

    /// Decrypted JSON lines of `day` (what `export-day` prints).
    public func exportLines(day: String) throws -> [String] {
        try read(day: day).map { event in
            do { return String(decoding: try event.jsonLine(), as: UTF8.self) } catch {
                throw StoreError.io("encode event \(event.id): \(error)")
            }
        }
    }

    // MARK: keys

    func key(for day: String, create: Bool) throws -> SymmetricKey {
        try keys.key(for: day, create: create)
    }

    /// Drops cached keys (after a purge deleted key files).
    public func forgetKeys() { keys.forget() }

    // MARK: files

    private func appendLine(_ line: Data, to url: URL) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            guard fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw StoreError.io("create \(url.lastPathComponent)")
            }
        }
        do {
            let handle = try FileHandle(forWritingTo: url)
            do {
                try handle.seekToEnd()
                try handle.write(contentsOf: line + Data("\n".utf8))
            } catch {
                do { try handle.close() } catch { Log.error("store", "close after failed append: \(error)") }
                throw error
            }
            try handle.close()
        } catch {
            throw StoreError.io("append \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    private func lines(of url: URL) throws -> [Data] {
        let data: Data
        do { data = try Data(contentsOf: url) } catch {
            throw StoreError.io("read \(url.lastPathComponent): \(error.localizedDescription)")
        }
        return data.split(separator: UInt8(ascii: "\n")).filter { !$0.isEmpty }.map { Data($0) }
    }
}
