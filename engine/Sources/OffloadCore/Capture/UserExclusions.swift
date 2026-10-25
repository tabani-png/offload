import Foundation

/// `$OFFLOAD_HOME/exclusions.json`: {"bundleIds":[], "hosts":[], "titleContains":[]}. Missing keys = empty.
public struct UserExclusions: Codable, Equatable, Sendable {
    public var bundleIds: [String]
    public var hosts: [String]
    public var titleContains: [String]

    public init(bundleIds: [String] = [], hosts: [String] = [], titleContains: [String] = []) {
        self.bundleIds = bundleIds
        self.hosts = hosts
        self.titleContains = titleContains
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bundleIds = try c.decodeIfPresent([String].self, forKey: .bundleIds) ?? []
        hosts = try c.decodeIfPresent([String].self, forKey: .hosts) ?? []
        titleContains = try c.decodeIfPresent([String].self, forKey: .titleContains) ?? []
    }

    public var isEmpty: Bool { bundleIds.isEmpty && hosts.isEmpty && titleContains.isEmpty }
}

public enum ExclusionKind: String, Equatable, Sendable {
    case app
    case host
    case title
}

public enum ExclusionFileError: Error, Equatable, CustomStringConvertible {
    case blank(ExclusionKind)
    case unreadable(String)

    public var description: String {
        switch self {
        case .blank(let k): return "empty \(k.rawValue) value"
        case .unreadable(let m): return "exclusions.json: \(m)"
        }
    }
}

extension ExclusionPolicy {
    /// This policy plus the user's entries (built-ins are never removed).
    public func merging(_ user: UserExclusions) -> ExclusionPolicy {
        func union(_ a: [String], _ b: [String]) -> [String] {
            var seen = Set(a.map { $0.lowercased() })
            return a + b.filter { seen.insert($0.lowercased()).inserted }
        }
        return ExclusionPolicy(deniedBundleIDs: union(deniedBundleIDs, user.bundleIds),
                               deniedURLDomains: union(deniedURLDomains, user.hosts),
                               privateTitleMarkers: privateTitleMarkers,
                               deniedTitleSubstrings: union(deniedTitleSubstrings, user.titleContains))
    }
}

/// Reads and edits `exclusions.json` (0600, atomic writes).
public struct ExclusionFile: Sendable {
    public let layout: StoreLayout

    public init(layout: StoreLayout) {
        self.layout = layout
    }

    public var url: URL { layout.exclusionsFile }

    /// Raw bytes, nil when the file does not exist.
    public func data() throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do { return try Data(contentsOf: url) } catch {
            throw ExclusionFileError.unreadable(error.localizedDescription)
        }
    }

    public func load() throws -> UserExclusions {
        guard let data = try data() else { return UserExclusions() }
        return try Self.decode(data)
    }

    static func decode(_ data: Data) throws -> UserExclusions {
        do { return try JSONDecoder().decode(UserExclusions.self, from: data) } catch {
            throw ExclusionFileError.unreadable("not valid JSON {bundleIds, hosts, titleContains}")
        }
    }

    public func save(_ value: UserExclusions) throws {
        try layout.ensureDirectories()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let body = try encoder.encode(value) + Data("\n".utf8)
        let tmp = layout.home.appendingPathComponent(".exclusions.json.tmp")
        try? FileManager.default.removeItem(at: tmp)
        guard FileManager.default.createFile(atPath: tmp.path, contents: body, attributes: [.posixPermissions: 0o600])
        else { throw ExclusionFileError.unreadable("cannot write \(tmp.lastPathComponent)") }
        guard rename(tmp.path, url.path) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(at: tmp)
            throw ExclusionFileError.unreadable("rename failed: errno \(code)")
        }
    }

    /// The stored form of a value: trimmed; hosts reduced to a lowercase host name.
    public static func normalize(_ kind: ExclusionKind, _ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let out: String
        switch kind {
        case .app, .title: out = trimmed
        case .host:
            if trimmed.contains("://") {
                out = URLComponents(string: trimmed)?.host.map(URLScrubber.normalizedHost) ?? ""
            } else if trimmed.contains("/") {
                out = URLScrubber.host(of: trimmed) ?? ""
            } else {
                out = URLScrubber.normalizedHost(trimmed)
            }
        }
        guard !out.isEmpty else { throw ExclusionFileError.blank(kind) }
        return out
    }

    /// Adds `value`. Returns false when an entry equal to it (case-insensitive) is already there.
    @discardableResult
    public func add(_ kind: ExclusionKind, _ value: String) throws -> Bool {
        let v = try Self.normalize(kind, value)
        var current = try load()
        var list = Self.list(current, kind)
        guard !list.contains(where: { $0.caseInsensitiveCompare(v) == .orderedSame }) else { return false }
        list.append(v)
        Self.set(&current, kind, list)
        try save(current)
        return true
    }

    /// Removes every entry equal to `value` (case-insensitive). Returns false when none was there.
    @discardableResult
    public func remove(_ kind: ExclusionKind, _ value: String) throws -> Bool {
        let v = try Self.normalize(kind, value)
        var current = try load()
        let list = Self.list(current, kind)
        let kept = list.filter { $0.caseInsensitiveCompare(v) != .orderedSame }
        guard kept.count != list.count else { return false }
        Self.set(&current, kind, kept)
        try save(current)
        return true
    }

    private static func list(_ u: UserExclusions, _ kind: ExclusionKind) -> [String] {
        switch kind {
        case .app: return u.bundleIds
        case .host: return u.hosts
        case .title: return u.titleContains
        }
    }

    private static func set(_ u: inout UserExclusions, _ kind: ExclusionKind, _ list: [String]) {
        switch kind {
        case .app: u.bundleIds = list
        case .host: u.hosts = list
        case .title: u.titleContains = list
        }
    }
}

/// The policy the observer applies: `base` merged with `exclusions.json`, re-read at most every `interval` seconds
/// (default 2, so an edit is live within 5 s). An unreadable file keeps the last good policy and is logged once.
public final class ExclusionReloader {
    public let file: ExclusionFile
    public let base: ExclusionPolicy
    public let interval: TimeInterval
    private var lastCheck: Date?
    private var lastData: Data??
    private var currentPolicy: ExclusionPolicy
    private var loggedBroken = false

    public init(file: ExclusionFile, base: ExclusionPolicy = .standard, interval: TimeInterval = 2) {
        self.file = file
        self.base = base
        self.interval = interval
        self.currentPolicy = base
    }

    public func policy(now: Date) -> ExclusionPolicy {
        if let last = lastCheck, now.timeIntervalSince(last) < interval { return currentPolicy }
        lastCheck = now
        let data: Data?
        do { data = try file.data() } catch {
            logBroken(Log.describe(error))
            return currentPolicy
        }
        if let lastData, lastData == data { return currentPolicy }
        lastData = .some(data)
        guard let data else {
            currentPolicy = base
            loggedBroken = false
            return currentPolicy
        }
        do {
            currentPolicy = base.merging(try ExclusionFile.decode(data))
            loggedBroken = false
        } catch {
            logBroken("\(Log.describe(error)); keeping the previous exclusions")
        }
        return currentPolicy
    }

    private func logBroken(_ message: String) {
        guard !loggedBroken else { return }
        loggedBroken = true
        Log.error("exclusions", message)
    }
}
