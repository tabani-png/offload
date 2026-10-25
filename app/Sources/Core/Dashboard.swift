import Foundation

// s08 dashboard: automations, honest hours saved, a 7-day timeline and the observer's state.

struct DashboardAutomation: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var workflowId: String?
  var insightId: String
  var name: String
  var state: WorkflowState
  var connectors: [Connector]
  var lastRunAt: Date?
  var nextRunAt: Date?
  var estimatedHoursPerWeek: Double
  /// null until a full day exists on both sides of activation (s05 AC-7).
  var measuredHoursPerWeek: Double?
  /// One line, present when state is needs_you: what is wrong and what fixes it.
  var needsYouReason: String?
  /// The brain task this automation took over (links timeline bars to it).
  var taskId: String?
  /// s10a: the brain's arithmetic behind the estimate, so the dashboard prints the same digits as the card.
  var arithmetic: String? = nil
  /// s10d: auto-send is on (the brain's WorkflowSummaryDTO autoRun), and how many people it covers.
  var autoRun: Bool = false
  var autoRunPeople: Int? = nil
  /// s10e: when it was turned on (the brain's workflow activatedAt), for the measured proof under the timeline.
  var activatedAt: Date? = nil
}

extension StatusRole {
  /// Blue = in flight, amber = needs you, green = healthy, grey = paused.
  static func forWorkflow(_ s: WorkflowState) -> StatusRole {
    switch s {
    case .drafting: return .working
    case .readyForReview, .needsYou: return .needsYou
    case .active: return .done
    case .paused: return .neutral
    }
  }
}

enum DashboardOrder {
  /// Needs-you first, then ready for review, then in flight, healthy, paused. Ties keep the brain's order.
  static func rank(_ s: WorkflowState) -> Int {
    switch s {
    case .needsYou: return 0
    case .readyForReview: return 1
    case .drafting: return 2
    case .active: return 3
    case .paused: return 4
    }
  }

  static func sorted(_ autos: [DashboardAutomation]) -> [DashboardAutomation] {
    autos.enumerated()
      .sorted { (rank($0.element.state), $0.offset) < (rank($1.element.state), $1.offset) }
      .map(\.element)
  }
}

/// The hero number, said honestly: measured when the brain has measured it, otherwise estimated and labelled so.
struct HoursSaved: Codable, Equatable, Sendable {
  var estimated: Double
  var measured: Double?

  var heroValue: Double { measured ?? estimated }
  var isMeasured: Bool { measured != nil }

  /// "measured" / "estimated", next to the number.
  var heroQualifier: String { isMeasured ? "measured" : "estimated" }

  /// The second line: the other number, or why there is no measured one yet.
  var detail: String {
    if measured != nil { return "\(Format.hours(estimated)) estimated" }
    return "Not measured yet. That takes a full day on each side of turning it on."
  }

  /// One sentence for VoiceOver.
  var accessibilityLabel: String {
    if let m = measured { return "\(Format.hours(m)) saved this week, measured. \(Format.hours(estimated)) estimated." }
    return "\(Format.hours(estimated)) saved this week, estimated. Not measured yet."
  }
}

/// The three macOS permissions the observer uses (engine/README.md "Permissions"). There is no microphone row:
/// no shipped feature records audio.
enum PermissionKind: String, Codable, CaseIterable, Sendable {
  case screenRecording, accessibility, inputMonitoring

  var name: String {
    switch self {
    case .screenRecording: return "Screen Recording"
    case .accessibility: return "Accessibility"
    case .inputMonitoring: return "Input Monitoring"
    }
  }

  /// What it is for, in one line.
  var purpose: String {
    switch self {
    case .screenRecording: return "Reads on-screen text, to tell one email from another"
    case .accessibility: return "Window titles and browser addresses"
    case .inputMonitoring: return "Counts keys and clicks, never which ones"
    }
  }

  /// Screen text is the core signal and titles name the work; counts only sharpen the estimate.
  var required: Bool { self != .inputMonitoring }

  /// s10a: what onboarding calls it. Offload still runs without any of them (Continue is never blocked), so none is
  /// labelled "Required": Screen Recording is what insights need, Accessibility sharpens them, counts are optional.
  var importance: String {
    switch self {
    case .screenRecording: return "Needed for insights"
    case .accessibility: return "Recommended"
    case .inputMonitoring: return "Optional"
    }
  }

