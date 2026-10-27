import Foundation

/// Parsed `offload-observer` arguments.
public enum ObserverCommand: Equatable, Sendable {
    case run
    case status
    case pause
    case resume
    case purgeNow
    case exportDay(String)
    /// s11: `list-frames YYYY-MM-DD`: the day's decrypted keyframe index, one JSON line per frame.
    case listFrames(String)
    /// s11: `export-frame FRAMEID`: the decrypted JPEG bytes on stdout.
    case exportFrame(String)
    case exclude(ExcludeAction)
    case installAgent
    case uninstallAgent
    /// `wrap-key --name NAME`: store a new random Keychain-wrapped brain key, or return the stored one.
    case wrapKey(String)
    /// `wrap-key --name NAME --import`: store the caller's key from stdin (raw-file migration only, REVIEW-2 N7).
    case importKey(String)
    /// `unwrap-key --name NAME`: print a stored brain key.
    case unwrapKey(String)
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
    case invalidValue(String)

    public var description: String {
        switch self {
        case .unknownCommand(let c): return "unknown command '\(c)'"
        case .missingValue(let f): return "\(f) needs a value"
        case .unexpected(let a): return "unexpected argument '\(a)'"
        case .invalidValue(let f): return "\(f) has an invalid value"
        }
    }
}

