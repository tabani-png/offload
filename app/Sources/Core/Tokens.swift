import Foundation

/// Design token values (s06). Plain numbers so they are testable without a window server; the SwiftUI layer
/// in Sources/Design maps them to fonts, colours and animations. Source: adam/memory/research/13-design-getone.md.
enum Tokens {
  /// 4-pt grid.
  enum Space {
    static let s4: Double = 4
    static let s8: Double = 8
    static let s12: Double = 12
    static let s16: Double = 16
    static let s20: Double = 20
    static let s24: Double = 24
    static let s32: Double = 32
    static let s40: Double = 40
    static let s48: Double = 48
    static let all: [Double] = [s4, s8, s12, s16, s20, s24, s32, s40, s48]
    /// Optical nudges below one grid step (text baselines, a badge riding a capsule edge). Never layout spacing.
    static let nudge: Double = 2
  }

  /// Concentric radii: 24 outside, 16 for an 8-pt inset, 12 for rows, pill for anything you press.
  enum Radius {
    static let card: Double = 24
    static let well: Double = 16
    static let row: Double = 12
    static let key: Double = 5
    /// A row inset 4 inside a 12-pt box (concentric).
    static let inset: Double = 8
    /// Toolbar buttons and small tiles.
    static let control: Double = 6
    /// Timeline bars.
    static let bar: Double = 3
    /// Snapshot window frame.
    static let window: Double = 12
    static func concentric(outer: Double, inset: Double) -> Double { max(0, outer - inset) }
  }

  struct TypeStyle: Equatable, Sendable {
    let name: String
    let size: Double
    let weight: Int
    /// Tracking in points.
    let tracking: Double
    let lineHeight: Double
  }

  /// SF Pro via system fonts. Two families (Display above 17 pt, Text at or below, chosen by the system),
  /// three weights, no bold. Hierarchy comes from opacity steps.
  enum TypeScale {
    /// The dashboard's one big number (s08). Display family, 500, tight tracking.
    static let hero = TypeStyle(name: "hero", size: 34, weight: 500, tracking: -0.9, lineHeight: 1.0)
    /// Window titles (the review window's workflow name). macOS large title.
    static let largeTitle = TypeStyle(name: "largeTitle", size: 26, weight: 500, tracking: -0.6, lineHeight: 1.15)
    static let display = TypeStyle(name: "display", size: 20, weight: 500, tracking: -0.35, lineHeight: 1.2)
    /// Sheet titles (confirm, steps).
    static let sheetTitle = TypeStyle(name: "sheetTitle", size: 17, weight: 500, tracking: -0.3, lineHeight: 1.25)
    static let title = TypeStyle(name: "title", size: 15, weight: 500, tracking: -0.15, lineHeight: 1.3)
    static let body = TypeStyle(name: "body", size: 13, weight: 400, tracking: -0.05, lineHeight: 1.45)
    static let label = TypeStyle(name: "label", size: 13, weight: 500, tracking: -0.05, lineHeight: 1.3)
    /// Secondary lines: details, footnotes, table cells. macOS callout.
    static let callout = TypeStyle(name: "callout", size: 12, weight: 400, tracking: 0, lineHeight: 1.4)
    static let calloutEmphasis = TypeStyle(name: "calloutEmphasis", size: 12, weight: 500, tracking: 0, lineHeight: 1.3)
    static let caption = TypeStyle(name: "caption", size: 11, weight: 500, tracking: 0.1, lineHeight: 1.2)
    /// Small regular text: axis notes, column sublabels.
    static let footnote = TypeStyle(name: "footnote", size: 11, weight: 400, tracking: 0.05, lineHeight: 1.3)
    /// Chart axis ticks and the "now" tag.
    static let micro = TypeStyle(name: "micro", size: 10, weight: 400, tracking: 0.1, lineHeight: 1)
    /// Key labels on a Keycap: single characters and words ("esc", "Space").
    static let key = TypeStyle(name: "key", size: 11, weight: 500, tracking: 0, lineHeight: 1)
    static let keyWord = TypeStyle(name: "keyWord", size: 10, weight: 500, tracking: 0, lineHeight: 1)
    static let badge = TypeStyle(name: "badge", size: 10, weight: 600, tracking: 0, lineHeight: 1)
    static let mono = TypeStyle(name: "mono", size: 11, weight: 500, tracking: 0, lineHeight: 1)
    /// Raw source (View source disclosure).
    static let code = TypeStyle(name: "code", size: 12, weight: 400, tracking: 0, lineHeight: 1.35)
    static let all: [TypeStyle] = [hero, largeTitle, display, sheetTitle, title, body, label, callout, calloutEmphasis,
                                   caption, footnote, micro, key, keyWord, badge, mono, code]
    /// SF Symbol sizes, matched to the text they sit beside.
    enum Symbol {
      static let small: Double = 10
      static let regular: Double = 12
      static let large: Double = 14
    }
  }

