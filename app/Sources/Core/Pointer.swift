import CoreGraphics
import Foundation

/// The "show me" pointer: a small blue arrow that flies an eased arc to an element in one of OUR windows, says one
/// line, waits, and flies back. Behaviour only, written clean-room from adam/memory/research/11-rea-clicky.md
/// (C17-C19): quadratic bezier with the control point lifted by min(distance × 0.2, 80) pt, smoothstep easing,
/// duration clamp(distance / 800, 0.6, 1.4) s, landing 8 pt right and 12 pt below the target point, kept 20 pt
/// inside the bounds, a 1.3× scale pulse at mid-flight, a 3-second hold. Coordinates are SwiftUI's (y down).
/// Reduce Motion: no flight; the pointer fades in at the landing point, holds, fades out.
struct PointerFlight: Equatable, Sendable {
  enum Phase: Equatable, Sendable { case out, hold, back, done }

  struct Frame: Equatable, Sendable {
    var position: CGPoint
    /// Heading in degrees, following the curve's tangent (0 = pointing right).
    var angle: Double
    var scale: Double
    var opacity: Double
    var labelVisible: Bool
    var phase: Phase
  }

  static let hold: Double = 3
  static let fade: Double = 0.25
  static let edgeInset: Double = 20
  static let landingOffset = CGPoint(x: 8, y: 12)
  /// Resting heading: the arrow points up-left at the thing, like a cursor.
  static let restAngle: Double = -135

  var origin: CGPoint
  var landing: CGPoint
  var label: String
  var startedAt: Date
  var reduceMotion: Bool

  /// `target` is the element's frame; the pointer's tip lands just right of and below its leading third.
  init(origin: CGPoint, target: CGRect, bounds: CGRect, label: String, startedAt: Date, reduceMotion: Bool) {
    self.origin = origin
    let aim = CGPoint(x: target.minX + min(28, target.width / 3), y: target.midY)
    // The 12-pt drop is capped at half the target's height, so on a short target (a 14-pt timeline bar) the tip
    // stays on its lower edge instead of landing on the row below.
    let drop = min(Self.landingOffset.y, target.height / 2)
    self.landing = Self.clamp(CGPoint(x: aim.x + Self.landingOffset.x, y: aim.y + drop), in: bounds)
    self.label = label
    self.startedAt = startedAt
    self.reduceMotion = reduceMotion
  }

  static func clamp(_ p: CGPoint, in b: CGRect) -> CGPoint {
    let i = edgeInset
    guard b.width > 2 * i, b.height > 2 * i else { return CGPoint(x: b.midX, y: b.midY) }
    return CGPoint(x: min(max(p.x, b.minX + i), b.maxX - i), y: min(max(p.y, b.minY + i), b.maxY - i))
  }

  var distance: Double { hypot(landing.x - origin.x, landing.y - origin.y) }

  /// One-way flight time. Reduce Motion: the fade time.
  var flightDuration: Double { reduceMotion ? Self.fade : min(1.4, max(0.6, distance / 800)) }

  var totalDuration: Double { flightDuration * 2 + Self.hold }

  /// Mid-point lifted toward the top of the window, so the path is an arc and not a slide.
  var control: CGPoint {
    let lift = min(distance * 0.2, 80)
    return CGPoint(x: (origin.x + landing.x) / 2, y: min(origin.y, landing.y) - lift)
  }

  static func smoothstep(_ t: Double) -> Double {
    let t = min(1, max(0, t))
    return t * t * (3 - 2 * t)
  }

