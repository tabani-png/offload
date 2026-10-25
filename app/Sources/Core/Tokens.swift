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
    static let all: [Double] = [s4, s8, s12, s16, s20, s24, s32]
  }

  /// Concentric radii: 24 outside, 16 for an 8-pt inset, 12 for rows, pill for anything you press.
  enum Radius {
    static let card: Double = 24
    static let well: Double = 16
    static let row: Double = 12
    static let key: Double = 5
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
    static let display = TypeStyle(name: "display", size: 20, weight: 500, tracking: -0.35, lineHeight: 1.2)
    static let title = TypeStyle(name: "title", size: 15, weight: 500, tracking: -0.15, lineHeight: 1.3)
    static let body = TypeStyle(name: "body", size: 13, weight: 400, tracking: -0.05, lineHeight: 1.45)
    static let label = TypeStyle(name: "label", size: 13, weight: 500, tracking: -0.05, lineHeight: 1.3)
    static let caption = TypeStyle(name: "caption", size: 11, weight: 500, tracking: 0.1, lineHeight: 1.2)
    static let badge = TypeStyle(name: "badge", size: 10, weight: 600, tracking: 0, lineHeight: 1)
    static let mono = TypeStyle(name: "mono", size: 11, weight: 500, tracking: 0, lineHeight: 1)
    static let all: [TypeStyle] = [display, title, body, label, caption, badge, mono]
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

  /// Opacity ladder for foregrounds (100 / 90 / 60 / 40).
  enum Ink {
    static let primary: Double = 1.0
    static let secondary: Double = 0.62
    static let tertiary: Double = 0.50
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
