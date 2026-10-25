import Foundation

// s10a presenters: every string the card, the review window (with its confirm sheet) and the dashboard show,
// built from the brain's values through Figures and PlainWords. Views lay these out and never format a figure
// themselves, so a test can render all three from one fixture and compare what a person would read.

// MARK: card

struct CardCopy: Equatable, Sendable {
  var title: String
  var facts: String
  var savingChip: String?
  var arithmetic: [ArithmeticStep]
  var range: String
  var usesLabel = "Uses"

  init(_ i: Insight) {
    let phrase = i.taskPhrase.prefix(1).uppercased() + i.taskPhrase.dropFirst()
    let last = i.taskPhrase.split(separator: " ").last.map(String.init) ?? ""
    let plural = last.hasSuffix("s") && !last.hasSuffix("ss")
    // s10d: a headline says a whole percent ("64%"); the decimals live in the receipt and the evidence.
    title = "\(phrase) \(plural ? "take" : "takes") \(Figures.wholeShare(display: i.shareDisplay, value: i.timeShare)) of your week"
    let median = i.medianDisplay ?? String(format: "%.1f min", locale: Locale(identifier: "en_US_POSIX"), i.medianMinutes)
    facts = "\(Figures.count(i.instanceCount, i.unitPlural)) this week, about \(median) each"
    savingChip = Figures.saves(value: i.saving.hoursPerWeek, arithmetic: i.saving.arithmetic)
      ?? "Saves \(Figures.range(low: i.saving.hoursPerWeekLow, high: i.saving.hoursPerWeekHigh))"
    arithmetic = (i.saving.arithmetic.map(Figures.arithmeticSteps) ?? []).map { Self.wholeCounts($0, i) }
    range = "Likely \(Figures.range(low: i.saving.hoursPerWeekLow, high: i.saving.hoursPerWeekHigh)), depending on review time"
  }

  var allStrings: [String] { [title, facts, savingChip ?? "", range] + arithmetic.flatMap { [$0.label, $0.text] } }

  /// s10d: "98.4/day × 5 days × 3.0 min" reads as a computer talking (a fractional email). When the instance count
  /// times the median gives the very hours the brain printed, the "By hand" line says that instead:
  /// "492 emails × 3.0 min". The result digits stay the brain's; otherwise the brain's formula is kept as sent.
  static func wholeCounts(_ step: ArithmeticStep, _ i: Insight) -> ArithmeticStep {
    guard step.label == "By hand", step.formula.contains("/day"),
          let printed = Double(step.result.split(separator: " ").first ?? "") else { return step }
    // The brain's arithmetic uses the median as it printed it ("3.0 min"), so the tie is checked with that.
    let printedMedian = i.medianDisplay.flatMap { Double($0.split(separator: " ").first ?? "") } ?? i.medianMinutes
    let hours = Double(i.instanceCount) * printedMedian / 60
    guard abs(hours - printed) <= 0.05 + 1e-9 else { return step }
    var s = step
    let median = i.medianDisplay ?? String(format: "%.1f min", locale: Locale(identifier: "en_US_POSIX"), i.medianMinutes)
    s.formula = "\(Figures.count(i.instanceCount, i.unitPlural)) × \(median)"
    s.text = "\(s.formula) = \(step.result) a week"
    return s
  }
}

/// s10d: a two-line headline broken where both lines come out closest in width, so no word is left alone on the
/// second line. `measure` gives a string's width in points (NSFont in the app, character counts in tests).
enum BalancedWrap {
  static func lines(_ text: String, width: Double, measure: (String) -> Double) -> [String] {
    guard measure(text) > width else { return [text] }
    let words = text.split(separator: " ").map(String.init)
    guard words.count > 1 else { return [text] }
    var best: (Double, [String])?
    for k in 1..<words.count {
      let a = words[..<k].joined(separator: " "), b = words[k...].joined(separator: " ")
      let worst = max(measure(a), measure(b))
      guard measure(a) <= width, measure(b) <= width else { continue }
      if best == nil || worst < best!.0 { best = (worst, [a, b]) }
    }
    return best?.1 ?? [text]
  }
}

