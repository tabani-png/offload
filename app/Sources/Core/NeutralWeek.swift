import Foundation

// s23: the time screen's sample for the mock client and the snapshots: a NEUTRAL week of mixed work (coding-agent
// sessions, docs, meetings, spreadsheets, browsing, some email), shaped like the brain's answer on
// brain/fixtures/gen-neutral.ts. It obeys the brain's invariants by construction: every dimension is grouped from the
// same blocks (so the rows add up to the total), every display is HoursFormat, hours freed are capped by the time
// observed and every number carries event ids. The outreach SampleWeek is not used by this screen.

enum NeutralWeek {
  /// One task's time in the window: its app and kind, and its active minutes.
  struct Block {
    var taskId: String
    var task: String
    var app: String
    var appName: String
    var kind: String
    var minutes: Double
  }

  /// A finding on a task: the insight, the best fix kind (nil = s22 absent) and the fix's estimate in h a week.
  struct FindingSpec {
    var taskId: String
    var fixKind: FixKind?
    var estimate: Double
  }

  static let days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]
  static let kindNames: [(String, String)] = [("code", "Coding"), ("docs", "Docs"), ("meeting", "Meetings"), ("sheet", "Spreadsheets"),
                                              ("email", "Email"), ("chat", "Chat"), ("browse", "Browsing"), ("other", "Other")]

  private static let chrome = ("com.google.Chrome", "Google Chrome")
  private static func block(_ id: String, _ task: String, _ app: (String, String), _ kind: String, _ minutes: Double) -> Block {
    Block(taskId: id, task: task, app: app.0, appName: app.1, kind: kind, minutes: minutes)
  }

  static let weekBlocks: [Block] = [
    block("t_claude", "Coding with Claude Code", ("com.apple.Terminal", "Terminal"), "code", 384),
    block("t_vscode", "Work in Code", ("com.microsoft.VSCode", "Code"), "code", 228),
    block("t_meet", "Calls in Google Chrome · Meet - Design review", chrome, "meeting", 144),
    block("t_github", "Browsing github.com", chrome, "browse", 138),
    block("t_mdn", "Browsing developer.mozilla.org", chrome, "browse", 102),
    block("t_metrics", "Spreadsheet updates: Team metrics", chrome, "sheet", 78),
    block("t_zoom", "Calls in zoom.us", ("us.zoom.xos", "zoom.us"), "meeting", 78),
    block("t_replies", "Email replies", chrome, "email", 60),
    block("t_api", "Notion: Atlas API design", ("notion.id", "Notion"), "docs", 60),
    block("t_inbox", "Inbox triage", chrome, "email", 54),
    block("t_slack", "Slack messages", ("com.tinyspeck.slackmacgap", "Slack"), "chat", 54),
    block("t_hn", "Browsing news.ycombinator.com", chrome, "browse", 54),
    block("t_sprint", "Spreadsheet updates: Sprint tracker", chrome, "sheet", 42),
    block("t_roadmap", "Notion: Roadmap draft", ("notion.id", "Notion"), "docs", 36),
    block("t_onboard", "Notion: Onboarding guide", ("notion.id", "Notion"), "docs", 30),
    block("t_calendar", "Calendar checks", chrome, "meeting", 18),
    block("t_finder", "Finder: Downloads", ("com.apple.finder", "Finder"), "other", 6),
  ]

  static let weekFindings: [FindingSpec] = [
    FindingSpec(taskId: "t_metrics", fixKind: .workflow, estimate: 1.2),
    FindingSpec(taskId: "t_replies", fixKind: .workflow, estimate: 0.9),
    FindingSpec(taskId: "t_sprint", fixKind: .tool, estimate: 0.4),
    FindingSpec(taskId: "t_slack", fixKind: .setup, estimate: 0.2),
  ]

  /// Wednesday: a subset of the week's tasks.
  static let dayBlocks: [Block] = [
    block("t_claude", "Coding with Claude Code", ("com.apple.Terminal", "Terminal"), "code", 78),
    block("t_vscode", "Work in Code", ("com.microsoft.VSCode", "Code"), "code", 46),
    block("t_meet", "Calls in Google Chrome · Meet - Design review", chrome, "meeting", 50),
    block("t_github", "Browsing github.com", chrome, "browse", 28),
    block("t_mdn", "Browsing developer.mozilla.org", chrome, "browse", 22),
    block("t_metrics", "Spreadsheet updates: Team metrics", chrome, "sheet", 17),
    block("t_zoom", "Calls in zoom.us", ("us.zoom.xos", "zoom.us"), "meeting", 15),
    block("t_replies", "Email replies", chrome, "email", 13),
    block("t_api", "Notion: Atlas API design", ("notion.id", "Notion"), "docs", 34),
    block("t_inbox", "Inbox triage", chrome, "email", 11),
    block("t_slack", "Slack messages", ("com.tinyspeck.slackmacgap", "Slack"), "chat", 11),
    block("t_sprint", "Spreadsheet updates: Sprint tracker", chrome, "sheet", 9),
    block("t_calendar", "Calendar checks", chrome, "meeting", 4),
  ]

  /// The mock client's answer (s22 present).
  static var breakdown: TimeBreakdown { make(weekBlocks, weekFindings, days: days, kind: .week, fixKinds: true) }
  /// One day (Wed 14 Oct).
  static var day: TimeBreakdown { make(dayBlocks, weekFindings, days: ["2026-10-14"], kind: .day, fixKinds: true) }
  /// The same week without the solution designer: no fix kinds, hours from the s04 estimate, capped.
  static var noFix: TimeBreakdown {
    make(weekBlocks, [FindingSpec(taskId: "t_metrics", fixKind: nil, estimate: 1.2), FindingSpec(taskId: "t_replies", fixKind: nil, estimate: 0.9),
                      FindingSpec(taskId: "t_sprint", fixKind: nil, estimate: 0.6), FindingSpec(taskId: "t_inbox", fixKind: nil, estimate: 0.7)],
         days: days, kind: .week, fixKinds: false)
  }

  static func eventIds(_ b: Block) -> [String] {
    let n = max(1, Int(b.minutes / 6))
    return (0..<n).map { "ev_\(b.taskId.dropFirst(2))_\($0)" }
  }

  private static func minutesMetric(_ minutes: Double, _ ids: [String]) -> TimeMetric {
    TimeMetric(value: minutes, unit: "minutes", display: HoursFormat.display(minutes: minutes), eventIds: Array(Set(ids)).sorted())
  }

  private static func rows(_ blocks: [Block], total: Double, key: (Block) -> String, name: (Block) -> String) -> [TimeRow] {
    var order: [String] = []
    var groups: [String: [Block]] = [:]
    for b in blocks {
      let k = key(b)
      if groups[k] == nil { order.append(k) }
      groups[k, default: []].append(b)
    }
    return order.map { k in
      let list = groups[k]!
      let minutes = list.reduce(0) { $0 + $1.minutes }
      return TimeRow(id: k, name: name(list[0]), minutes: minutesMetric(minutes, list.flatMap(eventIds)),
                     share: total > 0 ? minutes / total : 0, spanIds: list.map { "sp_\($0.taskId.dropFirst(2))" })
    }
    .sorted { $0.minutes.value != $1.minutes.value ? $0.minutes.value > $1.minutes.value : $0.id < $1.id }
  }

  /// The s04 low case's freed share on these sample tasks (review 1.5x slower, 10% of items by hand).
  static let lowPct = 0.8

  static func make(_ blocks: [Block], _ specs: [FindingSpec], days: [String], kind: TimeBreakdown.WindowKind, fixKinds: Bool) -> TimeBreakdown {
    let total = blocks.reduce(0) { $0 + $1.minutes }
    let kindName = Dictionary(uniqueKeysWithValues: kindNames)
    let byTask = rows(blocks, total: total, key: \.taskId, name: \.task)
    let byApp = rows(blocks, total: total, key: \.app, name: \.appName)
    let byKind = rows(blocks, total: total, key: \.kind, name: { kindName[$0.kind] ?? $0.kind })
    let taskRow = Dictionary(uniqueKeysWithValues: byTask.map { ($0.id, $0) })
    let windowDays = Double(max(1, days.count))
    var findings: [TimeFinding] = specs.compactMap { s in
      guard let row = taskRow[s.taskId] else { return nil }
      let observed = row.minutes.value / 60 * 7 / windowDays
      // The brain's honest-savings rule (brain/src/time/breakdown.ts honestFreed): the person keeps the s04 low case's
      // share for checking (about a fifth on these tasks), and freed always shows below observed.
      let obsT = HoursFormat.tenths(hours: observed)
      var freed = min(observed * lowPct, max(0, s.estimate))
      if HoursFormat.tenths(hours: freed) >= obsT { freed = Double(max(0, obsT - 1)) / 10 }
      let capped = max(0, s.estimate) > freed + 1e-9
      let leftT = max(0, obsT - HoursFormat.tenths(hours: freed))
      let ids = row.minutes.eventIds
      let o = TimeMetric(value: observed, unit: "hours_per_week", display: HoursFormat.display(hours: observed), eventIds: ids)
      let h = TimeMetric(value: freed, unit: "hours_per_week", display: HoursFormat.display(hours: freed), eventIds: ids)
      let n = Int(windowDays)
      let source = fixKinds ? "the best fix" : "the estimate"
      let now = n == 7 ? "\(o.display) a week now"
        : "\(row.minutes.display) on this day, \(o.display) a week if every day were like this"
      let cap = capped ? " · \(source) says \(HoursFormat.display(hours: s.estimate)), capped to leave the checking" : ""
      let arithmetic = "\(now) · about \(leftT / 10).\(leftT % 10) h \(capped ? "left for checking" : "still yours")\(cap) · frees \(h.display)"
      let fix = fixKinds ? s.fixKind : nil
      return TimeFinding(id: "tf_\(s.taskId.dropFirst(2))", taskId: s.taskId, insightId: "ins_\(s.taskId.dropFirst(2))", name: row.name,
                         taskMinutes: row.minutes, observedHoursPerWeek: o, hoursFreed: h, arithmetic: arithmetic, fixKind: fix,
                         workflowInsightId: fix == nil || fix == .workflow ? "ins_\(s.taskId.dropFirst(2))" : nil)
    }
    findings.sort { $0.hoursFreed.value > $1.hoursFreed.value }
    return TimeBreakdown(window: .init(kind: kind, days: days), total: minutesMetric(total, blocks.flatMap(eventIds)),
                         byTask: byTask, byApp: byApp, byKind: byKind, findings: findings, fixKinds: fixKinds ? "s22" : "absent")
  }
}
