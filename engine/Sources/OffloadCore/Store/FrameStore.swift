// Encrypted keyframe store (s11, docs/store-contract.md "Keyframes", SPEC K4):
//   frames/YYYY-MM-DD/<frameId>.enc   AES-256-GCM nonce(12) | ciphertext | tag(16) of the JPEG, DAY KEY of that day,
//                                     associated data "offload/frame/v1/<frameId>" (a renamed blob does not open)
//   frames/YYYY-MM-DD/index.jsonl.enc one base64 sealed line per frame (day-file line format): FrameMeta JSON
// Frames are always encrypted, also in OFFLOAD_PLAIN=1 mode. Dirs 0700, files 0600.
import CryptoKit
import Foundation

/// One index line. Field names are the brain's FrameRef (brain/src/vision/types.ts), minus `day` (the folder).
public struct FrameMeta: Codable, Equatable, Sendable {
    public var frameId: String
    public var ts: Int64
    public var app: String?
    public var appName: String?
    public var host: String?
    /// 64-bit dHash, 16 hex chars.
    public var phash: String
    public var width: Int
    public var height: Int
    public var bytes: Int
    public var maskedRegions: Int

    public init(frameId: String, ts: Int64, app: String?, appName: String?, host: String?, phash: String, width: Int,
                height: Int, bytes: Int, maskedRegions: Int) {
        self.frameId = frameId
        self.ts = ts
        self.app = app
        self.appName = appName
        self.host = host
        self.phash = phash
        self.width = width
        self.height = height
        self.bytes = bytes
        self.maskedRegions = maskedRegions
    }

    public func jsonLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

/// Where kept keyframes go.
public protocol FrameSink: AnyObject {
    func storeFrame(_ jpeg: Data, meta: FrameMeta) throws
}

public enum FrameStoreError: Error, Equatable {
    case invalidFrameID(String)
    case notFound(String)
    /// The blob does not open with its day key and id (tampered, renamed, or the key is gone).
    case decryptFailed(String)
}

public final class FrameStore: FrameSink {
    public let layout: StoreLayout
    public let days: DayCalendar
    public let keys: DayKeyVault

    public init(layout: StoreLayout, days: DayCalendar = DayCalendar(), keys: DayKeyVault) {
        self.layout = layout
        self.days = days
        self.keys = keys
    }

    private static let crockford = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// A ULID: 26 Crockford base32 characters (upper case).
    public static func isFrameID(_ s: String) -> Bool { s.count == 26 && s.allSatisfy { crockford.contains($0) } }

    public static func associatedData(_ frameId: String) -> Data { Data("offload/frame/v1/\(frameId)".utf8) }

    /// Seals a JPEG for `frameId` (AES-256-GCM, combined form) with the given day key.
    public static func sealBlob(_ jpeg: Data, frameId: String, key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(jpeg, using: key, authenticating: associatedData(frameId))
        guard let combined = box.combined else { throw CryptoKitError.incorrectParameterSize }
        return combined
    }

    public static func openBlob(_ sealed: Data, frameId: String, key: SymmetricKey) -> Data? {
        guard sealed.count >= StoreCrypto.nonceSize + StoreCrypto.tagSize,
              let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
        return try? AES.GCM.open(box, using: key, authenticating: associatedData(frameId))
    }

    // MARK: write

    public func storeFrame(_ jpeg: Data, meta: FrameMeta) throws {
        guard Self.isFrameID(meta.frameId) else { throw FrameStoreError.invalidFrameID(meta.frameId) }
        let day = days.day(of: Date(timeIntervalSince1970: TimeInterval(meta.ts) / 1000))
        try layout.ensureDirectories()
        let dir = layout.frameDir(day)
        for d in [layout.framesDir, dir] {
            do {
                try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            } catch {
                throw StoreError.io("create \(d.lastPathComponent): \(error.localizedDescription)")
            }
        }
        let key = try keys.key(for: day, create: true)
        let blob: Data
        let line: Data
        do {
            blob = try Self.sealBlob(jpeg, frameId: meta.frameId, key: key)
            line = Data(try StoreCrypto.seal(try meta.jsonLine(), key: key).base64EncodedString().utf8)
        } catch {
            throw StoreError.io("seal frame: \(Log.describe(error))")
        }
        try writeAtomic(blob, to: layout.frameFile(day, meta.frameId))
        try appendLine(line, to: layout.frameIndex(day))
    }

    // MARK: read

    /// Days with a frames folder, sorted.
    public func frameDays() -> [String] {
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: layout.framesDir.path)) ?? []
        return entries.filter(StoreLayout.isDayName).sorted()
    }

    /// The decrypted index of `day`, in file order. Missing day = empty.
    public func list(day: String) throws -> [FrameMeta] {
        guard StoreLayout.isDayName(day), days.date(ofDay: day) != nil else { throw StoreError.invalidDay(day) }
        let url = layout.frameIndex(day)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let key = try keys.key(for: day, create: false)
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw StoreError.io("read frame index: \(error.localizedDescription)") }
        var out: [FrameMeta] = []
        for (n, raw) in data.split(separator: UInt8(ascii: "\n")).enumerated() where !raw.isEmpty {
            guard let sealed = Data(base64Encoded: Data(raw)) else { throw StoreError.badLine(n + 1) }
            guard let json = StoreCrypto.open(sealed, key: key) else { throw StoreError.decryptFailed(n + 1) }
            do { out.append(try JSONDecoder().decode(FrameMeta.self, from: json)) } catch { throw StoreError.badLine(n + 1) }
        }
        return out
    }

    /// The day folder that holds `frameId`, or nil.
    public func locate(_ frameId: String) -> String? {
        guard Self.isFrameID(frameId) else { return nil }
        return frameDays().first { FileManager.default.fileExists(atPath: layout.frameFile($0, frameId).path) }
    }

    /// The decrypted JPEG of `frameId` and its day.
    public func read(_ frameId: String) throws -> (day: String, jpeg: Data) {
        guard Self.isFrameID(frameId) else { throw FrameStoreError.invalidFrameID(frameId) }
        guard let day = locate(frameId) else { throw FrameStoreError.notFound(frameId) }
        let key = try keys.key(for: day, create: false)
        let sealed: Data
        do { sealed = try Data(contentsOf: layout.frameFile(day, frameId)) } catch { throw FrameStoreError.notFound(frameId) }
        guard let jpeg = Self.openBlob(sealed, frameId: frameId, key: key) else { throw FrameStoreError.decryptFailed(frameId) }
        return (day, jpeg)
    }

    /// Number of frame blobs in a day folder.
    public func blobCount(day: String) -> Int {
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: layout.frameDir(day).path)) ?? []
        return entries.filter { $0.hasSuffix(".enc") && $0 != "index.jsonl.enc" }.count
    }

    // MARK: files

    private func writeAtomic(_ data: Data, to url: URL) throws {
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).tmp")
        let fm = FileManager.default
        if fm.fileExists(atPath: tmp.path) { try? fm.removeItem(at: tmp) }
        guard fm.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw StoreError.io("create \(tmp.lastPathComponent)")
        }
        if rename(tmp.path, url.path) != 0 {
            try? fm.removeItem(at: tmp)
            throw StoreError.io("rename \(url.lastPathComponent): errno \(errno)")
        }
    }

    private func appendLine(_ line: Data, to url: URL) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            guard fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw StoreError.io("create \(url.lastPathComponent)")
            }
        }
        do {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line + Data("\n".utf8))
        } catch {
            throw StoreError.io("append \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }
}
