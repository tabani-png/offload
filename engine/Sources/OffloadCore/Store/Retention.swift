import Foundation

/// One purge-log line: {day, deletedAt, events}. `deletedAt` is unix epoch milliseconds, like `ts`.
public struct PurgeRecord: Codable, Equatable, Sendable {
    public var day: String
    public var deletedAt: Int64
    /// Lines (events) the deleted day files held.
    public var events: Int
    /// Keyframe blobs deleted with the day (s11). Absent when the day had none, so older lines are unchanged.
    public var frames: Int? = nil
}

/// Deletes days older than `keepDays` local days: the day file(s), the day key AND the brain key of that day
/// (`keys/brain-YYYY-MM-DD.key`; brain keys with other names are never touched). A day is older than keepDays (30) when its
/// local age (whole days from that day to today) is greater than 30, so today and the 30 days before it are kept.
public struct Retention {
    public static let defaultKeepDays = 30

    public let layout: StoreLayout
    public let days: DayCalendar
    public let keepDays: Int

    public init(layout: StoreLayout, days: DayCalendar = DayCalendar(), keepDays: Int = Retention.defaultKeepDays) {
        self.layout = layout
        self.days = days
        self.keepDays = keepDays
    }

    /// Every stored day name (from day files and key files), sorted.
    public func storedDays() -> [String] {
        var names = Set<String>()
        for (dir, suffixes) in [(layout.daysDir, [".jsonl.enc", ".jsonl"]), (layout.keysDir, [".key"])] {
            let entries: [String]
            do { entries = try FileManager.default.contentsOfDirectory(atPath: dir.path) } catch {
                if FileManager.default.fileExists(atPath: dir.path) {
                    Log.error("retention", "list \(dir.lastPathComponent): \(error.localizedDescription)")
                }
                continue
            }
            for entry in entries {
                for suffix in suffixes where entry.hasSuffix(suffix) {
                    let day = String(entry.dropLast(suffix.count))
                    if StoreLayout.isDayName(day) { names.insert(day) }
                    break
                }
            }
        }
        // s11: a day that only has keyframes is a stored day too.
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: layout.framesDir.path) {
            for entry in entries where StoreLayout.isDayName(entry) { names.insert(entry) }
        }
        return names.sorted()
    }

    /// Days that `purge` would delete now.
    public func expiredDays(now: Date) -> [String] {
        storedDays().filter { day in
            guard let age = days.age(ofDay: day, now: now) else { return false }
            return age > keepDays
        }
    }

    /// Names of the brain keys in `keys/` (`brain-NAME.key`, NAME valid per `BrainKeys.isValidName`), sorted.
    public func brainKeyNames() -> [String] {
        let entries: [String]
        do { entries = try FileManager.default.contentsOfDirectory(atPath: layout.keysDir.path) } catch { return [] }
        return entries.compactMap { entry -> String? in
            guard entry.hasPrefix("brain-"), entry.hasSuffix(".key") else { return nil }
            let name = String(entry.dropFirst("brain-".count).dropLast(".key".count))
            return BrainKeys.isValidName(name) ? name : nil
        }.sorted()
    }

    /// True when `name` is a real local calendar date (`YYYY-MM-DD`), so its brain key follows the retention window.
    public func isDayDate(_ name: String) -> Bool { days.date(ofDay: name) != nil }

    /// True when `name` is a date older than `keepDays` local days.
    public func isExpired(_ name: String, now: Date) -> Bool {
        guard let age = days.age(ofDay: name, now: now) else { return false }
        return age > keepDays
    }

    /// Brain keys named for a day past the window (REVIEW-2 N4): `purge` deletes them.
    public func expiredBrainKeys(now: Date) -> [String] { brainKeyNames().filter { isExpired($0, now: now) } }

    /// Brain keys whose names are not dates: retention leaves them alone (`status --json` lists them).
    public func otherBrainKeys() -> [String] { brainKeyNames().filter { !isDayDate($0) } }

    public struct Outcome: Equatable, Sendable {
        /// Purged days (one purge-log line each).
        public var days: [PurgeRecord]
        /// Names of the deleted brain keys (dates past the window).
        public var brainKeys: [String]
    }

    /// Deletes every expired day and appends one purge-log line per day. Returns the records written.
    /// A file that cannot be deleted is logged and the day is not reported as purged.
    @discardableResult
    public func purge(now: Date) -> [PurgeRecord] { purgeAll(now: now).days }

    /// `purge` plus the brain keys named for expired days, so the brain's sealed files for those days cannot be
    /// opened even when the brain is not running. Brain keys get no purge-log line (it counts day-file events).
    @discardableResult
    public func purgeAll(now: Date) -> Outcome {
        var records: [PurgeRecord] = []
        for day in expiredDays(now: now) {
            let files = [layout.encryptedDayFile(day), layout.plainDayFile(day), layout.keyFile(day)]
            var events = 0
            for file in files.prefix(2) where FileManager.default.fileExists(atPath: file.path) {
                events += Self.lineCount(file)
            }
            var ok = true
            for file in files where FileManager.default.fileExists(atPath: file.path) {
                do { try FileManager.default.removeItem(at: file) } catch {
                    ok = false
                    Log.error("retention", "delete \(file.lastPathComponent): \(error.localizedDescription)")
                }
            }
            // s11: the day's keyframes go with it (blobs and index) before the record is written.
            var frames: Int?
            let frameDir = layout.frameDir(day)
            if FileManager.default.fileExists(atPath: frameDir.path) {
                let entries = (try? FileManager.default.contentsOfDirectory(atPath: frameDir.path)) ?? []
                frames = entries.filter { $0.hasSuffix(".enc") && $0 != "index.jsonl.enc" }.count
                do { try FileManager.default.removeItem(at: frameDir) } catch {
                    ok = false
                    Log.error("retention", "delete frames/\(day): \(Log.describe(error))")
                }
            }
            guard ok else { continue }
            var record = PurgeRecord(day: day, deletedAt: epochMillis(now), events: events)
            record.frames = frames
            records.append(record)
            appendLog(record)
        }
        var brainKeys: [String] = []
        for name in expiredBrainKeys(now: now) {
            let file = layout.brainKeyFile(name)
            do {
                try FileManager.default.removeItem(at: file)
                brainKeys.append(name)
            } catch {
                Log.error("retention", "delete \(file.lastPathComponent): \(Log.describe(error))")
            }
        }
        if !brainKeys.isEmpty {
            Log.info("retention", "deleted \(brainKeys.count) expired brain key(s): \(brainKeys.joined(separator: ", "))")
        }
        return Outcome(days: records, brainKeys: brainKeys)
    }

    private func appendLog(_ record: PurgeRecord) {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let line = try encoder.encode(record) + Data("\n".utf8)
            let url = layout.purgeLog
            if !FileManager.default.fileExists(atPath: url.path) {
                try layout.ensureDirectories()
                guard FileManager.default.createFile(atPath: url.path, contents: nil,
                                                     attributes: [.posixPermissions: 0o600]) else {
                    Log.error("retention", "create purge-log.jsonl failed")
                    return
                }
            }
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try handle.close()
        } catch {
            Log.error("retention", "append purge-log for \(record.day): \(Log.describe(error))")
        }
    }

    static func lineCount(_ url: URL) -> Int {
        do {
            return try Data(contentsOf: url).split(separator: UInt8(ascii: "\n")).filter { !$0.isEmpty }.count
        } catch {
            Log.error("retention", "count lines of \(url.lastPathComponent): \(error.localizedDescription)")
            return 0
        }
    }
}