  /// Fixed control sizes (points). Heights, not spacing: pills and rows are this tall, dots this wide.
  enum Size {
    static let key: Double = 18
    static let control: Double = 30
    static let chip: Double = 22
    static let chipSmall: Double = 20
    static let tag: Double = 18
    static let row: Double = 36
    static let dot: Double = 8
    static let dotSmall: Double = 6
    static let toolbar: Double = 52
    static let actionBar: Double = 56
  }

  /// Seconds.
  enum Duration {
    static let press: Double = 0.10
    static let fast: Double = 0.15
    static let base: Double = 0.20
    static let slow: Double = 0.30
    static let pulse: Double = 1.6
  }

  enum Motion {
    static let pressScale: Double = 0.97
    static let riseOffset: Double = 7
    /// Native analogue of out-expo 200 ms.
    static let springResponse: Double = 0.3
    static let springDamping: Double = 0.9
  }

  /// Opacity ladder for dark-mode foregrounds (96 / 84 / 52). s10a: secondary rose from 62%, s10d to 84%, so body copy in
  /// cards reads as copy, not as a caption (DESIGN-REVIEW-1 token check); tertiary keeps 4.5:1 on graphite.
  enum Ink {
    static let primary: Double = 0.96
    static let secondary: Double = 0.84
    static let tertiary: Double = 0.52
    /// Light mode: black at these opacities (s10d: tokens, not literals in Theme). Tertiary 63% measured 4.5:1 live.
    static let lightPrimary: Double = 0.86
    static let lightSecondary: Double = 0.72
    static let lightTertiary: Double = 0.63
  }

  /// s10d: fixed layout widths and strokes the surfaces share (DESIGN-REVIEW-2 section D: no literals in Surfaces).
  enum Layout {
    /// The review steps' right column ("Gmail", "Google Sheets, not connected"): one width for every row, so every
    /// description wraps at the same measure.
    static let placeColumn: Double = 184
    /// The card receipt's label column.
    static let receiptLabel: Double = 80
    /// Dashboard sidebar.
    static let sidebar: Double = 208
    /// Dashboard table columns.
    static let runColumn: Double = 112
    static let savedColumn: Double = 92
    /// Observing label column.
    static let labelColumn: Double = 120
    /// Min height of "Your voice" while it is empty, and its height cap.
    static let editorMin: Double = 72
    static let editorMax: Double = 180
    /// Steps editor height and the confirm sheet width.
    static let editorSheet: Double = 420
    static let confirmSheet: Double = 560
    static let skillSheet: Double = 640
    /// The "now" line and bar outline strokes.
    static let nowLine: Double = 1.5
    static let hairline: Double = 1
    /// Smallest drawn width of an Offload run on the timeline, so its hatch reads as a pattern.
    static let runMinWidth: Double = 16
    static let hatchSpacing: Double = 4
    static let hatchLine: Double = 1
  }