/// The evidence list under the card: one row per span in the app the task lives in, aligned columns.
struct EvidenceCopy: Equatable, Sendable {
  struct Row: Equatable, Sendable, Identifiable {
    var id: String
    var time: String
    var who: String?
    var subject: String
    var duration: String
  }
  var header: String
  var trailing: String
  var rows: [Row]
  var elsewhere: String?

  init(spans: [EvidenceSpan], insight: Insight) {
    let app = Self.usualApp(spans)
    let inApp = spans.filter { Self.appName($0) == app }
    let others = spans.filter { Self.appName($0) != app }
    header = app.map { "Recent \(insight.unitPlural) in \($0)" } ?? "Recent \(insight.unitPlural)"
    trailing = "\(inApp.count) of \(Format.count(insight.instanceCount))"
    rows = inApp.map { s in
      let t = EvidenceTitle.make(title: s.title, counterparty: s.counterparty)
      // s10e: the measured time of each email, not a rounded average ("3 min 12 s").
      return Row(id: s.id, time: Format.spanTime(s), who: t.lead, subject: t.subject, duration: Format.spanDurationPrecise(s))
    }
    if others.isEmpty {
      elsewhere = nil
    } else {
      let names = Array(Set(others.map(Self.appName))).sorted()
      let sessions = others.count == 1 ? "1 session" : "\(others.count) sessions"
      elsewhere = "Plus \(sessions) in \(names.joined(separator: " and ")) that \(others.count == 1 ? "was" : "were") part of this task"
    }
  }

  /// The name a person knows: Gmail, not "Chrome" with mail.google.com.
  static func appName(_ s: EvidenceSpan) -> String {
    switch s.urlHost {
    case "mail.google.com": return "Gmail"
    case "calendar.google.com": return "Google Calendar"
    case "docs.google.com": return "Google Docs"
    case "app.hubspot.com": return "HubSpot"
    case "www.linkedin.com", "linkedin.com": return "LinkedIn"
    default: return s.app
    }
  }

  static func usualApp(_ spans: [EvidenceSpan]) -> String? {
    var counts: [String: Int] = [:]
    for s in spans { counts[appName(s), default: 0] += 1 }
    return spans.map(appName).first { counts[$0] == counts.values.max() }
  }

  var allStrings: [String] { [header, trailing, elsewhere ?? ""] + rows.flatMap { [$0.time, $0.who ?? "", $0.subject, $0.duration] } }
}

/// The undo strip: what lands, and when.
enum UndoCopy {
  static func message(_ a: PendingAction, seconds: Int) -> String {
    switch a {
    case .build: return "Drafting the workflow in \(seconds)s"
    case .notNow: return "Snoozing until tomorrow in \(seconds)s"
    case .dismiss: return "Dismissing in \(seconds)s"
    }
  }
}

// MARK: review

struct ReviewCopy: Equatable, Sendable {
  struct Step: Equatable, Sendable, Identifiable {
    var id: String
    var number: String
    var title: String
    var detail: String
    /// Where it runs: the connector, with its state in words when it is not ready, or "On this Mac".
    var place: String
    var placeNeedsYou: Bool
    var isGate: Bool
  }

  struct Item: Equatable, Sendable, Identifiable {
    var id: String
    var who: String
    var subject: String
    var time: String
    var saved: String
    var theirsTitle: String
    /// s10d: numbers and dates in the draft that are in neither what you sent nor your facts.
    var unsupported: [String] = []
    var check: String? {
      guard !unsupported.isEmpty else { return nil }
      let quoted = unsupported.map { "“\($0)”" }
      let list = quoted.count == 1 ? quoted[0] : quoted.dropLast().joined(separator: ", ") + " and " + quoted.last!
      return "Check \(list): not in what you sent or in your facts."
    }
  }

  var status: String
  var title: String
  var summary: String
  var savingChip: String?
  var schedule: String
  var stepsTitle = "Steps"
  var stepsTrailing: String
  var steps: [Step]
  var dryRunTitle: String
  var dryRunTrailing: String
  var sampleChip: String?
  var oursTitle: String
  var diffNote: String
  var items: [Item]
  var emptyDryRun: String

