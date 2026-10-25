import Foundation

/// One purge-log line: {day, deletedAt, events}. `deletedAt` is unix epoch milliseconds, like `ts`.
public struct PurgeRecord: Codable, Equatable, Sendable {
    public var day: String
    public var deletedAt: Int64
    /// Lines (events) the deleted day files held.
    public var events: Int
}

/// Deletes days older than `keepDays` local days: the day file(s) AND the key. A day is older than 7 when its local
/// age (whole days from that day to today) is greater than 7, so today and the 7 days before it are kept.
public struct Retention {
    public static let defaultKeepDays = 7

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
        return names.sorted()
    }

    /// Days that `purge` would delete now.
    public func expiredDays(now: Date) -> [String] {
        storedDays().filter { day in
            guard let age = days.age(ofDay: day, now: now) else { return false }
            return age > keepDays
        }
    }

    /// Deletes every expired day and appends one purge-log line per day. Returns the records written.
    /// A file that cannot be deleted is logged and the day is not reported as purged.
    @discardableResult
    public func purge(now: Date) -> [PurgeRecord] {
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
            guard ok else { continue }
            let record = PurgeRecord(day: day, deletedAt: epochMillis(now), events: events)
            records.append(record)
            appendLog(record)
        }
        return records
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
            Log.error("retention", "append purge-log for \(record.day): \(error)")
        }
    }

    private static func lineCount(_ url: URL) -> Int {
        do {
            return try Data(contentsOf: url).split(separator: UInt8(ascii: "\n")).filter { !$0.isEmpty }.count
        } catch {
            Log.error("retention", "count lines of \(url.lastPathComponent): \(error.localizedDescription)")
            return 0
        }
    }
}
