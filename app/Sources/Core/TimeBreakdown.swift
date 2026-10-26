import Foundation

// s23: where your time goes (GET /time, brain/API.md "GET /time"). The brain computes every number (ADR 0005); the
// app prints the brain's displays and lays them out in the order of the product: the breakdown first, then what could
// be faster with the hours it frees, then the kind of fix, and workflows last, only as the answer to a finding.

/// The one rounding rule for hours, shared with the brain (brain/src/time/format.ts): tenths of an hour, half up,
/// with a 1e-9 guard so 24.65 h (24.6499… in binary) reads "24.7 h" as a person rounds it.
enum HoursFormat {
  static func tenths(hours: Double) -> Int { Int((hours * 10 + 0.5 + 1e-9).rounded(.down)) }

  /// "24.7 h"
  static func display(hours: Double) -> String {
    let t = tenths(hours: hours)
    let sign = t < 0 ? "-" : ""
    let a = abs(t)
    return "\(sign)\(a / 10).\(a % 10) h"
  }

  /// Minutes are shown as hours with the same rule.
  static func display(minutes: Double) -> String { display(hours: minutes / 60) }
}

/// The five kinds of fix the s22 solution designer ranks (wire names), with plain labels.
enum FixKind: String, CaseIterable, Codable, Sendable {
  case workflow, tool, setup
  case removeStep = "remove_step"
  case leaveAlone = "leave_alone"

  var label: String {
    switch self {
    case .workflow: return "Workflow"
    case .tool: return "Custom tool"
    case .setup: return "Setup change"
    case .removeStep: return "Remove the step"
    case .leaveAlone: return "Leave it alone"
    }
  }
}

struct TimeMetric: Codable, Equatable, Sendable {
  var value: Double
  var unit: String
  var display: String
  var eventIds: [String]
}

struct TimeRow: Codable, Equatable, Sendable, Identifiable {
  var id: String
  var name: String
  var minutes: TimeMetric
  var share: Double
  var spanIds: [String]
}

struct TimeFinding: Equatable, Sendable, Identifiable {
  var id: String
  var taskId: String
  var insightId: String
  var name: String
  var taskMinutes: TimeMetric
  var observedHoursPerWeek: TimeMetric
  var hoursFreed: TimeMetric
  var arithmetic: String
  /// nil when s22 is absent or the wire carried a kind outside the five (never guessed).
  var fixKind: FixKind?
  var workflowInsightId: String?
}

extension TimeFinding: Codable {
  private enum Keys: String, CodingKey {
    case id, taskId, insightId, name, taskMinutes, observedHoursPerWeek, hoursFreed, arithmetic, fixKind, workflowInsightId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    id = try c.decode(String.self, forKey: .id)
    taskId = try c.decode(String.self, forKey: .taskId)
    insightId = try c.decode(String.self, forKey: .insightId)
    name = try c.decode(String.self, forKey: .name)
    taskMinutes = try c.decode(TimeMetric.self, forKey: .taskMinutes)
    observedHoursPerWeek = try c.decode(TimeMetric.self, forKey: .observedHoursPerWeek)
    hoursFreed = try c.decode(TimeMetric.self, forKey: .hoursFreed)
    arithmetic = try c.decode(String.self, forKey: .arithmetic)
    fixKind = (try? c.decodeIfPresent(String.self, forKey: .fixKind)).flatMap { $0 }.flatMap(FixKind.init(rawValue:))
    workflowInsightId = try c.decodeIfPresent(String.self, forKey: .workflowInsightId)
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(taskId, forKey: .taskId)
    try c.encode(insightId, forKey: .insightId)
    try c.encode(name, forKey: .name)
    try c.encode(taskMinutes, forKey: .taskMinutes)
    try c.encode(observedHoursPerWeek, forKey: .observedHoursPerWeek)
    try c.encode(hoursFreed, forKey: .hoursFreed)
    try c.encode(arithmetic, forKey: .arithmetic)
    try c.encode(fixKind?.rawValue, forKey: .fixKind)
    try c.encode(workflowInsightId, forKey: .workflowInsightId)
  }
}

struct TimeBreakdown: Codable, Equatable, Sendable {
  enum WindowKind: String, Codable, Sendable { case week, day }
  struct Window: Codable, Equatable, Sendable {
    var kind: WindowKind
    var days: [String]
  }

  var window: Window
  var total: TimeMetric
  var byTask: [TimeRow]
  var byApp: [TimeRow]
  var byKind: [TimeRow]
  var findings: [TimeFinding]
  /// "s22" or "absent" on the wire.
  var fixKinds: String

  /// The s22 solution designer answered the fix kinds (else every finding is shown without one).
  var fixKindsAvailable: Bool { fixKinds == "s22" }