  init(workflow w: Workflow, dryRun: DryRun?, running: Bool = false) {
    status = w.state.label
    title = w.name
    summary = PlainWords.clean(w.summary)
    savingChip = Figures.saves(value: w.estimatedHoursPerWeek, arithmetic: w.arithmetic.isEmpty ? nil : w.arithmetic)
    schedule = ScheduleCopy.line(summary: w.schedule.summary, batchSize: w.schedule.batchSize)
    let gates = w.steps.filter(\.isGate).count
    stepsTrailing = "\(w.steps.count) steps" + (gates > 0 ? " · you approve each batch" : "")
    steps = w.steps.enumerated().map { i, s in
      let c = s.connectorId.flatMap { id in w.connectors.first { $0.id == id } }
      let place: String
      var problem = false
      if s.isGate {
        place = "You"
      } else if let c {
        switch c.state {
        case .connected: place = c.name
        case .missingEnv: place = "\(c.name), signed out"; problem = true
        case .missing: place = "\(c.name), not connected"; problem = true
        }
      } else {
        place = "On this Mac"
      }
      var detail = PlainWords.clean(s.detail)
      // s10d: the right column already says "On this Mac"; the description does not say it again.
      if place == "On this Mac" {
        for dup in ["Runs on this Mac.", "Runs on this Mac", "on this Mac."] where detail.hasSuffix(dup) {
          detail = String(detail.dropLast(dup.count)).trimmingCharacters(in: .whitespaces)
          if !detail.isEmpty && !detail.hasSuffix(".") { detail += "." }
          break
        }
      }
      return Step(id: s.id, number: "\(i + 1)", title: PlainWords.clean(s.title), detail: detail,
                  place: place, placeNeedsYou: problem, isGate: s.isGate)
    }
    let sample = dryRun?.isSample == true
    dryRunTitle = "Dry run"
    sampleChip = sample ? "Sample drafts" : nil
    oursTitle = sample ? "Sample draft" : "Our draft"
    diffNote = "Highlighted: words in the draft that your own version did not use."
    if let d = dryRun {
      let n = d.items.count
      // s10e: any task, not only email: the dry run re-does real examples of what you did.
      let what = n == 1 ? "1 real example from last week" : "\(n) real examples from last week"
      dryRunTrailing = "\(what) · ran \(Format.clock(d.ranAt)) · nothing was sent"
    } else {
      dryRunTrailing = running ? "Re-doing last week's real examples…" : ""
    }
    emptyDryRun = running ? "Re-doing last week's real examples…" : "No dry run yet. Press R to run one."
    items = (dryRun?.items ?? []).map {
      Item(id: $0.id, who: $0.recipient.display, subject: Self.subject($0.subject, org: $0.recipient.org),
           time: Figures.itemTime(observedMinutes: $0.observedMinutes, reviewSeconds: $0.reviewSeconds),
           saved: Figures.minutesSaved($0.minutesSaved),
           theirsTitle: "What you sent · \(Format.weekdayClock($0.sentAt))",
           unsupported: FactCheck.unsupported(draft: $0.ourDraft, source: $0.whatYouSent, facts: w.facts))
    }
  }

  /// s10d: "Offload seed round: Bessemer Venture Partners" under "Sven, Bessemer Venture Partners" says the fund
  /// twice. The subject drops a trailing ": <org>" (or " - <org>") when the org is already on the line.
  static func subject(_ s: String, org: String) -> String {
    guard !org.isEmpty else { return s }
    for sep in [": ", " - ", " · ", ", "] where s.hasSuffix(sep + org) {
      return String(s.dropLast(sep.count + org.count))
    }
    return s
  }

  var allStrings: [String] {
    [status, title, summary, savingChip ?? "", schedule, stepsTitle, stepsTrailing, dryRunTitle, dryRunTrailing,
     sampleChip ?? "", oursTitle, diffNote, emptyDryRun]
      + steps.flatMap { [$0.number, $0.title, $0.detail, $0.place] }
      + items.flatMap { [$0.who, $0.subject, $0.time, $0.saved, $0.theirsTitle, $0.check ?? ""] }
  }
}

