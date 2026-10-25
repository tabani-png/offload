import Foundation

/// Parsed `offload-observer` arguments.
public enum ObserverCommand: Equatable, Sendable {
    case run
    case status
    case pause
    case resume
    case purgeNow
    case exportDay(String)
    case exclude(ExcludeAction)
    case installAgent
    case uninstallAgent
    case help
}

public enum ExcludeAction: Equatable, Sendable {
    case list
    case add(ExclusionKind, String)
    case remove(ExclusionKind, String)
}

public struct ParsedArguments: Equatable, Sendable {
    public var command: ObserverCommand
    public var home: String?
}

public enum ArgumentError: Error, Equatable, CustomStringConvertible {
    case unknownCommand(String)
    case missingValue(String)
    case unexpected(String)

    public var description: String {
        switch self {
        case .unknownCommand(let c): return "unknown command '\(c)'"
        case .missingValue(let f): return "\(f) needs a value"
        case .unexpected(let a): return "unexpected argument '\(a)'"
        }
    }
}

public enum ObserverCLI {
    public static let usage = """
    usage: offload-observer <command> [--home DIR]
      run                  record events until stopped (Ctrl-C / SIGTERM)
      status [--json]      print observer state as JSON (schemaVersion 1)
      pause | resume       stop / restart recording (the running observer notices within 1 s)
      purge-now            delete days older than 7 local days now
      export-day YYYY-MM-DD  print that day's decrypted events as JSON lines
      exclude list         print exclusions.json (your entries; built-ins always apply too)
      exclude add|remove --app BUNDLE_ID | --host HOST | --title TEXT
      install-agent        write ~/Library/LaunchAgents/ai.offload.observer.plist (does not load it)
      uninstall-agent      remove that plist
    env: OFFLOAD_HOME (default ~/Library/Application Support/Offload), OFFLOAD_PLAIN=1 (write plain jsonl),
         OFFLOAD_KEYS=file (raw day-key files instead of Keychain-wrapped ones)
    """

    public static func parse(_ args: [String]) throws -> ParsedArguments {
        var home: String?
        var rest: [String] = []
        var i = 0
        while i < args.count {
            let a = args[i]
            if a == "--home" {
                guard i + 1 < args.count else { throw ArgumentError.missingValue("--home") }
                home = args[i + 1]
                i += 2
                continue
            }
            if a.hasPrefix("--home=") {
                home = String(a.dropFirst("--home=".count))
                i += 1
                continue
            }
            rest.append(a)
            i += 1
        }
        guard let first = rest.first else { return ParsedArguments(command: .help, home: home) }
        let extra = rest.dropFirst()
        func noExtra(_ c: ObserverCommand) throws -> ParsedArguments {
            if let x = extra.first { throw ArgumentError.unexpected(x) }
            return ParsedArguments(command: c, home: home)
        }
        switch first {
        case "run": return try noExtra(.run)
        case "status":
            if let x = extra.first(where: { $0 != "--json" }) { throw ArgumentError.unexpected(x) }
            return ParsedArguments(command: .status, home: home)
        case "install-agent": return try noExtra(.installAgent)
        case "uninstall-agent": return try noExtra(.uninstallAgent)
        case "exclude": return ParsedArguments(command: .exclude(try parseExclude(Array(extra))), home: home)
        case "pause": return try noExtra(.pause)
        case "resume": return try noExtra(.resume)
        case "purge-now": return try noExtra(.purgeNow)
        case "help", "-h", "--help": return try noExtra(.help)
        case "export-day":
            guard let day = extra.first else { throw ArgumentError.missingValue("export-day") }
            if extra.count > 1 { throw ArgumentError.unexpected(extra[extra.startIndex + 1]) }
            return ParsedArguments(command: .exportDay(day), home: home)
        default: throw ArgumentError.unknownCommand(first)
        }
    }

