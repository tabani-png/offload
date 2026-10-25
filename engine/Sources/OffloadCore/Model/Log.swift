import Foundation

/// Diagnostics go to stderr with a context tag. Never log titles, URLs, OCR text or key values.
public enum Log {
    /// Tests swap this to capture lines.
    nonisolated(unsafe) public static var sink: (String) -> Void = { line in
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }

    public static func error(_ context: String, _ message: String) {
        sink("offload-observer [\(context)] error: \(message)")
    }

    public static func info(_ context: String, _ message: String) {
        sink("offload-observer [\(context)] \(message)")
    }
}