  /// System Settings > Privacy & Security, the right pane.
  var settingsURL: URL {
    let anchor: String
    switch self {
    case .screenRecording: anchor = "Privacy_ScreenCapture"
    case .accessibility: anchor = "Privacy_Accessibility"
    case .inputMonitoring: anchor = "Privacy_ListenEvent"
    }
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
  }
}

struct PermissionState: Codable, Equatable, Identifiable, Sendable {
  enum Grant: String, Codable, Sendable {
    case granted, notGranted = "not_granted", notNeeded = "not_needed"
    /// The observer could not be asked (not installed, or it failed).
    case unknown
  }
  var name: String
  var grant: Grant
  /// Optional permissions never ask for attention when off.
  var required: Bool = true
  /// Set for the observer's three permissions: purpose line and the Open Settings link.
  var kind: PermissionKind? = nil
  var id: String { name }

  init(name: String, grant: Grant, required: Bool = true, kind: PermissionKind? = nil) {
    self.name = name
    self.grant = grant
    self.required = required
    self.kind = kind
  }

  init(_ kind: PermissionKind, granted: Bool?) {
    self.init(name: kind.name, grant: granted.map { $0 ? .granted : .notGranted } ?? .unknown,
              required: kind.required, kind: kind)
  }

  /// Amber only when something Offload needs is missing.
  var role: StatusRole {
    switch grant {
    case .granted: return .done
    case .notGranted: return required ? .needsYou : .neutral
    case .notNeeded, .unknown: return .neutral
    }
  }

  var label: String {
    switch grant {
    case .granted: return "Allowed"
    case .notGranted: return required ? "Not allowed" : "Off, optional"
    case .notNeeded: return "Not needed"
    case .unknown: return "Unknown"
    }
  }

  var purpose: String { kind?.purpose ?? "" }
  var settingsURL: URL? { kind?.settingsURL }
  /// The row offers Open Settings unless it is already allowed.
  var offersSettings: Bool { kind != nil && grant != .granted }
}

/// The "Observing" section: what is stored, when the oldest day goes, and permissions.
struct ObservingState: Codable, Equatable, Sendable {
  var state: ObserverState
  var daysStored: Int
  var keepDays: Int
  var nextPurgeDay: String?
  var nextPurgeAt: Date?
  var permissions: [PermissionState]

  var daysLabel: String { "\(min(daysStored, keepDays)) of \(keepDays) days stored" }

  var stateLabel: String {
    switch state {
    case .watching: return "Watching"
    case .paused: return "Paused"
    case .stale: return "Not recording"
    case .noData: return "No data yet"
    }
  }

  /// "Sat 17 Oct is deleted at midnight tonight" / "… on Sun 25 Oct at 00:00".
  func purgeLabel(now: Date, calendar: Calendar = .current) -> String {
    guard let day = nextPurgeDay, let at = nextPurgeAt, let date = Self.parseDay(day, calendar: calendar) else {
      return "Nothing stored yet"
    }
    let name = Format.dayMonth(date, calendar: calendar)
    let start = calendar.startOfDay(for: now)
    let atDay = calendar.startOfDay(for: at)
    let days = calendar.dateComponents([.day], from: start, to: atDay).day ?? 0
    if days <= 1 && calendar.component(.hour, from: at) == 0 && calendar.component(.minute, from: at) == 0 {
      return days <= 0 ? "\(name) is deleted now" : "\(name) is deleted at midnight tonight"
    }
    return "\(name) is deleted \(Format.dayMonth(at, calendar: calendar)) at \(Format.clock(at, calendar: calendar))"
  }

  static func parseDay(_ s: String, calendar: Calendar) -> Date? {
    let parts = s.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
  }
}

// MARK: timeline

/// A task on the timeline, with a tint index (not a status colour) and whether Offload now does it.
struct TimelineTask: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var name: String
  var tint: Int
  var automated: Bool
}