/// The confirm sheet: exactly what the first run does, who gets an email, and what is not ready yet.
struct ConfirmCopy: Equatable, Sendable {
  struct Line: Equatable, Sendable { var symbol: String; var text: String }
  struct Person: Equatable, Sendable, Identifiable { var id: String; var name: String; var org: String; var email: String }

  var title: String
  var subtitle: String
  var headline: String
  var pendingNote: String?
  var people: [Person]
  var lines: [Line]
  var blockers: [String]
  var canTurnOn: Bool
  var connectTitle: String?
  var blockedReason: String?
  var footnote = "Pause it any time from the dashboard."
  var turnOnTitle = "Turn on"

  init(plan: FirstRunPlan, now: Date) {
    title = "Turn on \(plan.workflowName)?"
    subtitle = ScheduleCopy.confirm(summary: plan.schedule, batchSize: plan.batchSize, firstRunAt: plan.firstRunAt, now: now)
    headline = plan.headline
    pendingNote = plan.pendingNote
    people = plan.recipients.map { Person(id: $0.email, name: $0.name, org: $0.org, email: $0.email) }
    let symbols = ["pencil.line", "checkmark.circle", "paperplane", "list.bullet.rectangle"]
    let steps = plan.steps.map(PlainWords.clean)
    lines = steps.enumerated().map { i, s in
      // The approval line only exists when there is a gate; keep symbols in step with the text.
      let k = plan.gated ? i : (i == 0 ? 0 : i + 1)
      return Line(symbol: symbols[min(k, symbols.count - 1)], text: s)
    }
    blockers = plan.blockers.map(PlainWords.clean)
    canTurnOn = plan.canTurnOn
    connectTitle = plan.connectTitle
    blockedReason = plan.turnOnBlockedReason
  }

  var allStrings: [String] {
    [title, subtitle, headline, pendingNote ?? "", footnote, turnOnTitle, connectTitle ?? "", blockedReason ?? ""]
      + people.flatMap { [$0.name, $0.org, $0.email] } + lines.map(\.text) + blockers
  }
}

// MARK: s10e empty states and short copy

enum InboxEmptyCopy {
  /// Under "Nothing to decide.": after the learning week says the week is done, not just "still watching".
  static func message(daysStored: Int, windowDays: Int) -> String {
    daysStored >= windowDays
      ? "Week 1 done. Nothing repeated enough yet.\nStill watching."
      : "Still watching. Offload speaks up\nwhen a task starts to repeat."
  }
}

enum AutomationsEmptyCopy {
  static let title = "No automations yet."
  static let message = "Approve a workflow from the inbox and it shows up here\nwith the hours it saves."
  static let action = "Open the inbox"
}

enum KeptFileCopy {
  static let footnote = "Who auto-send may write to. Yours to edit."
  static let section = "Kept until you delete them"
  static let footer = "What Offload saw is deleted after 7 days. Files you gave it stay."
}

// MARK: dashboard

struct DashboardCopy: Equatable, Sendable {
  struct Count: Equatable, Sendable, Identifiable {
    var id: String { label }
    var n: Int
    var label: String
    var role: StatusRole
  }

