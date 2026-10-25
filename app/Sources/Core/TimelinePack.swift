import Foundation

// s10e (DESIGN-REVIEW-3 M6): the chart must add up. The s10d fold stretched outreach blocks over the slivers between
// them, so a 64% week drew as about 80%. Packing keeps every class's minutes exactly: a bar is drawn at its active
// minutes, same-class neighbours within 10 minutes join (their minutes add, the gap does not), and a short foreign
// sliver between two same-class bars is moved after them instead of being swallowed.

enum TimelinePack {
  /// Bars closer than this belong to one block of work.
  static let joinSeconds: Double = 600

  /// The drawn class: the focus task by hand, Offload's runs, or everything else (all one neutral on the chart).
  static func classKey(_ b: TimelineBar, focus: String?) -> String {
    if b.automated { return "offload" }
    return b.taskId == focus ? "focus" : "other"
  }

  static func minutesByClass(_ bars: [TimelineBar], focus: String?) -> [String: Double] {
    var out: [String: Double] = [:]
    for b in bars { out[classKey(b, focus: focus), default: 0] += b.drawnMinutes }
    return out
  }

  /// What the chart draws for one day.
  static func display(_ input: [TimelineBar], focus: String?) -> [TimelineBar] {
    // 1. Every bar at its active length, in time order.
    var bars = input.sorted { $0.start < $1.start }.map { b -> TimelineBar in
      var b = b
      b.end = b.start.addingTimeInterval(b.drawnMinutes * 60)
      b.activeMinutes = nil
      if b.members == nil { b.members = [b.id] }
      return b
    }
    func key(_ b: TimelineBar) -> String { classKey(b, focus: focus) }
    func gap(_ a: TimelineBar, _ b: TimelineBar, wallEnd: Date) -> Double { b.start.timeIntervalSince(wallEnd) }
    // Wall-clock ends, so "within 10 minutes" is judged on when things happened, not on packed lengths.
    var wallEnd: [String: Date] = [:]
    for b in input { wallEnd[b.id] = b.end }
    func end(_ b: TimelineBar) -> Date { b.members.flatMap { $0.compactMap { wallEnd[$0] }.max() } ?? b.end }

    var changed = true
    var guardCount = 0
    while changed && guardCount < 4 * max(1, input.count) {
      changed = false
      guardCount += 1
      var i = 0
      while i < bars.count {
        // Same class, close together: one block.
        if i + 1 < bars.count, key(bars[i]) == key(bars[i + 1]), gap(bars[i], bars[i + 1], wallEnd: end(bars[i])) < joinSeconds {
          bars[i] = joined(bars[i], bars[i + 1])
          bars.remove(at: i + 1)
          changed = true
          continue
        }
        // A short foreign sliver between two blocks of one class: the blocks join, the sliver follows them.
        if i + 2 < bars.count, key(bars[i]) == key(bars[i + 2]), key(bars[i + 1]) != key(bars[i]),
           bars[i + 1].drawnMinutes * 60 < joinSeconds, !bars[i + 1].automated, !bars[i].automated,
           gap(bars[i], bars[i + 1], wallEnd: end(bars[i])) < joinSeconds,
           gap(bars[i + 1], bars[i + 2], wallEnd: end(bars[i + 1])) < joinSeconds {
          let sliver = bars[i + 1]
          let block = joined(bars[i], bars[i + 2])
          var moved = sliver
          moved.start = block.end
          moved.end = moved.start.addingTimeInterval(sliver.drawnMinutes * 60)
          bars.replaceSubrange(i...(i + 2), with: [block, moved])
          for id in moved.members ?? [] { wallEnd[id] = max(wallEnd[id] ?? moved.end, end(block)) }
          changed = true
          continue
        }
        i += 1
      }
    }
    // Never overlap: a packed block that now ends after the next one starts pushes it along (minutes kept).
    for i in bars.indices.dropFirst() where bars[i].start < bars[i - 1].end {
      let d = bars[i].drawnMinutes
      bars[i].start = bars[i - 1].end
      bars[i].end = bars[i].start.addingTimeInterval(d * 60)
    }
    return bars
  }