struct TimelineBar: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var taskId: String
  var start: Date
  var end: Date
  /// True when Offload did this span (a run), drawn hatched. False is you, by hand.
  var automated: Bool
  var title: String
  var counterparty: String?
  /// s10e: the brain's active minutes for this span (GET /timeline). The chart draws this length, so the bars add up
  /// to the minutes every figure is computed from.
  var activeMinutes: Double? = nil
  /// s10e: the spans a drawn (packed) bar stands for.
  var members: [String]? = nil

  /// What the chart draws: active minutes when the brain sent them, else the wall-clock span.
  var drawnMinutes: Double { activeMinutes ?? end.timeIntervalSince(start) / 60 }
}

struct TimelineDay: Codable, Equatable, Identifiable, Sendable {
  var day: String
  var date: Date
  var bars: [TimelineBar]
  /// The brain's active minutes for the day (GET /timeline activeMinutes), when it sent them.
  var trackedMinutes: Double? = nil
  var id: String { day }
  var activeMinutes: Double { bars.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) / 60 } }
}

/// Maps clock time to a 0...1 x position. One window for all seven rows, so the days line up.
struct TimelineLayout: Equatable, Sendable {
  var startHour: Int
  var endHour: Int

  static let defaultWindow = TimelineLayout(startHour: 8, endHour: 19)
  /// Bars narrower than this (fraction of the row) are widened to it so a 1-minute span is still visible.
  static let minWidth = 0.004

  /// Fits the earliest start and latest end across days, whole hours, never narrower than 8:00–19:00 shown
  /// when there is data inside it, and never wider than the day.
  static func fitting(_ days: [TimelineDay], calendar: Calendar = .current) -> TimelineLayout {
    var lo = defaultWindow.startHour, hi = defaultWindow.endHour
    for d in days {
      for b in d.bars {
        let sh = calendar.component(.hour, from: b.start)
        let endComps = calendar.dateComponents([.hour, .minute], from: b.end)
        let eh = (endComps.hour ?? 0) + ((endComps.minute ?? 0) > 0 ? 1 : 0)
        lo = min(lo, sh)
        if calendar.isDate(b.end, inSameDayAs: b.start) { hi = max(hi, eh) } else { hi = 24 }
      }
    }
    return TimelineLayout(startHour: max(0, lo), endHour: min(24, max(hi, lo + 1)))
  }

  var hours: [Int] { Array(startHour...endHour) }

  /// x of a moment within its own day, clamped to 0...1.
  func fraction(_ t: Date, dayStart: Date) -> Double {
    let span = Double(endHour - startHour) * 3600
    let x = (t.timeIntervalSince(dayStart) - Double(startHour) * 3600) / span
    return min(1, max(0, x))
  }

  /// Leading x and width of a bar, both 0...1, with the minimum width applied and kept inside the row.
  func extent(_ bar: TimelineBar, dayStart: Date) -> (x: Double, width: Double) {
    let x0 = fraction(bar.start, dayStart: dayStart)
    let x1 = fraction(bar.end, dayStart: dayStart)
    let w = max(Self.minWidth, x1 - x0)
    return (min(x0, 1 - w), w)
  }
}

enum DashboardKey: Equatable, Sendable {
  case next, previous, point, open, evidence, escape
  /// s10e: W switches the timeline between the week before Offload and this week.
  case week

  init?(characters: String, keyCode: UInt16, command: Bool) {
    if command { return nil }
    if keyCode == ReviewKey.escapeKeyCode { self = .escape; return }
    if ReviewKey.returnKeyCodes.contains(keyCode) { self = .open; return }
    switch characters.lowercased() {
    case "j": self = .next
    case "k": self = .previous
    case "p": self = .point
    case "2": self = .evidence
    case "w": self = .week
    default: return nil
    }
  }
}

/// J/K selection over the automation rows; starts on the first row, which is a needs-you row when there is one.
struct DashboardSelection: Equatable, Sendable {
  private(set) var ids: [String]
  private(set) var index: Int = 0

  init(_ autos: [DashboardAutomation]) { ids = DashboardOrder.sorted(autos).map(\.id) }

  var selectedId: String? { ids.indices.contains(index) ? ids[index] : nil }

  mutating func move(_ key: DashboardKey) {
    switch key {
    case .next: index = min(index + 1, max(0, ids.count - 1))
    case .previous: index = max(index - 1, 0)
    default: break
    }
  }

  mutating func select(_ id: String) { if let i = ids.firstIndex(of: id) { index = i } }
}

extension Format {
  private static func formatter(_ pattern: String, _ calendar: Calendar) -> DateFormatter {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = calendar
    f.timeZone = calendar.timeZone
    f.dateFormat = pattern
    return f
  }