  /// s10d: window chrome numbers in one place (shadow, ring, sheet scrim), shared by the snapshot chrome.
  enum Window {
    static let shadowRadius: Double = 16
    static let shadowY: Double = 8
    static let ringDark: Double = 0.14
    static let ringLight: Double = 0.14
    /// The dimming macOS puts over a window while a sheet is up (measured from the live capture).
    static let scrimDark: Double = 0.40
    static let scrimLight: Double = 0.22
    static let sheetRadius: Double = 24
  }

  static let undoSeconds: Double = 5
}

/// CSS-style cubic bezier with P0 = (0,0), P3 = (1,1).
struct CubicBezier: Equatable, Sendable {
  let x1: Double, y1: Double, x2: Double, y2: Double

  /// cubic-bezier(0.16, 1, 0.3, 1): fast and decelerating.
  static let outExpo = CubicBezier(x1: 0.16, y1: 1, x2: 0.3, y2: 1)
  /// cubic-bezier(0.4, 0, 0.2, 1): colour changes.
  static let standard = CubicBezier(x1: 0.4, y1: 0, x2: 0.2, y2: 1)

  private func sample(_ a: Double, _ b: Double, _ t: Double) -> Double {
    let u = 1 - t
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
  }

  /// Progress for time fraction `x` in 0...1, found by bisection on the x curve.
  func value(at x: Double) -> Double {
    let x = min(1, max(0, x))
    var lo = 0.0, hi = 1.0, t = x
    for _ in 0..<60 {
      t = (lo + hi) / 2
      if sample(x1, x2, t) < x { lo = t } else { hi = t }
    }
    return sample(y1, y2, t)
  }
}

/// What a motion does, with Reduce Motion folded in. Surfaces read this instead of hard-coding animations.
struct MotionPlan: Equatable, Sendable {
  var duration: Double
  var offsetY: Double
  var scale: Double
  var fades: Bool
  var repeats: Bool

  /// Insert: rise 7 pt and fade, 200 ms out-expo. Reduced: fade only.
  static func arrive(reduceMotion: Bool) -> MotionPlan {
    MotionPlan(duration: Tokens.Duration.base, offsetY: reduceMotion ? 0 : Tokens.Motion.riseOffset,
               scale: 1, fades: true, repeats: false)
  }

  /// Press: 0.97 for 100 ms. Reduced: no scale, the fill change carries it.
  static func press(reduceMotion: Bool) -> MotionPlan {
    MotionPlan(duration: Tokens.Duration.press, offsetY: 0, scale: reduceMotion ? 1 : Tokens.Motion.pressScale,
               fades: false, repeats: false)
  }

  /// Live dot ring. Reduced: a still halo.
  static func pulse(reduceMotion: Bool) -> MotionPlan {
    MotionPlan(duration: Tokens.Duration.pulse, offsetY: 0, scale: reduceMotion ? 1 : 2.4,
               fades: true, repeats: !reduceMotion)
  }
}

/// Colour means state. Four hues, used the same way on every surface.
enum StatusRole: String, Equatable, Sendable {
  case working   // blue
  case needsYou  // amber
  case done      // green
  case recording // red, only while the mic is live
  case neutral   // grey

  enum Context { case observer, automation, mic }

  static func forObserver(_ s: ObserverState) -> StatusRole {
    switch s {
    case .watching: return .working
    case .stale: return .needsYou  // it stopped recording and you may want to know
    case .paused, .noData: return .neutral
    }
  }

  static func forAutomation(_ s: AutomationStatus) -> StatusRole {
    switch s {
    case .running: return .working
    case .awaitingApproval, .failed, .draft: return .needsYou
    case .done: return .done
    case .paused: return .neutral
    }
  }

  static func forMic(recording: Bool) -> StatusRole { recording ? .recording : .neutral }

  /// Ambient first: only the observer's watching dot and a live mic move.
  func pulses(context: Context) -> Bool {
    switch (self, context) {
    case (.working, .observer), (.recording, .mic): return true
    default: return false
    }
  }
}