  static func bezier(_ a: CGPoint, _ c: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint {
    let u = 1 - t
    return CGPoint(x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y)
  }

  static func tangent(_ a: CGPoint, _ c: CGPoint, _ b: CGPoint, _ t: Double) -> Double {
    let dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x)
    let dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y)
    return atan2(dy, dx) * 180 / .pi
  }

  func frame(at now: Date) -> Frame {
    let t = now.timeIntervalSince(startedAt)
    let f = flightDuration
    if t >= totalDuration || t < 0 {
      return Frame(position: t < 0 ? origin : origin, angle: Self.restAngle, scale: 1, opacity: 0, labelVisible: false,
                   phase: t < 0 ? .out : .done)
    }
    if reduceMotion {
      // Fade in at the landing point, hold, fade out. Nothing moves.
      let opacity: Double
      let phase: Phase
      if t < f { opacity = t / f; phase = .out }
      else if t < f + Self.hold { opacity = 1; phase = .hold }
      else { opacity = max(0, 1 - (t - f - Self.hold) / f); phase = .back }
      return Frame(position: landing, angle: Self.restAngle, scale: 1, opacity: opacity,
                   labelVisible: phase == .hold, phase: phase)
    }
    if t < f {
      let p = Self.smoothstep(t / f)
      return Frame(position: Self.bezier(origin, control, landing, p), angle: Self.tangent(origin, control, landing, p),
                   scale: 1 + 0.3 * sin(.pi * p), opacity: min(1, t / Self.fade + 0.2), labelVisible: false, phase: .out)
    }
    if t < f + Self.hold {
      return Frame(position: landing, angle: Self.restAngle, scale: 1, opacity: 1, labelVisible: true, phase: .hold)
    }
    let p = Self.smoothstep((t - f - Self.hold) / f)
    let remaining = totalDuration - t
    return Frame(position: Self.bezier(landing, control, origin, p), angle: Self.tangent(landing, control, origin, p),
                 scale: 1 + 0.3 * sin(.pi * p), opacity: min(1, remaining / Self.fade), labelVisible: false, phase: .back)
  }
}

/// Glass legibility without looking behind the panel. We never sample other apps' pixels (that would need Screen
/// Recording and would read the user's screen), so the veil is solved for the worst backdrop: pure white under the
/// dark card, pure black under the light one. The material blurs and tints first; `materialPass` is how much of
/// the backdrop survives it (measured live, see s08 DESIGN-REVIEW). The veil is the least opacity at which the
/// tertiary ink still reaches `target` contrast, so the glass stays as clear as legibility allows.
enum GlassVeil {
  /// WCAG relative luminance of an sRGB grey level 0...1.
  static func luminance(_ v: Double) -> Double {
    v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
  }

