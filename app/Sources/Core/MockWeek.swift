import Foundation

/// s10d, s10e: the one sample dataset. Two consecutive weeks of one founder, written down once, minute by minute:
///
/// - `before`, Sat 10 to Fri 16 Oct 2026: every span by hand. This is the card's week: the insight, its share, its
///   hours and its evidence are computed from it (1,476 of 2,292 min of outreach = 64.4% = 24.6 h of 38.2 h).
/// - `rows`, Sat 17 to Fri 23 ("now" Fri 11:00): the dashboard's "This week". Outreach was turned on Wed 21 at 09:00;
///   from then Offload drafts the batches and its spans (a green block) are your review. Replies to investors stay
///   by hand. Thu 22 is the one full day since (the activation day is left out): 16 min reviewing plus 78 min of
///   replies = 94 min, 7.8 h a week at 5 days, down from 24.6 h: 16.8 h a week saved, measured.
///
/// No figure on any screen is typed in twice: the card, the timeline, the dashboard's hero and the proof under the
/// chart all read these rows (DESIGN-REVIEW-3 M6).
enum MockWeek {
  typealias Day = (Int, [(String, String, String, Bool)])

  /// (day of month, [(task, "HH:MM", "HH:MM", automated)]), in time order within each day.
  static let before: [Day] = [
    (10, [("t_other", "12:00", "13:00", false)]),
    (11, [("t_other", "19:00", "19:40", false)]),
    (12, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "13:04", false), ("t_outreach", "13:10", "14:10", false),
          ("t_crm", "14:10", "14:50", false), ("t_other", "14:50", "15:24", false)]),
    (13, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "13:04", false), ("t_outreach", "13:10", "14:06", false),
          ("t_crm", "14:10", "14:50", false), ("t_other", "14:50", "15:28", false)]),
    (14, [("t_outreach", "08:30", "12:00", false), ("t_sched", "12:00", "13:04", false), ("t_outreach", "13:10", "14:35", false),
          ("t_crm", "14:40", "15:20", false), ("t_other", "15:20", "15:59", false)]),
    (15, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "13:04", false), ("t_crm", "13:10", "13:50", false),
          ("t_other", "13:50", "14:34", false), ("t_outreach", "16:00", "16:50", false)]),
    (16, [("t_outreach", "08:00", "11:30", false), ("t_sched", "11:30", "12:34", false), ("t_outreach", "13:00", "14:25", false),
          ("t_crm", "14:30", "15:10", false), ("t_other", "15:10", "15:51", false)]),
  ]

  static let rows: [Day] = [
    (17, [("t_other", "12:00", "13:00", false)]),
    (18, [("t_other", "19:00", "19:40", false)]),
    (19, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "13:04", false), ("t_outreach", "13:10", "14:10", false),
          ("t_crm", "14:10", "14:50", false), ("t_other", "14:50", "15:24", false)]),
    (20, [("t_outreach", "08:00", "12:00", false), ("t_sched", "12:00", "13:04", false), ("t_outreach", "13:10", "14:06", false),
          ("t_crm", "14:10", "14:50", false), ("t_other", "14:50", "15:28", false)]),
    (21, [("t_outreach", "08:00", "08:50", false), ("t_outreach", "09:00", "09:18", true), ("t_other", "09:20", "10:46", false),
          ("t_sched", "11:00", "12:30", false), ("t_crm", "14:00", "14:57", false)]),
    (22, [("t_outreach", "09:00", "09:16", true), ("t_sched", "09:30", "11:00", false), ("t_other", "11:00", "12:26", false),
          ("t_outreach", "14:00", "15:18", false), ("t_crm", "15:30", "16:27", false)]),
    (23, [("t_outreach", "09:00", "09:16", true), ("t_sched", "09:20", "10:34", false), ("t_other", "10:34", "11:00", false)]),
  ]

  /// Wed 21 Oct 09:00: outreach turned on.
  static let activatedDay = 21
  static let activatedClock = "09:00"

  static func minutes(_ hhmm: String) -> Int {
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    return p[0] * 60 + p[1]
  }

  /// Minutes per task across `days` (the card's week by default).
  static func minutesByTask(_ days: [Day] = before) -> [String: Int] {
    var out: [String: Int] = [:]
    for (_, spans) in days { for s in spans { out[s.0, default: 0] += minutes(s.2) - minutes(s.1) } }
    return out
  }

  static var trackedMinutes: Int { minutesByTask().values.reduce(0, +) }
  static var trackedHours: Double { Double(trackedMinutes) / 60 }
  static func hours(_ task: String) -> Double { Double(minutesByTask()[task] ?? 0) / 60 }
  static func share(_ task: String) -> Double { Double(minutesByTask()[task] ?? 0) / Double(trackedMinutes) }

  /// "64.4%": the brain's one-decimal share display, computed from the minutes above.
  static func shareDisplay(_ task: String) -> String {
    String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), share(task) * 100)
  }
}
