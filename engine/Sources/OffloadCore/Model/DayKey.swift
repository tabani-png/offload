import Foundation

/// Local-day naming `YYYY-MM-DD` in a given time zone.
public struct DayCalendar: Sendable {
    public let calendar: Calendar

    public init(timeZone: TimeZone = .current) {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        self.calendar = c
    }

    public func day(of date: Date) -> String {
        let d = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", d.year ?? 0, d.month ?? 0, d.day ?? 0)
    }

    /// Start of the named local day, or nil when `day` is not a valid `YYYY-MM-DD`.
    public func date(ofDay day: String) -> Date? {
        let parts = day.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        var comps = DateComponents()
        comps.year = y
        comps.month = m
        comps.day = d
        guard let date = calendar.date(from: comps), self.day(of: date) == day else { return nil }
        return date
    }

    /// Whole local days from `day` to the day of `now` (0 = today). Nil for an invalid day name.
    public func age(ofDay day: String, now: Date) -> Int? {
        guard let start = date(ofDay: day) else { return nil }
        return calendar.dateComponents([.day], from: start, to: calendar.startOfDay(for: now)).day
    }
}