  static func contrast(_ a: Double, _ b: Double) -> Double {
    let la = luminance(a), lb = luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  /// Grey level of the glass over a backdrop: material pass-through, then the veil on top.
  static func surface(backdrop: Double, materialTint: Double, materialPass: Double, veil: Double, veilOpacity: Double) -> Double {
    let afterMaterial = materialPass * backdrop + (1 - materialPass) * materialTint
    return veilOpacity * veil + (1 - veilOpacity) * afterMaterial
  }

  /// Ink of `inkLevel` at `inkAlpha` composited over `surface`.
  static func ink(_ inkLevel: Double, alpha: Double, over surface: Double) -> Double {
    alpha * inkLevel + (1 - alpha) * surface
  }

  /// One piece of text the veil has to carry: ink at `alpha`, on the glass lifted by a fill of `lift` toward the
  /// fill level (the wells are white 6% on dark glass, white 55% on light glass).
  struct InkCase: Equatable, Sendable {
    var name: String
    var alpha: Double
    var lift: Double
  }

  struct Params: Equatable, Sendable {
    var dark: Bool
    /// Worst-case backdrop grey: white under a dark card, black under a light one.
    var backdrop: Double { dark ? 1 : 0 }
    var materialTint: Double
    var materialPass: Double
    var veilLevel: Double
    var inkLevel: Double { dark ? 1 : 0 }
    /// Fill level of wells and rows (white in both appearances).
    var fillLevel: Double { 1 }
    var cases: [InkCase]
    var floor: Double
    var target: Double = 4.5

    /// The faintest case, for `achieved`.
    var inkAlpha: Double { cases[0].alpha }

    /// Fitted to live captures of the card over our own white and near-black windows, 2026-10-24 (s08
    /// DESIGN-REVIEW, "Glass"): `.hudWindow` with the vibrant appearance passes about 73% of the backdrop.
    static let dark = Params(dark: true, materialTint: 0.33, materialPass: 0.73, veilLevel: 0.045,
                             cases: [InkCase(name: "tertiary on well", alpha: Tokens.Ink.tertiary, lift: 0.06),
                                     InkCase(name: "secondary on glass", alpha: Tokens.Ink.secondary, lift: 0)],
                             floor: 0.30)
    /// `.hudWindow` with the vibrant light appearance passes about 38% and is mostly white (fitted the same way).
    static let light = Params(dark: false, materialTint: 0.94, materialPass: 0.38, veilLevel: 0.985,
                              cases: [InkCase(name: "tertiary on glass", alpha: 0.63, lift: 0),
                                      InkCase(name: "secondary on glass", alpha: 0.72, lift: 0)],
                              floor: 0.30, target: 5.3)
    /// Thin dark-on-light text measured about 15% below its nominal contrast live (anti-aliasing), so light mode
    /// solves for 4.5 / 0.85 = 5.3 nominal to land at 4.5 seen. Light-on-dark measured at or above nominal.
  }

  static func caseContrast(_ p: Params, _ c: InkCase, veilOpacity a: Double, backdrop: Double) -> Double {
    let glass = surface(backdrop: backdrop, materialTint: p.materialTint, materialPass: p.materialPass,
                        veil: p.veilLevel, veilOpacity: a)
    let s = c.lift * p.fillLevel + (1 - c.lift) * glass
    return contrast(ink(p.inkLevel, alpha: c.alpha, over: s), s)
  }

  /// Least veil opacity (0.01 steps) at which every case meets the target over the worst backdrop, never below
  /// `floor`. Increase Contrast raises the target to 7:1; Reduce Transparency makes the veil opaque.
  static func opacity(_ p: Params, increaseContrast: Bool = false, reduceTransparency: Bool = false) -> Double {
    if reduceTransparency { return 1 }
    let target = increaseContrast ? max(7.0, p.target) : p.target
    var step = Int((p.floor * 100).rounded())
    while step < 100 {
      let a = Double(step) / 100
      if p.cases.allSatisfy({ caseContrast(p, $0, veilOpacity: a, backdrop: p.backdrop) >= target }) { return a }
      step += 1
    }
    return 1
  }

  /// Contrast of the tertiary ink at a given veil over a given backdrop, for tests and the review.
  /// The weakest case's contrast at a given veil over a given backdrop.
  static func achieved(_ p: Params, veilOpacity: Double, backdrop: Double) -> Double {
    p.cases.map { caseContrast(p, $0, veilOpacity: veilOpacity, backdrop: backdrop) }.min() ?? 1
  }
}

/// s10d: where the pointer's label goes. It must never cover the target, the arrow, or any text it was told about
/// (`obstacles`), and it stays inside the window. Candidates: along the target's own line (right of it, then left),
/// then scanning down and up from the target in small steps, each anchored at the arrow and flipped to end at the
/// arrow when it would leave the window. The free candidate nearest the target wins; a vertical step costs a
/// little more than a sideways one, so the label stays on the target's line when it can. If nothing is free (a
/// window too small), the candidate with the least covered area is used.
enum PointerLabelPlacement {
  enum Side: Equatable, Sendable { case right, left, below, above }

  struct Placement: Equatable, Sendable {
    var rect: CGRect
    var side: Side
    var collides: Bool
  }

  static let gap: CGFloat = 6
  static let inset: CGFloat = 8
  static let step: CGFloat = 2