  /// Two bars of one class as one: starts at the first, drawn length the sum, keeps the first id.
  private static func joined(_ a: TimelineBar, _ b: TimelineBar) -> TimelineBar {
    var out = a
    let minutes = a.drawnMinutes + b.drawnMinutes
    out.end = a.start.addingTimeInterval(minutes * 60)
    out.members = (a.members ?? [a.id]) + (b.members ?? [b.id])
    return out
  }
}

/// The chart's header: the focus task by hand, its share of everything tracked, and Offload's runs.
struct WeekShare: Equatable, Sendable {
  var focusName: String
  var byHandMinutes: Double
  var offloadMinutes: Double
  var trackedMinutes: Double

  var share: Double { trackedMinutes > 0 ? byHandMinutes / trackedMinutes : 0 }

  init(days: [TimelineDay], tasks: [TimelineTask]) {
    let focus = tasks.first { $0.tint == 0 }
    focusName = focus?.name ?? "Top task"
    var hand = 0.0, auto = 0.0, all = 0.0
    for d in days {
      for b in d.bars {
        all += b.drawnMinutes
        if b.automated { auto += b.drawnMinutes } else if b.taskId == focus?.id { hand += b.drawnMinutes }
      }
    }
    byHandMinutes = hand
    offloadMinutes = auto
    trackedMinutes = all
  }

  /// "Investor outreach by hand 24.6 h · 64%"
  var header: String {
    "\(focusName) by hand \(Figures.hours(byHandMinutes / 60)) · \(Int((share * 100).rounded()))%"
  }

  /// "Offload ran it 0.8 h (your review)", only when it ran.
  var offloadLine: String? {
    offloadMinutes > 0 ? "Offload ran it \(Figures.hours(offloadMinutes / 60)), the time you spent reviewing" : nil
  }
}

/// s10e: the measured figure, shown on the chart it comes from: the task's weekly hours on full days before turning
/// it on against full days after (the activation day left out), weekdays × 5, as the brain measures it.
struct MeasuredProof: Equatable, Sendable {
  var beforeHoursPerWeek: Double
  var afterHoursPerWeek: Double
  var afterDays: Int
  var savedHoursPerWeek: Double { beforeHoursPerWeek - afterHoursPerWeek }

  init?(before: [TimelineDay], after: [TimelineDay], focus: String, activatedAt: Date, now: Date? = nil,
        calendar: Calendar = .current) {
    let onDay = calendar.startOfDay(for: activatedAt)
    func weekday(_ d: TimelineDay) -> Bool { !calendar.isDateInWeekend(d.date) }
    func minutes(_ d: TimelineDay) -> Double { d.bars.filter { $0.taskId == focus }.reduce(0) { $0 + $1.drawnMinutes } }
    let today = now.map { calendar.startOfDay(for: $0) }
    let pre = (before + after).filter { weekday($0) && $0.date < onDay }
    let post = after.filter { d in
      weekday(d) && d.date > onDay && (today.map { d.date < $0 } ?? true)
    }
    // The most recent full weekdays before, at most five.
    let preDays = Array(pre.sorted { $0.date < $1.date }.suffix(5))
    guard !preDays.isEmpty, !post.isEmpty else { return nil }
    beforeHoursPerWeek = preDays.reduce(0) { $0 + minutes($1) } / Double(preDays.count) * 5 / 60
    afterHoursPerWeek = post.reduce(0) { $0 + minutes($1) } / Double(post.count) * 5 / 60
    afterDays = post.count
  }

  /// The sentence under "This week" that ties the overview's hero to the bars.
  var line: String {
    let days = afterDays == 1 ? "1 full day" : "\(afterDays) full days"
    return "Since you turned it on (\(days)): \(Figures.hours(afterHoursPerWeek / 5)) a day on it, so \(Figures.hours(afterHoursPerWeek)) a week, "
      + "down from \(Figures.hours(beforeHoursPerWeek)). Saves \(Figures.hours(savedHoursPerWeek)) a week, measured."
  }
}

/// s10e: which week the timeline shows. The mock has the week before Offload and this week; live has this week only.
enum TimelineWeek: String, Equatable, Sendable, CaseIterable {
  case before, this

  var title: String { self == .before ? "Week before Offload" : "This week" }

  static func available(_ d: DashboardData) -> [TimelineWeek] { d.beforeDays.isEmpty ? [.this] : [.before, .this] }
}