    static func parseExclude(_ args: [String]) throws -> ExcludeAction {
        guard let verb = args.first else { throw ArgumentError.missingValue("exclude") }
        let rest = Array(args.dropFirst())
        if verb == "list" {
            if let x = rest.first { throw ArgumentError.unexpected(x) }
            return .list
        }
        guard verb == "add" || verb == "remove" else { throw ArgumentError.unknownCommand("exclude \(verb)") }
        let flags: [(String, ExclusionKind)] = [("--app", .app), ("--host", .host), ("--title", .title)]
        guard let flag = rest.first else { throw ArgumentError.missingValue("exclude \(verb) --app|--host|--title") }
        var kind: ExclusionKind?
        var value: String?
        var used = 1
        for (name, k) in flags {
            if flag == name {
                kind = k
                guard rest.count > 1 else { throw ArgumentError.missingValue(name) }
                value = rest[1]
                used = 2
            } else if flag.hasPrefix(name + "=") {
                kind = k
                value = String(flag.dropFirst(name.count + 1))
            }
        }
        guard let kind, let value else { throw ArgumentError.unexpected(flag) }
        if rest.count > used { throw ArgumentError.unexpected(rest[used]) }
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ArgumentError.missingValue("--\(kind.rawValue)")
        }
        return verb == "add" ? .add(kind, value) : .remove(kind, value)
    }

    /// Runs every command except `run` (which needs the live glue). Returns the exit code.
    /// `secrets`: the Keychain in the binary; tests pass a MemorySecretStore. `permissions`: this process's probe.
    public static func runOffline(_ parsed: ParsedArguments, environment: [String: String], now: Date,
                                  days: DayCalendar = DayCalendar(), secrets: SecretStore? = nil,
                                  permissions: PermissionState? = nil,
                                  executable: String = CommandLine.arguments.first ?? "",
                                  out: (String) -> Void, err: (String) -> Void) -> Int32 {
        let layout = StoreLayout(home: StoreLayout.resolveHome(flag: parsed.home, environment: environment))
        let keysMode = KeyMode.fromEnvironment(environment)
        switch parsed.command {
        case .help:
            out(usage)
            return 0
        case .run:
            err("run needs the live observer")
            return 2
        case .status:
            let report = StatusReport.build(layout: layout, now: now, days: days, keysMode: keysMode,
                                            probe: permissions)
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
                out(String(decoding: try encoder.encode(report), as: UTF8.self))
                return 0
            } catch {
                err("status: encode failed: \(error)")
                return 1
            }
        case .pause:
            do {
                try FilePauseControl(layout: layout).pause(at: now)
                out("paused")
                return 0
            } catch {
                err("pause: \(error)")
                return 1
            }
        case .resume:
            do {
                try FilePauseControl(layout: layout).resume()
                out("resumed")
                return 0
            } catch {
                err("resume: \(error)")
                return 1
            }
        case .purgeNow:
            let records = Retention(layout: layout, days: days).purge(now: now)
            out("purged \(records.count) day(s)" + (records.isEmpty ? "" : ": " + records.map(\.day).joined(separator: ", ")))
            return 0
        case .exportDay(let day):
            do {
                let vault = DayKeyVault(layout: layout, mode: keysMode, secrets: secrets)
                let store = DayStore(layout: layout, plain: false, days: days, keys: vault)
                for line in try store.exportLines(day: day) { out(line) }
                return 0
            } catch {
                err("export-day \(day): \(error)")
                return 1
            }
        case .exclude(let action):
            let file = ExclusionFile(layout: layout)
            do {
                switch action {
                case .list:
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
                    out(String(decoding: try encoder.encode(try file.load()), as: UTF8.self))
                case .add(let kind, let value):
                    let stored = try ExclusionFile.normalize(kind, value)
                    out(try file.add(kind, value) ? "added \(kind.rawValue) \(stored)"
                        : "\(kind.rawValue) \(stored) already excluded")
                case .remove(let kind, let value):
                    let stored = try ExclusionFile.normalize(kind, value)
                    out(try file.remove(kind, value) ? "removed \(kind.rawValue) \(stored)"
                        : "\(kind.rawValue) \(stored) was not in exclusions.json")
                }
                return 0
            } catch {
                err("exclude: \(error)")
                return 1
            }
        case .installAgent:
            let agents = LaunchAgent.agentsDir(environment: environment)
            let exe = URL(fileURLWithPath: executable).standardizedFileURL.resolvingSymlinksInPath().path
            do {
                let url = try LaunchAgent.install(executable: exe, layout: layout, agentsDir: agents,
                                                  environment: environment)
                out("wrote \(url.path)")
                out("not loaded. To start it: launchctl bootstrap gui/$(id -u) \"\(url.path)\"")
                return 0
            } catch {
                err("install-agent: \(error)")
                return 1
            }
        case .uninstallAgent:
            let agents = LaunchAgent.agentsDir(environment: environment)
            do {
                let url = LaunchAgent.plistURL(agentsDir: agents)
                if try LaunchAgent.uninstall(agentsDir: agents) {
                    out("removed \(url.path)")
                    out("if it was loaded, also run: launchctl bootout gui/$(id -u)/\(LaunchAgent.label)")
                } else {
                    out("no launch agent at \(url.path)")
                }
                return 0
            } catch {
                err("uninstall-agent: \(error)")
                return 1
            }
        }
    }
}
