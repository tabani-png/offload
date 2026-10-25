import Foundation

/// Diagnostics go to stderr with a context tag. Never log titles, URLs, OCR text or key values: messages carry
/// contexts, file names, day labels, counts and error codes only. Errors from outside this module (Vision,
/// ScreenCaptureKit, the file system, decoding) go through `describe`, which keeps the domain and code and drops
/// the description, since a system error message can quote a window title or a URL.
public enum Log {
    /// The process-wide sink (stderr; launchd sends it to `logs/observer.err.log`).
    nonisolated(unsafe) public static var sink: (String) -> Void = { line in
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }

    /// Tests capture the lines of one task (and the synchronous calls inside it) without touching `sink`, so
    /// parallel tests cannot steal each other's lines.
    @TaskLocal public static var capture: LogCapture?

    public static func error(_ context: String, _ message: String) {
        emit("offload-observer [\(context)] error: \(message)")
    }

    public static func info(_ context: String, _ message: String) {
        emit("offload-observer [\(context)] \(message)")
    }

    private static func emit(_ line: String) {
        if let capture { capture.append(line) } else { sink(line) }
    }

    /// A log-safe one-liner for an error. Our own error types keep their text (file names, day labels, line
    /// numbers, status codes; never observed content); anything else is reduced to its domain and code.
    public static func describe(_ error: Error) -> String {
        switch error {
        case let e as StoreError: return "\(e)"
        case let e as ExclusionFileError: return e.description
        case is DecodingError: return "invalid JSON"
        default:
            let ns = error as NSError
            return "\(ns.domain) code \(ns.code)"
        }
    }
}

/// Collects log lines in memory (tests).
public final class LogCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []

    public init() {}

    public func append(_ line: String) { lock.withLock { stored.append(line) } }

    public var lines: [String] { lock.withLock { stored } }
}
