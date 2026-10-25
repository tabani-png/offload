import Foundation

/// The `kind` enum of schemas/event.schema.json.
public enum EventKind: String, Codable, CaseIterable, Sendable {
    case focus
    case idleStart = "idle_start"
    case idleEnd = "idle_end"
    case input, ocr, pause, resume
}

/// One raw observation, in its decrypted form. Field names are exactly those of schemas/event.schema.json; nil fields
/// are omitted from the JSON.
public struct Event: Codable, Equatable, Sendable {
    public var id: String
    /// Unix epoch milliseconds.
    public var ts: Int64
    public var kind: EventKind
    public var app: String?
    public var appName: String?
    public var title: String?
    public var url: String?
    public var host: String?
    public var keys: Int?
    public var clicks: Int?
    public var text: String?
    public var textHash: String?

    public init(id: String, ts: Int64, kind: EventKind, app: String? = nil, appName: String? = nil,
                title: String? = nil, url: String? = nil, host: String? = nil, keys: Int? = nil, clicks: Int? = nil,
                text: String? = nil, textHash: String? = nil) {
        self.id = id
        self.ts = ts
        self.kind = kind
        self.app = app
        self.appName = appName
        self.title = title
        self.url = url
        self.host = host
        self.keys = keys
        self.clicks = clicks
        self.text = text
        self.textHash = textHash
    }

    /// One JSON line (no trailing newline), keys sorted so output is stable.
    public func jsonLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public static func decode(jsonLine: Data) throws -> Event {
        try JSONDecoder().decode(Event.self, from: jsonLine)
    }
}

/// Converts a Date to the schema's `ts`.
public func epochMillis(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
}
