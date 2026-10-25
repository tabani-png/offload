import Foundation

// s10a timeline: colour means state, so tasks are drawn in neutral ink steps (one per task, darkest = most time),
// each step labelled in the legend and at least 3:1 against the box in both modes. Short spans are merged so a
// live week reads as blocks of work, not a barcode.

/// sRGB colour in 0...1, for contrast maths without a window server.
struct RGB: Equatable, Sendable {
  var r: Double, g: Double, b: Double

  init(_ r: Double, _ g: Double, _ b: Double) { self.r = r; self.g = g; self.b = b }
  init(hex: UInt32) {
    self.init(Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
  }

  /// `top` at `alpha` over self.
  func over(_ top: RGB, alpha: Double) -> RGB {
    RGB(top.r * alpha + r * (1 - alpha), top.g * alpha + g * (1 - alpha), top.b * alpha + b * (1 - alpha))
  }

  /// WCAG relative luminance.
  var luminance: Double {
    func lin(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }

  static func contrast(_ a: RGB, _ b: RGB) -> Double {
    let (l1, l2) = (max(a.luminance, b.luminance), min(a.luminance, b.luminance))
    return (l1 + 0.05) / (l2 + 0.05)
  }

  static let white = RGB(1, 1, 1)
  static let black = RGB(0, 0, 0)
}

enum TimelineInk {
  /// Ink opacity per task rank (0 = the task with the most time, 3 = everything else): white on dark, black on light.
  static let dark: [Double] = [0.92, 0.70, 0.54, 0.40]
  static let light: [Double] = [0.86, 0.66, 0.54, 0.44]

  /// The box the bars sit on: the window canvas plus the group fill (WindowKit `canvas` + `group`).
  static let darkCanvas = RGB(hex: 0x161618)
  static let darkSurface = darkCanvas.over(.white, alpha: 0.045)
  static let lightSurface = RGB.white

  static func opacity(rank: Int, dark isDark: Bool) -> Double {
    let ladder = isDark ? dark : light
    return ladder[min(max(0, rank), ladder.count - 1)]
  }

  /// The colour a bar of this rank renders as on its box.
  static func bar(rank: Int, dark isDark: Bool) -> RGB {
    let surface = isDark ? darkSurface : lightSurface
    return surface.over(isDark ? .white : .black, alpha: opacity(rank: rank, dark: isDark))
  }

  static func contrast(rank: Int, dark isDark: Bool) -> Double {
    RGB.contrast(bar(rank: rank, dark: isDark), isDark ? darkSurface : lightSurface)
  }
}

enum TimelineMerge {
  /// A span shorter than this joins its neighbour; same-task spans closer than this join each other.
  static let joinSeconds: Double = 180

  /// Same-task spans with a gap under 3 min become one; then a span under 3 min joins the neighbour it touches
  /// (the longer one when both are close). Repeats until nothing changes. Bars keep the id of their first span.
  static func merge(_ input: [TimelineBar], joinSeconds: Double = joinSeconds) -> [TimelineBar] {
    var bars = input.sorted { $0.start < $1.start }
    for _ in 0..<8 {
      let before = bars
      bars = joinSameTask(bars, joinSeconds)
      bars = absorbShort(bars, joinSeconds)
      if bars == before { break }
    }
    return bars
  }

  private static func duration(_ b: TimelineBar) -> Double { b.end.timeIntervalSince(b.start) }

  private static func joinSameTask(_ bars: [TimelineBar], _ join: Double) -> [TimelineBar] {
    var out: [TimelineBar] = []
    for b in bars {
      if var last = out.last, last.taskId == b.taskId, last.automated == b.automated,
         b.start.timeIntervalSince(last.end) < join {
        last.end = max(last.end, b.end)
        out[out.count - 1] = last
      } else {
        out.append(b)
      }
    }
    return out
  }

  private static func absorbShort(_ bars: [TimelineBar], _ join: Double) -> [TimelineBar] {
    var out = bars
    var i = 0
    while i < out.count {
      let b = out[i]
      guard duration(b) < join else { i += 1; continue }
      let prev = i > 0 && b.start.timeIntervalSince(out[i - 1].end) < join ? i - 1 : nil
      let next = i + 1 < out.count && out[i + 1].start.timeIntervalSince(b.end) < join ? i + 1 : nil
      let target: Int?
      switch (prev, next) {
      case let (p?, n?): target = duration(out[p]) >= duration(out[n]) ? p : n
      case let (p?, nil): target = p
      case let (nil, n?): target = n
      default: target = nil
      }
      guard let t = target else { i += 1; continue }
      out[t].start = min(out[t].start, b.start)
      out[t].end = max(out[t].end, b.end)
      out.remove(at: i)
      if t < i { i = max(0, i - 1) }
    }
    return out
  }
}

extension DashboardData {
  /// The drawn (merged, s10a) bar that holds the top insight's first span, by hand when there is one.
  var evidenceBar: TimelineBar? {
    let all = days.flatMap(\.bars)
    guard let raw = all.first(where: { $0.id == MockBrainClient.evidenceBarId }) ?? all.first(where: { !$0.automated }) ?? all.first,
          let day = days.first(where: { $0.bars.contains { $0.id == raw.id } }) else { return nil }
    return TimelineMerge.merge(day.bars).first { $0.start <= raw.start && raw.start < $0.end } ?? raw
  }
}