  static func decode(_ data: Data) throws -> TimeBreakdown { try JSONDecoder().decode(TimeBreakdown.self, from: data) }

  static let empty = TimeBreakdown(
    window: Window(kind: .week, days: []),
    total: TimeMetric(value: 0, unit: "minutes", display: HoursFormat.display(minutes: 0), eventIds: []),
    byTask: [], byApp: [], byKind: [], findings: [], fixKinds: "absent")
}

// MARK: the first screen

enum TimeSection: String, Equatable, Sendable { case breakdown, findings, workflows }

enum TimeDimension: String, CaseIterable, Identifiable, Sendable {
  case task, app, kind
  var id: String { rawValue }
  var title: String {
    switch self {
    case .task: return "By task"
    case .app: return "By app"
    case .kind: return "By kind of work"
    }
  }
  /// The short label on the dimension picker.
  var short: String {
    switch self {
    case .task: return "Task"
    case .app: return "App"
    case .kind: return "Kind of work"
    }
  }
}

/// What the "Your time" screen shows, in order, as plain strings. Every hour figure is the brain's own display.
struct TimeScreen: Equatable {
  struct Row: Equatable, Identifiable {
    var id: String
    var name: String
    /// The brain's display ("7.0 h").
    var hours: String
    /// 0…1, for the bar (never printed as a percentage).
    var share: Double
  }

  struct Finding: Equatable, Identifiable {
    enum Part: Equatable { case name, hours, fixKind }
    var id: String
    var taskId: String
    var insightId: String
    var name: String
    /// "Frees 1.2 h a week"
    var hoursLine: String
    /// The task's time in the window, the same digits as its row ("1.3 h").
    var taskHours: String
    /// "1.3 h this week" (or "on this day")
    var spentLine: String
    var arithmetic: String
    var fixLabel: String?
    var parts: [Part]
    var workflowInsightId: String?
    var allStrings: [String] { [name, hoursLine, taskHours, spentLine, arithmetic, fixLabel ?? ""] }
  }

  struct WorkflowAnswer: Equatable, Identifiable {
    var findingId: String
    var insightId: String
    var name: String
    var hoursLine: String
    var id: String { findingId }
  }

  let breakdown: TimeBreakdown
  let sections: [TimeSection]
  let dimensions: [TimeDimension] = TimeDimension.allCases
  let findings: [Finding]
  let workflows: [WorkflowAnswer]
  let totalLine: String
  let windowLine: String
  let emptyLine: String
  let noFindingsLine: String
  let fixKindsNote: String?

  static let title = "Your time"
  static let findingsTitle = "What could be faster"
  static let workflowsTitle = "Workflows that answer a finding"
  static let workflowsNote = "Only where a workflow is the right fix. Nothing is drafted until you open one."

  init(_ b: TimeBreakdown) {
    breakdown = b
    let isDay = b.window.kind == .day
    let empty = b.total.value <= 0 && b.byTask.isEmpty
    let rowHours = Dictionary(b.byTask.map { ($0.id, $0.minutes.display) }, uniquingKeysWith: { a, _ in a })
    findings = b.findings.map { f in
      let label = f.fixKind?.label
      return Finding(
        id: f.id, taskId: f.taskId, insightId: f.insightId, name: f.name,
        // A day's weekly figure is an extrapolation: say so (the arithmetic line spells it out).
        hoursLine: isDay ? "Frees \(f.hoursFreed.display) a week at this pace" : "Frees \(f.hoursFreed.display) a week",
        taskHours: rowHours[f.taskId] ?? f.taskMinutes.display,
        spentLine: "\(rowHours[f.taskId] ?? f.taskMinutes.display) \(isDay ? "on this day" : "this week")",
        arithmetic: f.arithmetic,
        fixLabel: label,
        parts: label == nil ? [.name, .hours] : [.name, .hours, .fixKind],
        workflowInsightId: f.workflowInsightId)
    }
    workflows = b.findings.compactMap { f in
      guard let insight = f.workflowInsightId, f.fixKind == nil || f.fixKind == .workflow else { return nil }
      return WorkflowAnswer(findingId: f.id, insightId: insight, name: f.name, hoursLine: "Frees \(f.hoursFreed.display) a week")
    }
    if empty { sections = [.breakdown] }
    else { sections = workflows.isEmpty ? [.breakdown, .findings] : [.breakdown, .findings, .workflows] }
    totalLine = isDay ? "\(b.total.display) tracked on this day" : "\(b.total.display) tracked this week"
    windowLine = Self.windowLine(b.window)
    emptyLine = "Nothing tracked yet. When Offload has watched a day of work, this shows where the time went."
    noFindingsLine = "Nothing here repeats enough to be worth changing yet."
    fixKindsNote = b.fixKindsAvailable || b.findings.isEmpty ? nil : "The best kind of fix shows here once the solution designer has run."
  }