  struct Row: Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var chip: String?
    var chipNeedsYou: Bool
    var reason: String?
    var lastRun: String
    var nextRun: String
    var saved: String
    var savedQualifier: String
  }

  var heroTitle = "Time saved"
  /// Present only when the brain has measured it.
  var heroValue: String?
  var heroQualifier: String?
  var heroPlaceholder: String?
  var heroDetail: String
  /// s10d: present only when a measured figure is on screen; with nothing measured there is nothing to explain.
  var heroNote: String?
  var counts: [Count]
  var rows: [Row]
  var tracked: String
  var observingDays: String
  var columns = ["Last run", "Next run", "Saved a week"]

  init(_ d: DashboardData, now: Date) {
    let active = d.automations.filter { $0.state == .active || $0.state == .needsYou }
    if let m = d.hours.measured, !active.isEmpty {
      heroValue = Figures.perWeek(m)
      heroQualifier = "Measured"
      heroPlaceholder = nil
      heroDetail = "Estimated \(Figures.perWeek(d.hours.estimated))"
      heroNote = "Measured compares your time on the task on full days before you turned it on with full days after."
    } else if !active.isEmpty {
      heroValue = nil
      heroQualifier = nil
      heroPlaceholder = "Nothing measured yet"
      let est = active.count == 1
        ? Figures.savedPerWeek(value: active[0].estimatedHoursPerWeek, arithmetic: active[0].arithmetic)
        : Figures.perWeek(d.hours.estimated)
      heroDetail = "Estimated \(est ?? Figures.perWeek(d.hours.estimated)). It is measured after a full day on each side of turning it on."
    } else {
      heroValue = nil
      heroQualifier = nil
      heroPlaceholder = "Nothing saved yet"
      let next = DashboardOrder.sorted(d.automations).first { $0.state == .readyForReview }
      if let n = next, let est = Figures.savedPerWeek(value: n.estimatedHoursPerWeek, arithmetic: n.arithmetic) {
        heroDetail = "\(n.name) would save about \(est) once you turn it on."
      } else {
        heroDetail = "Hours appear here once an automation you turned on has run."
      }
    }
    let byState = Dictionary(grouping: d.automations, by: \.state).mapValues(\.count)
    let needYou = (byState[.needsYou] ?? 0) + (byState[.readyForReview] ?? 0)
    var c = [Count(n: byState[.active] ?? 0, label: "active", role: .done),
             Count(n: needYou, label: needYou == 1 ? "needs you" : "need you", role: .needsYou)]
    if let p = byState[.paused], p > 0 { c.append(Count(n: p, label: "paused", role: .neutral)) }
    counts = c
    rows = DashboardOrder.sorted(d.automations).map { a in
      let measured = a.measuredHoursPerWeek
      return Row(
        id: a.id, name: a.name,
        chip: a.state == .active ? nil : a.state.label,
        chipNeedsYou: a.state == .needsYou || a.state == .readyForReview,
        reason: a.state == .needsYou ? a.needsYouReason.map { BrainError.sentence(PlainWords.clean($0)) } : nil,
        lastRun: Format.runTime(a.lastRunAt, now: now, past: true),
        nextRun: Self.nextRun(a, now: now),
        saved: measured.map(Figures.hours) ?? Figures.savedHours(value: a.estimatedHoursPerWeek, arithmetic: a.arithmetic) ?? "",
        // s10e: a row that never ran has saved nothing; it could save this much.
        savedQualifier: measured != nil ? "measured" : (a.lastRunAt == nil ? "could save" : "estimated"))
    }
    let minutes = d.days.reduce(0.0) { $0 + ($1.trackedMinutes ?? $1.activeMinutes) }
    tracked = "\(Figures.hours(minutes / 60)) tracked"
    observingDays = d.observing.daysLabel
  }

  static func nextRun(_ a: DashboardAutomation, now: Date) -> String {
    switch a.state {
    case .readyForReview: return "After you approve"
    case .needsYou: return "Waiting on you"
    case .paused: return "Paused"
    case .drafting: return "Not yet"
    case .active: return a.nextRunAt.map { Format.runTime($0, now: now, past: false) } ?? "On schedule"
    }
  }

  var allStrings: [String] {
    [heroTitle, heroValue ?? "", heroQualifier ?? "", heroPlaceholder ?? "", heroDetail, heroNote ?? "", tracked, observingDays]
      + columns + counts.map { "\($0.n) \($0.label)" }
      + rows.flatMap { [$0.name, $0.chip ?? "", $0.reason ?? "", $0.lastRun, $0.nextRun, $0.saved, $0.savedQualifier] }
  }
}

extension TimelineLayout {
  /// Whole two-hour steps, so the last tick is the last hour with data and every bar sits under a label.
  var evenSpan: TimelineLayout {
    var l = self
    if (l.endHour - l.startHour) % 2 == 1 {
      if l.endHour < 24 { l.endHour += 1 } else { l.startHour = max(0, l.startHour - 1) }
    }
    return l
  }

  /// Tick hours, every 2 h from the start, the end included.
  var ticks: [Int] { Array(stride(from: startHour, through: endHour, by: 2)) }
}
