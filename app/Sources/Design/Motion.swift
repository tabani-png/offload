import SwiftUI

/// Motion tokens in SwiftUI terms. Every surface uses these; nothing hard-codes a curve.
enum Motion {
  /// cubic-bezier(0.16, 1, 0.3, 1).
  static func outExpo(_ duration: Double = Tokens.Duration.base) -> Animation {
    let c = CubicBezier.outExpo
    return .timingCurve(c.x1, c.y1, c.x2, c.y2, duration: duration)
  }

  /// Colour and fill changes.
  static func standard(_ duration: Double = Tokens.Duration.fast) -> Animation {
    let c = CubicBezier.standard
    return .timingCurve(c.x1, c.y1, c.x2, c.y2, duration: duration)
  }

  /// Native analogue of out-expo for things that move with the hand (paging).
  static var spring: Animation {
    .spring(response: Tokens.Motion.springResponse, dampingFraction: Tokens.Motion.springDamping)
  }

  /// The arrival curve, or a plain fade under Reduce Motion.
  static func arrive(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeOut(duration: Tokens.Duration.fast) : outExpo(Tokens.Duration.base)
  }
}

extension AnyTransition {
  /// Insert: rise 7 pt and fade. Remove: fade quickly. Reduce Motion: fade only.
  static func rise(reduceMotion: Bool) -> AnyTransition {
    let plan = MotionPlan.arrive(reduceMotion: reduceMotion)
    let insert: AnyTransition = plan.offsetY == 0
      ? .opacity
      : .opacity.combined(with: .offset(y: plan.offsetY))
    return .asymmetric(insertion: insert, removal: .opacity.animation(Motion.outExpo(Tokens.Duration.fast)))
  }
}

/// Press: scale 0.97 for 100 ms (no scale under Reduce Motion), and a brighter fill.
struct PressStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    let plan = MotionPlan.press(reduceMotion: reduceMotion)
    configuration.label
      .scaleEffect(configuration.isPressed ? plan.scale : 1)
      .animation(Motion.outExpo(plan.duration), value: configuration.isPressed)
  }
}

/// Plays the arrival once when a view first appears (skipped in snapshots so PNGs show the rest state).
struct ArriveOnAppear: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isSnapshot) private var isSnapshot
  @State private var shown = false

  func body(content: Content) -> some View {
    let plan = MotionPlan.arrive(reduceMotion: reduceMotion)
    let visible = shown || isSnapshot
    content
      .opacity(visible ? 1 : 0)
      .offset(y: visible ? 0 : plan.offsetY)
      .onAppear {
        guard !isSnapshot else { return }
        withAnimation(Motion.arrive(reduceMotion: reduceMotion)) { shown = true }
      }
  }
}

extension View {
  func arriveOnAppear() -> some View { modifier(ArriveOnAppear()) }
}
