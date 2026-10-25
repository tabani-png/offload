import Foundation

/// Which macOS permissions the live observer has. Unknown in tests.
public struct PermissionState: Codable, Equatable, Sendable {
    /// Screen Recording: needed for OCR.
    public var screenRecording: Bool
    /// Accessibility: needed for window titles and browser URLs.
    public var accessibility: Bool
    /// Input Monitoring: needed for key/click counts.
    public var inputMonitoring: Bool

    public init(screenRecording: Bool, accessibility: Bool, inputMonitoring: Bool) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring
    }
}

/// Heartbeat written by the running observer (`observer-status.json`).
public struct ObserverHeartbeat: Codable, Equatable, Sendable {
    public var pid: Int32
    public var startedAt: Int64
    public var lastTick: Int64
    public var paused: Bool
    public var idle: Bool
    public var plain: Bool
    public var eventsWritten: Int
    public var writeErrors: Int
    public var ocrErrors: Int
    public var permissions: PermissionState
    /// Optional fields added in s02b (older heartbeats decode without them).
    public var keysMode: String?
    public var nextPurgeAt: Int64?
    public var ocrDropped: Int?
}

/// One stored day in `status --json`.
public struct DayInfo: Codable, Equatable, Sendable {
    public var day: String
    /// Event lines across the day's files.
    public var events: Int
    /// A `.jsonl.enc` file exists.
    public var encrypted: Bool
    /// A plain `.jsonl` file exists.
    public var plain: Bool
}

public struct DayExpiry: Codable, Equatable, Sendable {
    /// The oldest stored day.
    public var day: String
    /// Epoch ms when that day becomes older than `keepDays` (the next purge after this deletes it).
    public var at: Int64
}

public struct KeyFileCounts: Codable, Equatable, Sendable {
    public var raw: Int
    public var wrapped: Int
}

/// What `offload-observer status` prints.
public struct StatusReport: Codable, Equatable, Sendable {
    public var home: String
    /// A heartbeat newer than 15 s from a live pid.
    public var running: Bool
    public var paused: Bool
    public var daysStored: [String]
    /// The oldest stored day is deleted when the local date passes this day.
    public var keepDays: Int
    public var heartbeat: ObserverHeartbeat?
    // s02b: the machine-readable contract for the brain (`status --json`, schemaVersion 1).
    public var schemaVersion: Int
    /// "keychain" or "file" (`OFFLOAD_KEYS`).
    public var keysMode: String
    public var keyFiles: KeyFileCounts
    /// From the running observer's heartbeat, else probed by this process, else nil.
    public var permissions: PermissionState?
    /// "heartbeat", "probe" or "unknown".
    public var permissionsSource: String
    public var days: [DayInfo]
    /// Epoch ms of the running observer's next retention run; nil when it is not running.
    public var nextPurgeAt: Int64?
    /// When the oldest stored day expires; nil when nothing is stored.
    public var nextExpiry: DayExpiry?

    public static func build(layout: StoreLayout, now: Date, days: DayCalendar = DayCalendar(),
                             pidAlive: (Int32) -> Bool = { kill($0, 0) == 0 }, keysMode: KeyMode = .keychain,
                             probe: PermissionState? = nil) -> StatusReport {
        var beat: ObserverHeartbeat?
        if FileManager.default.fileExists(atPath: layout.statusFile.path) {
            do {
                beat = try JSONDecoder().decode(ObserverHeartbeat.self, from: Data(contentsOf: layout.statusFile))
            } catch {
                Log.error("status", "unreadable observer-status.json: \(error)")
            }
        }
        let fresh = beat.map { epochMillis(now) - $0.lastTick <= 15_000 && pidAlive($0.pid) } ?? false
        let retention = Retention(layout: layout, days: days)
        let stored = retention.storedDays()
        let fm = FileManager.default
        let infos = stored.map { day -> DayInfo in
            let enc = layout.encryptedDayFile(day)
            let txt = layout.plainDayFile(day)
            let hasEnc = fm.fileExists(atPath: enc.path)
            let hasTxt = fm.fileExists(atPath: txt.path)
            let events = (hasEnc ? Retention.lineCount(enc) : 0) + (hasTxt ? Retention.lineCount(txt) : 0)
            return DayInfo(day: day, events: events, encrypted: hasEnc, plain: hasTxt)
        }
        var expiry: DayExpiry?
        if let oldest = stored.first, let start = days.date(ofDay: oldest),
           let at = days.calendar.date(byAdding: .day, value: retention.keepDays + 1, to: start) {
            expiry = DayExpiry(day: oldest, at: epochMillis(at))
        }
        let counts = DayKeyVault.keyFileCounts(layout: layout)
        let liveBeat = fresh ? beat : nil
        return StatusReport(home: layout.home.path, running: fresh, paused: FilePauseControl(layout: layout).isPaused,
                            daysStored: stored, keepDays: retention.keepDays, heartbeat: beat, schemaVersion: 1,
                            keysMode: keysMode.rawValue, keyFiles: KeyFileCounts(raw: counts.raw, wrapped: counts.wrapped),
                            permissions: liveBeat?.permissions ?? probe,
                            permissionsSource: liveBeat != nil ? "heartbeat" : (probe != nil ? "probe" : "unknown"),
                            days: infos, nextPurgeAt: liveBeat?.nextPurgeAt, nextExpiry: expiry)
    }
}

extension Observer {
    public func heartbeat(pid: Int32, startedAt: Date, now: Date, plain: Bool, permissions: PermissionState,
                          keysMode: KeyMode? = nil) -> ObserverHeartbeat {
        ObserverHeartbeat(pid: pid, startedAt: epochMillis(startedAt), lastTick: epochMillis(now), paused: isPaused,
                          idle: isIdle, plain: plain, eventsWritten: counters.totalWritten,
                          writeErrors: counters.writeErrors, ocrErrors: counters.ocrErrors, permissions: permissions,
                          keysMode: keysMode?.rawValue, nextPurgeAt: nextPurge.map(epochMillis),
                          ocrDropped: counters.ocrDropped)
    }
}

public func writeHeartbeat(_ beat: ObserverHeartbeat, layout: StoreLayout) {
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try layout.ensureDirectories()
        try encoder.encode(beat).write(to: layout.statusFile, options: .atomic)
    } catch {
        Log.error("status", "write observer-status.json: \(error)")
    }
}
