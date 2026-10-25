import Foundation
import Testing

// S06: design-system logic that has no pixels in it. Token values, the motion curve, Reduce Motion,
// status-colour roles. The visual side is checked by `Offload --snapshot`.

@Suite("S06 tokens")
struct S06TokenTests {
  @Test("spacing sits on the 4-pt grid")
  func spacingOnGrid() {
    for value in Tokens.Space.all {
      #expect(value.truncatingRemainder(dividingBy: 4) == 0, "spacing \(value) is off the 4-pt grid")
    }
    #expect(Tokens.Space.all == Tokens.Space.all.sorted())
  }

  @Test("radii are concentric: inner = outer - inset")
  func concentricRadii() {
    #expect(Tokens.Radius.card == 24)
    #expect(Tokens.Radius.well == 16)
    #expect(Tokens.Radius.row == 12)
    #expect(Tokens.Radius.concentric(outer: Tokens.Radius.card, inset: Tokens.Space.s8) == Tokens.Radius.well)
    #expect(Tokens.Radius.concentric(outer: Tokens.Radius.well, inset: Tokens.Space.s4) == Tokens.Radius.row)
    // An inset bigger than the radius never yields a negative radius.
    #expect(Tokens.Radius.concentric(outer: 6, inset: 12) == 0)
  }

  @Test("type scale uses three weights and no bold")
  func typeWeights() {
    let weights = Set(Tokens.TypeScale.all.map(\.weight))
    #expect(weights.isSubset(of: [400, 500, 600]))
    #expect(Tokens.TypeScale.all.filter { $0.weight == 600 }.allSatisfy { $0.name == "badge" })
    // Display sizes carry negative tracking; small text never does.
    #expect(Tokens.TypeScale.display.tracking < 0)
    #expect(Tokens.TypeScale.caption.tracking >= 0)
  }

  @Test("durations stay in the 100-300 ms band; press is the only 100")
  func durations() {
    #expect(Tokens.Duration.press == 0.10)
    for d in [Tokens.Duration.fast, Tokens.Duration.base, Tokens.Duration.slow] {
      #expect(d >= 0.15 && d <= 0.30)
    }
    #expect(Tokens.Motion.pressScale == 0.97)
    #expect(Tokens.Motion.riseOffset == 7)
  }
}

@Suite("S06 motion curve")
struct S06MotionCurveTests {
  @Test("out-expo hits its end points")
  func endPoints() {
    let c = CubicBezier.outExpo
    #expect(abs(c.value(at: 0)) < 1e-6)
    #expect(abs(c.value(at: 1) - 1) < 1e-6)
  }

  @Test("out-expo decelerates: most of the travel happens early")
  func decelerates() {
    let c = CubicBezier.outExpo
    #expect(c.value(at: 0.25) > 0.75)
    #expect(c.value(at: 0.5) > 0.9)
    // Monotonic, never overshoots (nothing bounces).
    var last = 0.0
    for i in 0...100 {
      let v = c.value(at: Double(i) / 100)
      #expect(v >= last - 1e-9)
      #expect(v <= 1 + 1e-9)
      last = v
    }
  }

  @Test("control points match cubic-bezier(0.16, 1, 0.3, 1)")
  func controlPoints() {
    let c = CubicBezier.outExpo
    #expect(c.x1 == 0.16 && c.y1 == 1 && c.x2 == 0.3 && c.y2 == 1)
  }
}

@Suite("S06 reduce motion")
struct S06ReduceMotionTests {
  @Test("Reduce Motion swaps movement for a fade")
  func reduceMotion() {
    let full = MotionPlan.arrive(reduceMotion: false)
    let reduced = MotionPlan.arrive(reduceMotion: true)
    #expect(full.offsetY == 7)
    #expect(reduced.offsetY == 0)
    #expect(reduced.fades)
    #expect(MotionPlan.press(reduceMotion: true).scale == 1)
    #expect(MotionPlan.press(reduceMotion: false).scale == 0.97)
    #expect(MotionPlan.pulse(reduceMotion: true).repeats == false)
    #expect(MotionPlan.pulse(reduceMotion: false).repeats == true)
  }
}

@Suite("S06 status roles")
struct S06StatusRoleTests {
  @Test("colour means state: one role per state, red only while recording")
  func roles() {
    #expect(StatusRole.forObserver(.watching) == .working)
    #expect(StatusRole.forObserver(.paused) == .neutral)
    #expect(StatusRole.forAutomation(.running) == .done)  // s10e M7: on and healthy is green, as on the dashboard
    #expect(StatusRole.forAutomation(.awaitingApproval) == .needsYou)
    #expect(StatusRole.forAutomation(.failed) == .needsYou)
    #expect(StatusRole.forAutomation(.done) == .done)
    #expect(StatusRole.forAutomation(.paused) == .neutral)
    let nonRecording: [StatusRole] = AutomationStatus.allCases.map(StatusRole.forAutomation)
      + ObserverState.allCases.map(StatusRole.forObserver)
    #expect(!nonRecording.contains(.recording))
    #expect(StatusRole.forMic(recording: true) == .recording)
    #expect(StatusRole.forMic(recording: false) == .neutral)
  }

  @Test("only the observer's watching dot pulses")
  func pulses() {
    #expect(StatusRole.forObserver(.watching).pulses(context: .observer))
    #expect(!StatusRole.forObserver(.paused).pulses(context: .observer))
    #expect(!StatusRole.forAutomation(.done).pulses(context: .automation))
  }
}
