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

    public static func build(layout: StoreLayout, now: Date, days: DayCalendar = DayCalendar(),
                             pidAlive: (Int32) -> Bool = { kill($0, 0) == 0 }) -> StatusReport {
        var beat: ObserverHeartbeat?
        if FileManager.default.fileExists(atPath: layout.statusFile.path) {
            do {
                beat = try JSONDecoder().decode(ObserverHeartbeat.self, from: Data(contentsOf: layout.statusFile))
            } catch {
                Log.error("status", "unreadable observer-status.json: \(error)")
            }
        }
        let fresh = beat.map { epochMillis(now) - $0.lastTick <= 15_000 && pidAlive($0.pid) } ?? false
        return StatusReport(home: layout.home.path, running: fresh, paused: FilePauseControl(layout: layout).isPaused,
                            daysStored: Retention(layout: layout, days: days).storedDays(),
                            keepDays: Retention.defaultKeepDays, heartbeat: beat)
    }
}

extension Observer {
    public func heartbeat(pid: Int32, startedAt: Date, now: Date, plain: Bool, permissions: PermissionState)
        -> ObserverHeartbeat {
        ObserverHeartbeat(pid: pid, startedAt: epochMillis(startedAt), lastTick: epochMillis(now), paused: isPaused,
                          idle: isIdle, plain: plain, eventsWritten: counters.totalWritten,
                          writeErrors: counters.writeErrors, ocrErrors: counters.ocrErrors, permissions: permissions)
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
