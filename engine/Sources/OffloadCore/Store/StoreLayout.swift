import Foundation

/// Paths under `$OFFLOAD_HOME` (docs/store-contract.md).
public struct StoreLayout: Sendable {
    public let home: URL

    public init(home: URL) {
        self.home = home
    }

    /// `--home`, else `$OFFLOAD_HOME`, else `~/Library/Application Support/Offload`.
    public static func resolveHome(flag: String?, environment: [String: String] = ProcessInfo.processInfo.environment)
        -> URL {
        if let flag, !flag.isEmpty { return URL(fileURLWithPath: (flag as NSString).expandingTildeInPath) }
        if let env = environment["OFFLOAD_HOME"], !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath)
        }
        let base = FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("Library/Application Support/Offload", isDirectory: true)
    }

    public var daysDir: URL { home.appendingPathComponent("days", isDirectory: true) }
    public var keysDir: URL { home.appendingPathComponent("keys", isDirectory: true) }
    public var purgeLog: URL { home.appendingPathComponent("purge-log.jsonl") }
    /// Present = paused. Written by `offload-observer pause`, removed by `resume`.
    public var pauseFile: URL { home.appendingPathComponent("paused") }
    /// Heartbeat the running observer rewrites every tick; `status` reads it.
    public var statusFile: URL { home.appendingPathComponent("observer-status.json") }
    /// User-editable exclusions {bundleIds, hosts, titleContains}, merged with the built-ins.
    public var exclusionsFile: URL { home.appendingPathComponent("exclusions.json") }
    /// LaunchAgent stdout/stderr.
    public var logsDir: URL { home.appendingPathComponent("logs", isDirectory: true) }

    /// Keyframes (s11): `frames/DAY/<frameId>.enc` + `frames/DAY/index.jsonl.enc`, purged with the day.
    public var framesDir: URL { home.appendingPathComponent("frames", isDirectory: true) }
    public func frameDir(_ day: String) -> URL { framesDir.appendingPathComponent(day, isDirectory: true) }
    public func frameFile(_ day: String, _ frameId: String) -> URL { frameDir(day).appendingPathComponent("\(frameId).enc") }
    public func frameIndex(_ day: String) -> URL { frameDir(day).appendingPathComponent("index.jsonl.enc") }

    public func encryptedDayFile(_ day: String) -> URL { daysDir.appendingPathComponent("\(day).jsonl.enc") }
    public func plainDayFile(_ day: String) -> URL { daysDir.appendingPathComponent("\(day).jsonl") }
    public func keyFile(_ day: String) -> URL { keysDir.appendingPathComponent("\(day).key") }
    /// Keychain-wrapped brain key `keys/brain-NAME.key` (`offload-observer wrap-key`). Not a day key: migration and
    /// the day counts ignore it. Retention deletes it when NAME is a date past the retention window (REVIEW-2 N4).
    public func brainKeyFile(_ name: String) -> URL { keysDir.appendingPathComponent("brain-\(name).key") }

    /// Creates home, days and keys with mode 0700.
    public func ensureDirectories() throws {
        for dir in [home, daysDir, keysDir] {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            } catch {
                throw StoreError.io("create \(dir.lastPathComponent): \(error.localizedDescription)")
            }
        }
    }

    /// True for `YYYY-MM-DD` with digits in the right places.
    public static func isDayName(_ s: String) -> Bool {
        let chars = Array(s)
        guard chars.count == 10, chars[4] == "-", chars[7] == "-" else { return false }
        return chars.enumerated().allSatisfy { i, c in i == 4 || i == 7 || c.isASCII && c.isNumber }
    }
}
