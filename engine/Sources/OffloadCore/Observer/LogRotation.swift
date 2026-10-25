import Foundation

/// Rotation of the observer's LaunchAgent logs (`$OFFLOAD_HOME/logs/observer.{out,err}.log`, REVIEW-2 privacy table).
/// A file at or over `maxBytes` (5 MB) is copied to `NAME.1` (older copies shift to `NAME.2`; `keep` = 2 old files
/// are kept, the oldest is deleted) and then emptied IN PLACE. launchd keeps the file open with O_APPEND, so after
/// the truncation its writes land at the start of the same file; renaming it would leave launchd writing to the
/// old copy. Lines written between the copy and the truncation can be lost; that is the price of not owning the fd.
public struct LogRotation: Sendable {
    public static let defaultMaxBytes: UInt64 = 5 * 1024 * 1024
    public static let defaultKeep = 2
    public static let defaultNames = ["observer.out.log", "observer.err.log"]

    public let directory: URL
    public let maxBytes: UInt64
    public let keep: Int
    public let names: [String]

    public init(directory: URL, maxBytes: UInt64 = LogRotation.defaultMaxBytes, keep: Int = LogRotation.defaultKeep,
                names: [String] = LogRotation.defaultNames) {
        self.directory = directory
        self.maxBytes = maxBytes
        self.keep = max(1, keep)
        self.names = names
    }

    public init(layout: StoreLayout) { self.init(directory: layout.logsDir) }

    /// Rotates every log at or over the limit. Returns the names rotated. Failures are logged, never thrown.
    @discardableResult
    public func rotateIfNeeded() -> [String] {
        let fm = FileManager.default
        var rotated: [String] = []
        for name in names {
            let url = directory.appendingPathComponent(name)
            guard let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber,
                  size.uint64Value >= maxBytes else { continue }
            func old(_ i: Int) -> URL { directory.appendingPathComponent("\(name).\(i)") }
            do {
                if fm.fileExists(atPath: old(keep).path) { try fm.removeItem(at: old(keep)) }
                for i in stride(from: keep - 1, through: 1, by: -1) where fm.fileExists(atPath: old(i).path) {
                    try fm.moveItem(at: old(i), to: old(i + 1))
                }
                try fm.copyItem(at: url, to: old(1))
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: old(1).path)
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.truncate(atOffset: 0)
                rotated.append(name)
            } catch {
                Log.error("logs", "rotate \(name): \(Log.describe(error))")
            }
        }
        return rotated
    }
}
