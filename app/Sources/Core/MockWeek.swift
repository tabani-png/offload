import Foundation

/// s10d: the one sample week. The timeline rows below are the only place the week's minutes are written down; the
/// card's insights (hours, tracked total, share) and the dashboard's "38.2 h tracked" are computed from them, so a
/// figure on one screen always ties to the bars on another (DESIGN-REVIEW-2 section C).
///
/// Sat 17 to Fri 23 Oct 2026, "now" Fri 11:00. Outreach was turned on Wed 21 at 09:00: from then on its spans are
/// Offload's runs, and their length is the time you spent reviewing the batch (hatched on the timeline).
enum MockWeek {
  /// (day of month, [(task, "HH:MM", "HH:MM", automated)]), in time order within each day.
  static let rows: [(Int, [(String, String, String, Bool)])] = [
    (17, [("t_outreach", "10:00", "12:30", false), ("t_other", "12:30", "13:00", false)]),
    (18, [("t_outreach", "19:00", "22:00", false)]),
    (19, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "12:30", false), ("t_outreach", "13:00", "16:30", false),
          ("t_crm", "16:30", "17:15", false), ("t_outreach", "17:15", "19:00", false), ("t_other", "19:00", "19:30", false)]),
    (20, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "12:40", false), ("t_outreach", "13:00", "16:30", false),
          ("t_crm", "16:30", "17:15", false), ("t_outreach", "17:15", "18:30", false), ("t_other", "18:30", "19:00", false)]),
    (21, [("t_outreach", "09:00", "09:18", true), ("t_other", "09:20", "10:46", false), ("t_sched", "11:00", "12:30", false),
          ("t_crm", "14:00", "14:57", false)]),
    (22, [("t_outreach", "09:00", "09:16", true), ("t_sched", "09:30", "11:00", false), ("t_other", "11:00", "12:26", false),
          ("t_crm", "15:00", "15:57", false), ("t_outreach", "16:30", "16:46", true)]),
    (23, [("t_outreach", "09:00", "09:16", true), ("t_sched", "09:20", "10:34", false), ("t_other", "10:34", "11:00", false)]),
  ]

  static func minutes(_ hhmm: String) -> Int {
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    return p[0] * 60 + p[1]
  }

  /// Minutes per task across the week.
  static var minutesByTask: [String: Int] {
    var out: [String: Int] = [:]
    for (_, spans) in rows { for s in spans { out[s.0, default: 0] += minutes(s.2) - minutes(s.1) } }
    return out
  }

  static var trackedMinutes: Int { minutesByTask.values.reduce(0, +) }
  static var trackedHours: Double { Double(trackedMinutes) / 60 }
  static func hours(_ task: String) -> Double { Double(minutesByTask[task] ?? 0) / 60 }
  static func share(_ task: String) -> Double { Double(minutesByTask[task] ?? 0) / Double(trackedMinutes) }

  /// "64.4%": the brain's one-decimal share display, computed from the minutes above.
  static func shareDisplay(_ task: String) -> String {
    String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), share(task) * 100)
  }
}
