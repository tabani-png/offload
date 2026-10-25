import Foundation

/// Parsed `offload-observer` arguments.
public enum ObserverCommand: Equatable, Sendable {
    case run
    case status
    case pause
    case resume
    case purgeNow
    case exportDay(String)
    case help
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
      status               print observer state as JSON
      pause | resume       stop / restart recording (the running observer notices within 1 s)
      purge-now            delete days older than 7 local days now
      export-day YYYY-MM-DD  print that day's decrypted events as JSON lines
    env: OFFLOAD_HOME (default ~/Library/Application Support/Offload), OFFLOAD_PLAIN=1 (write plain jsonl)
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
        case "status": return try noExtra(.status)
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

    /// Runs every command except `run` (which needs the live glue). Returns the exit code.
    public static func runOffline(_ parsed: ParsedArguments, environment: [String: String], now: Date,
                                  days: DayCalendar = DayCalendar(), out: (String) -> Void, err: (String) -> Void)
        -> Int32 {
        let layout = StoreLayout(home: StoreLayout.resolveHome(flag: parsed.home, environment: environment))
        switch parsed.command {
        case .help:
            out(usage)
            return 0
        case .run:
            err("run needs the live observer")
            return 2
        case .status:
            let report = StatusReport.build(layout: layout, now: now, days: days)
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
                let store = DayStore(layout: layout, plain: false, days: days)
                for line in try store.exportLines(day: day) { out(line) }
                return 0
            } catch {
                err("export-day \(day): \(error)")
                return 1
            }
        }
    }
}
