import Foundation

public enum LaunchAgentError: Error, Equatable, CustomStringConvertible {
    case relativeExecutable(String)
    case io(String)

    public var description: String {
        switch self {
        case .relativeExecutable(let p): return "executable path must be absolute: \(p)"
        case .io(let m): return m
        }
    }
}

/// `~/Library/LaunchAgents/ai.offload.observer.plist`. This code only writes and removes the file; it never runs
/// launchctl. The user loads it with `launchctl bootstrap gui/$(id -u) <plist>`.
public enum LaunchAgent {
    public static let label = "ai.offload.observer"
    /// Environment keys copied into the plist when set at install time.
    public static let passThroughEnvironment = ["OFFLOAD_KEYS", "OFFLOAD_PLAIN"]

    /// `$OFFLOAD_LAUNCH_AGENTS_DIR` (tests), else `~/Library/LaunchAgents`.
    public static func agentsDir(environment: [String: String]) -> URL {
        if let dir = environment["OFFLOAD_LAUNCH_AGENTS_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: (dir as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    public static func plistURL(agentsDir: URL) -> URL { agentsDir.appendingPathComponent("\(label).plist") }

    /// RunAtLoad; restarted by launchd only after a non-zero exit (crash), at most every 10 s; GUI session only;
    /// stdout/stderr to `$OFFLOAD_HOME/logs`.
    public static func propertyList(executable: String, layout: StoreLayout, environment: [String: String])
        -> [String: Any] {
        var plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [executable, "run", "--home", layout.home.path],
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 10,
            "ProcessType": "Background",
            "LimitLoadToSessionType": "Aqua",
            "StandardOutPath": layout.logsDir.appendingPathComponent("observer.out.log").path,
            "StandardErrorPath": layout.logsDir.appendingPathComponent("observer.err.log").path,
        ]
        let env = environment.filter { passThroughEnvironment.contains($0.key) && !$0.value.isEmpty }
        if !env.isEmpty { plist["EnvironmentVariables"] = env }
        return plist
    }

    /// Writes the plist (0644) and creates the logs dir (0700). Returns the plist path.
    @discardableResult
    public static func install(executable: String, layout: StoreLayout, agentsDir: URL,
                               environment: [String: String]) throws -> URL {
        guard executable.hasPrefix("/") else { throw LaunchAgentError.relativeExecutable(executable) }
        let fm = FileManager.default
        do {
            try layout.ensureDirectories()
            try fm.createDirectory(at: layout.logsDir, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            try fm.createDirectory(at: agentsDir, withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(
                fromPropertyList: propertyList(executable: executable, layout: layout, environment: environment),
                format: .xml, options: 0)
            let url = plistURL(agentsDir: agentsDir)
            try data.write(to: url, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
            return url
        } catch let e as LaunchAgentError { throw e } catch let e as StoreError {
            throw LaunchAgentError.io("\(e)")
        } catch {
            throw LaunchAgentError.io("write launch agent: \(error.localizedDescription)")
        }
    }

    /// Removes the plist. Returns false when there was none.
    @discardableResult
    public static func uninstall(agentsDir: URL) throws -> Bool {
        let url = plistURL(agentsDir: agentsDir)
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        do { try FileManager.default.removeItem(at: url) } catch {
            throw LaunchAgentError.io("remove launch agent: \(error.localizedDescription)")
        }
        return true
    }
}