  var qaSections: String { sections.map(\.rawValue).joined(separator: ",") }

  func rows(_ d: TimeDimension) -> [Row] {
    let source: [TimeRow]
    switch d {
    case .task: source = breakdown.byTask
    case .app: source = breakdown.byApp
    case .kind: source = breakdown.byKind
    }
    return source.map { Row(id: $0.id, name: $0.name, hours: $0.minutes.display, share: max(0, min(1, $0.share))) }
  }

  /// Every string the screen can show (tests read it for claims that must never appear).
  var allStrings: [String] {
    var out = [Self.title, totalLine, windowLine, Self.findingsTitle, noFindingsLine, emptyLine, fixKindsNote ?? ""]
    for d in dimensions { out.append(d.title); out += rows(d).flatMap { [$0.name, $0.hours] } }
    out += findings.flatMap(\.allStrings)
    if !workflows.isEmpty { out += [Self.workflowsTitle, Self.workflowsNote] + workflows.flatMap { [$0.name, $0.hoursLine] } }
    return out
  }

  /// "Week of 12 Oct" / "Wed 14 Oct" from the window's day labels (local dates, no clock).
  static func windowLine(_ w: TimeBreakdown.Window) -> String {
    guard let first = w.days.first, let d = dayDate(first) else { return "" }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    if w.kind == .day {
      f.dateFormat = "EEE d MMM"
      return f.string(from: d)
    }
    f.dateFormat = "d MMM"
    guard let lastLabel = w.days.last, let last = dayDate(lastLabel), last != d else { return "Week of \(f.string(from: d))" }
    return "\(f.string(from: d)) to \(f.string(from: last))"
  }

  static func dayDate(_ label: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: label)
  }

  /// "Mon", "Tue", … for the day picker.
  static func dayShort(_ label: String) -> String {
    guard let d = dayDate(label) else { return label }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "EEE"
    return f.string(from: d)
  }
}

// MARK: clients

extension BrainClient {
  func timeBreakdown(day: String?) async throws -> TimeBreakdown { throw BrainError.notFound("time") }
}

extension MockBrainClient {
  /// The neutral sample week (never the outreach SampleWeek); a day picks the sample day.
  func timeBreakdown(day: String?) async throws -> TimeBreakdown { day == nil ? NeutralWeek.breakdown : NeutralWeek.day }
}

extension HTTPBrainClient {
  /// GET /time, or GET /time?day=YYYY-MM-DD.
  func timeBreakdown(day: String?) async throws -> TimeBreakdown {
    try await call(TimeBreakdown.self, "GET", "time", query: day.map { [URLQueryItem(name: "day", value: $0)] } ?? [])
  }
}

// MARK: loads (PR #29 review)

/// The time page's loads: the selected day survives a reload, a failed load never leaves old numbers on screen, and
/// only the newest request's answer is shown (rapid Week / day clicks can answer out of order).
struct TimeLoads: Equatable {
  private(set) var time: TimeBreakdown?
  /// The day on screen (nil = the week).
  private(set) var day: String?
  private(set) var problem: String?
  /// The stored days of the week, for the day picker (kept while a day is shown).
  private(set) var weekDays: [String] = []
  private(set) var latest = 0
  private var requested: [Int: String?] = [:]

  /// What a reload asks for: the day on screen.
  var reloadDay: String? { day }

  /// A new request; its token is the newest.
  mutating func start(day: String?) -> Int {
    latest += 1
    requested[latest] = .some(day)
    return latest
  }

  /// The answer to request `token`: a breakdown, or the problem in plain words. False (and no change) when a newer
  /// request was made since.
  @discardableResult
  mutating func finish(_ token: Int, breakdown: TimeBreakdown?, problem: String?) -> Bool {
    let asked = requested.removeValue(forKey: token) ?? nil
    guard token == latest else { return false }
    if let b = breakdown {
      time = b
      day = b.window.kind == .day ? (b.window.days.first ?? asked) : nil
      if b.window.kind == .week { weekDays = b.window.days }
      self.problem = nil
    } else {
      time = nil
      self.problem = problem ?? "Your time could not be read."
    }
    return true
  }

  /// Snapshots: a fixed answer on screen.
  mutating func preview(_ b: TimeBreakdown, weekDays: [String]) {
    latest += 1
    time = b
    day = b.window.kind == .day ? b.window.days.first : nil
    self.weekDays = weekDays
    problem = nil
  }

  static func == (a: TimeLoads, b: TimeLoads) -> Bool {
    a.time == b.time && a.day == b.day && a.problem == b.problem && a.weekDays == b.weekDays && a.latest == b.latest
  }
}