  /// "09:14"
  static func clock(_ d: Date, calendar: Calendar = .current) -> String { formatter("HH:mm", calendar).string(from: d) }

  /// "Sat 17 Oct"
  static func dayMonth(_ d: Date, calendar: Calendar = .current) -> String { formatter("EEE d MMM", calendar).string(from: d) }

  /// "Mon 09:14"
  static func weekdayClock(_ d: Date, calendar: Calendar = .current) -> String { formatter("EEE HH:mm", calendar).string(from: d) }

  /// "Mon 19"
  static func dayShort(_ d: Date, calendar: Calendar = .current) -> String { formatter("EEE d", calendar).string(from: d) }

  /// "Today 09:02", "Yesterday 17:40", "Tomorrow 09:00", else "Mon 09:00". nil reads "Never" or "Not scheduled".
  static func runTime(_ d: Date?, now: Date, past: Bool, calendar: Calendar = .current) -> String {
    guard let d else { return past ? "Never" : "Not scheduled" }
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: d)).day ?? 0
    let time = clock(d, calendar: calendar)
    switch days {
    case 0: return "Today \(time)"
    case -1: return "Yesterday \(time)"
    case 1: return "Tomorrow \(time)"
    default: return "\(formatter("EEE", calendar).string(from: d)) \(time)"
    }
  }

  /// "3.1 min → 20 s review" for a dry-run item.
  static func reviewTime(observedMinutes: Double, reviewSeconds: Double) -> String {
    "\(decimal(observedMinutes)) min by hand → \(Int(reviewSeconds.rounded())) s to review"
  }

  /// "21.9 h a week"
  static func perWeek(_ h: Double) -> String { "\(hours(h)) a week" }
}

// MARK: s10d sections

/// The dashboard's sidebar: four places, the way a first-party Mac app splits an overview from its detail.
enum DashboardSection: String, CaseIterable, Identifiable, Sendable {
  case overview, automations, week, observing

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: return "Overview"
    case .automations: return "Automations"
    case .week: return "This week"
    case .observing: return "Observing"
    }
  }

  var symbol: String {
    switch self {
    case .overview: return "square.grid.2x2"
    case .automations: return "arrow.triangle.2.circlepath"
    case .week: return "calendar"
    case .observing: return "eye"
    }
  }

  /// ⌘1…⌘4
  var shortcut: String { "⌘\((Self.allCases.firstIndex(of: self) ?? 0) + 1)" }

  static func forShortcut(_ digit: Int) -> DashboardSection? {
    allCases.indices.contains(digit - 1) ? allCases[digit - 1] : nil
  }
}

/// What the observer row offers, from its state and the permissions (s10d: never "Pause" when it is not recording).
enum ObserverAction: Equatable, Sendable {
  case pause, resume, openSettings(URL)

  var title: String {
    switch self {
    case .pause: return "Pause watching"
    case .resume: return "Resume watching"
    case .openSettings: return "Open Settings"
    }
  }

  static func forState(_ s: ObserverState, permissions: [PermissionState]) -> ObserverAction {
    switch s {
    case .watching: return .pause
    case .paused: return .resume
    case .stale, .noData:
      // Not recording: a missing Screen Recording grant is the usual reason, and Settings is what fixes it.
      if let p = permissions.first(where: { $0.kind == .screenRecording && $0.grant == .notGranted }), let url = p.settingsURL {
        return .openSettings(url)
      }
      return .resume
    }
  }
}

/// s10d: where the dashboard pointer goes for a row, and what it says. Plain words ("Sign in to HubSpot here").
enum DashboardPointer {
  /// Where P on a row points: the first connector that is not ready, else the reason line.
  static func target(for a: DashboardAutomation) -> (id: String, label: String) {
    if let c = a.connectors.first(where: { $0.state != .connected }) {
      let verb = c.state == .missingEnv ? "Sign in to \(c.name) here" : "Connect \(c.name) here"
      return ("conn.\(a.id).\(c.id)", a.state == .needsYou ? verb : "\(verb) before it can run")
    }
    if a.state == .readyForReview { return ("row.\(a.id)", "Press ↩ to review it") }
    return ("row.\(a.id)", a.needsYouReason ?? a.name)
  }

}