public enum ObserverCLI {
    public static let usage = """
    usage: offload-observer <command> [--home DIR]
      run                  record events until stopped (Ctrl-C / SIGTERM)
      status [--json]      print observer state as JSON (schemaVersion 1)
      pause | resume       stop / restart recording (the running observer notices within 1 s)
      purge-now            delete days older than \(Retention.defaultKeepDays) local days now
      export-day YYYY-MM-DD  print that day's decrypted events as JSON lines (exit 3 + purge if older than \(Retention.defaultKeepDays) days)
      list-frames YYYY-MM-DD print that day's keyframe index as JSON lines (exit 3 + purge if older than \(Retention.defaultKeepDays) days)
      export-frame FRAMEID   write that keyframe's decrypted JPEG to stdout (exit 3 + purge if older than \(Retention.defaultKeepDays) days)
      wrap-key --name NAME   store a new random 32-byte brain key wrapped with the Keychain master key in
                           keys/brain-NAME.key (or keep the stored one); prints the key as base64
      wrap-key --name NAME --import  store the 32-byte key given as one base64 line on stdin instead (migration)
      unwrap-key --name NAME print the stored brain key as base64 (exit 3 if NAME is a day older than \(Retention.defaultKeepDays) days)
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
        case "list-frames":
            guard let day = extra.first else { throw ArgumentError.missingValue("list-frames") }
            if extra.count > 1 { throw ArgumentError.unexpected(extra[extra.startIndex + 1]) }
            guard StoreLayout.isDayName(day) else { throw ArgumentError.invalidValue("list-frames") }
            return ParsedArguments(command: .listFrames(day), home: home)
        case "export-frame":
            guard let id = extra.first else { throw ArgumentError.missingValue("export-frame") }
            if extra.count > 1 { throw ArgumentError.unexpected(extra[extra.startIndex + 1]) }
            guard FrameStore.isFrameID(id) else { throw ArgumentError.invalidValue("export-frame") }
            return ParsedArguments(command: .exportFrame(id), home: home)
        case "wrap-key":
            var args = Array(extra)
            let importing = args.contains("--import")
            args.removeAll { $0 == "--import" }
            let name = try parseName(args)
            return ParsedArguments(command: importing ? .importKey(name) : .wrapKey(name), home: home)
        case "unwrap-key": return ParsedArguments(command: .unwrapKey(try parseName(Array(extra))), home: home)
        default: throw ArgumentError.unknownCommand(first)
        }
    }

    /// `--name NAME` or `--name=NAME`; NAME must pass `BrainKeys.isValidName`.
    static func parseName(_ args: [String]) throws -> String {
        guard let flag = args.first else { throw ArgumentError.missingValue("--name") }
        let name: String
        var used = 1
        if flag == "--name" {
            guard args.count > 1 else { throw ArgumentError.missingValue("--name") }
            name = args[1]
            used = 2
        } else if flag.hasPrefix("--name=") {
            name = String(flag.dropFirst("--name=".count))
        } else {
            throw ArgumentError.unexpected(flag)
        }
        if args.count > used { throw ArgumentError.unexpected(args[used]) }
        guard BrainKeys.isValidName(name) else { throw ArgumentError.invalidValue("--name") }
        return name
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
                                  input: () -> Data = { Data() },
                                  out: (String) -> Void, err: (String) -> Void,
                                  outBytes: (Data) -> Void = { FileHandle.standardOutput.write($0) }) -> Int32 {
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
            let outcome = Retention(layout: layout, days: days).purgeAll(now: now)
            let records = outcome.days
            var line = "purged \(records.count) day(s)" + (records.isEmpty ? "" : ": " + records.map(\.day).joined(separator: ", "))
            if !outcome.brainKeys.isEmpty {
                line += "; deleted \(outcome.brainKeys.count) expired brain key(s): " + outcome.brainKeys.joined(separator: ", ")
            }
            out(line)
            return 0
        case .exportDay(let day):
            // REVIEW-1 M4: never serve a day past retention, even when the observer is not running to purge it.
            if let age = days.age(ofDay: day, now: now), age > Retention.defaultKeepDays {
                let purged = Retention(layout: layout, days: days).purge(now: now)
                err("export-day \(day): day is older than \(Retention.defaultKeepDays) days and is not served"
                    + " (retention purged \(purged.count) expired day(s))")
                return 3
            }
            do {
                let vault = DayKeyVault(layout: layout, mode: keysMode, secrets: secrets)
                let store = DayStore(layout: layout, plain: false, days: days, keys: vault)
                for line in try store.exportLines(day: day) { out(line) }
                return 0
            } catch {
                err("export-day \(day): \(error)")
                return 1
            }
        case .listFrames(let day):
            guard days.date(ofDay: day) != nil else {
                err("list-frames \(day): not a calendar day")
                return 2
            }
            if let code = refuseExpiredFrames("list-frames \(day)", day: day, layout: layout, days: days, now: now, err: err) {
                return code
            }
            do {
                let store = FrameStore(layout: layout, days: days, keys: DayKeyVault(layout: layout, mode: keysMode, secrets: secrets))
                for meta in try store.list(day: day) { out(String(decoding: try meta.jsonLine(), as: UTF8.self)) }
                return 0
            } catch {
                err("list-frames \(day): \(error)")
                return 1
            }
        case .exportFrame(let id):
            let store = FrameStore(layout: layout, days: days, keys: DayKeyVault(layout: layout, mode: keysMode, secrets: secrets))
            guard let day = store.locate(id) else {
                err("export-frame \(id): not found")
                return 1
            }
            if let code = refuseExpiredFrames("export-frame \(id)", day: day, layout: layout, days: days, now: now, err: err) {
                return code
            }
            do {
                outBytes(try store.read(id).jpeg)
                return 0
            } catch {
                err("export-frame \(id): \(error)")
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
        case .wrapKey(let name), .importKey(let name):
            let importing = parsed.command == .importKey(name)
            guard keysMode == .keychain else {
                err("wrap-key: brain keys need the Keychain; unset OFFLOAD_KEYS=file")
                return 1
            }
            let text = String(decoding: input(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            // REVIEW-2 N7: a caller-chosen key is taken only when asked for explicitly, so a stray or planted key
            // cannot become a day's brain key by accident.
            if !importing && !text.isEmpty {
                err("wrap-key: a key on stdin is accepted only with --import (raw key migration); without it wrap-key"
                    + " makes a new random key")
                return 2
            }
            if importing && text.isEmpty {
                err("wrap-key --import: stdin must hold one base64 line of exactly \(StoreCrypto.keySize) bytes")
                return 2
            }
            var provided: Data?
            if importing {
                guard let raw = Data(base64Encoded: text), raw.count == StoreCrypto.keySize else {
                    err("wrap-key: stdin must be one base64 line holding exactly \(StoreCrypto.keySize) bytes")
                    return 1
                }
                provided = raw
            }
            if let code = refuseExpiredBrainKey("wrap-key", name, layout: layout, days: days, now: now, err: err) {
                return code
            }
            do {
                let raw = try BrainKeys(layout: layout, secrets: secrets).wrap(name: name, key: provided)
                out(raw.base64EncodedString())
                return 0
            } catch {
                err("wrap-key \(name): \(BrainKeys.describe(error))")
                return 1
            }
        case .unwrapKey(let name):
            guard keysMode == .keychain else {
                err("unwrap-key: brain keys need the Keychain; unset OFFLOAD_KEYS=file")
                return 1
            }
            if let code = refuseExpiredBrainKey("unwrap-key", name, layout: layout, days: days, now: now, err: err) {
                return code
            }
            do {
                out(try BrainKeys(layout: layout, secrets: secrets).unwrap(name: name).base64EncodedString())
                return 0
            } catch {
                err("unwrap-key \(name): \(BrainKeys.describe(error))")
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

    /// s11: keyframes of a day past the window are never served; the purge runs (deleting them) and the exit is 3.
    static func refuseExpiredFrames(_ what: String, day: String, layout: StoreLayout, days: DayCalendar, now: Date,
                                    err: (String) -> Void) -> Int32? {
        guard let age = days.age(ofDay: day, now: now), age > Retention.defaultKeepDays else { return nil }
        let purged = Retention(layout: layout, days: days).purgeAll(now: now)
        err("\(what): day is older than \(Retention.defaultKeepDays) days and is not served"
            + " (retention purged \(purged.days.count) expired day(s))")
        return 3
    }

    /// REVIEW-2 N4: a brain key named for a day past the window is never served or created. Runs the retention
    /// purge (which deletes it) and returns exit code 3; nil when `name` is not an expired date.
    static func refuseExpiredBrainKey(_ verb: String, _ name: String, layout: StoreLayout, days: DayCalendar, now: Date,
                                      err: (String) -> Void) -> Int32? {
        let retention = Retention(layout: layout, days: days)
        guard retention.isExpired(name, now: now) else { return nil }
        let outcome = retention.purgeAll(now: now)
        err("\(verb) \(name): day is older than \(retention.keepDays) days; its brain key is not served"
            + " (retention deleted \(outcome.brainKeys.count) expired brain key(s))")
        return 3
    }
}