  static func place(label size: CGSize, tip: CGPoint, arrow: CGSize, target: CGRect, obstacles: [CGRect],
                    bounds: CGRect, row: CGRect? = nil) -> Placement {
    // s10f (DESIGN-REVIEW-4 P6): a target inside a table row puts its label below that row (above it when there is
    // no room), never on the row, where it covered the row's other columns. Clamped inside the bounds.
    if let row, !row.isNull, !row.isEmpty {
      return placeOffRow(label: size, tip: tip, arrow: arrow, row: row, obstacles: obstacles, bounds: bounds)
    }
    let arrowRect = CGRect(origin: tip, size: arrow)
    let blocked = [target, arrowRect] + obstacles.filter { !$0.isNull && !$0.isEmpty && !$0.contains(target) }
    let inner = bounds.insetBy(dx: inset, dy: inset)
    let busy = target.union(arrowRect)

    func fits(_ r: CGRect) -> Bool { inner.contains(r) }
    func hits(_ r: CGRect) -> CGFloat {
      blocked.reduce(0) { acc, b in
        // Keep a gap's worth of air around every obstacle, so the label never touches text.
        let i = r.intersection(b.insetBy(dx: -gap, dy: -gap / 2))
        return acc + (i.isNull ? 0 : i.width * i.height)
      }
    }

    var candidates: [(CGRect, Side, CGFloat)] = []
    // Along the target's line: the label's centre on the target's centre line.
    let lineY = target.midY - size.height / 2
    var x = busy.maxX + gap
    while x + size.width <= inner.maxX {
      candidates.append((CGRect(x: x, y: lineY, width: size.width, height: size.height), .right, x - busy.maxX))
      x += step * 4
    }
    x = busy.minX - gap - size.width
    while x >= inner.minX {
      candidates.append((CGRect(x: x, y: lineY, width: size.width, height: size.height), .left, busy.minX - (x + size.width)))
      x -= step * 4
    }
    // Below and above: anchored at the arrow's tip, flipped to end at it when the right edge is too close.
    func anchoredX() -> CGFloat {
      let start = tip.x + arrow.width * 0.5
      if start + size.width <= inner.maxX { return max(inner.minX, start) }
      return max(inner.minX, min(tip.x - size.width, inner.maxX - size.width))
    }
    let ax = anchoredX()
    var y = busy.maxY + gap
    while y + size.height <= inner.maxY {
      candidates.append((CGRect(x: ax, y: y, width: size.width, height: size.height), .below, (y - busy.maxY) * 1.15))
      y += step
    }
    y = busy.minY - gap - size.height
    while y >= inner.minY {
      candidates.append((CGRect(x: ax, y: y, width: size.width, height: size.height), .above, (busy.minY - (y + size.height)) * 1.15))
      y -= step
    }

    let valid = candidates.filter { fits($0.0) }
    if let free = valid.filter({ hits($0.0) == 0 }).min(by: { $0.2 < $1.2 }) {
      return Placement(rect: free.0, side: free.1, collides: false)
    }
    if let least = valid.min(by: { (hits($0.0), $0.2) < (hits($1.0), $1.2) }) {
      return Placement(rect: least.0, side: least.1, collides: true)
    }
    let fallback = CGRect(x: max(inner.minX, min(ax, inner.maxX - size.width)), y: busy.maxY + gap,
                          width: size.width, height: size.height)
    return Placement(rect: fallback, side: .below, collides: true)
  }

  private static func placeOffRow(label size: CGSize, tip: CGPoint, arrow: CGSize, row: CGRect, obstacles: [CGRect],
                                  bounds: CGRect) -> Placement {
    let inner = bounds.insetBy(dx: inset, dy: inset)
    let busy = row.union(CGRect(origin: tip, size: arrow))
    let x = max(inner.minX, min(tip.x + arrow.width * 0.5, inner.maxX - size.width))
    let blocked = obstacles.filter { !$0.isNull && !$0.isEmpty && !row.contains($0) }
    func hits(_ r: CGRect) -> Bool { blocked.contains { r.intersects($0.insetBy(dx: -gap, dy: -gap / 2)) } }
    var candidates: [(CGRect, Side)] = []
    var y = busy.maxY + gap
    while y + size.height <= inner.maxY { candidates.append((CGRect(x: x, y: y, width: size.width, height: size.height), .below)); y += step }
    y = row.minY - gap - size.height
    while y >= inner.minY { candidates.append((CGRect(x: x, y: y, width: size.width, height: size.height), .above)); y -= step }
    if let free = candidates.first(where: { !hits($0.0) }) { return Placement(rect: free.0, side: free.1, collides: false) }
    if let any = candidates.first { return Placement(rect: any.0, side: any.1, collides: true) }
    let r = CGRect(x: x, y: min(busy.maxY + gap, inner.maxY - size.height), width: size.width, height: size.height)
    return Placement(rect: r, side: .below, collides: true)
  }
}
