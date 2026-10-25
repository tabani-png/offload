import SwiftUI

// The "show me" pointer, drawn inside our own window's view tree. It cannot reach other apps: there is no overlay
// window, no screen capture and no global coordinates. Targets register an anchor; the overlay resolves it.

struct PointerAnchorKey: PreferenceKey {
  static let defaultValue: [String: Anchor<CGRect>] = [:]
  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue()) { $1 }
  }
}

extension View {
  /// Marks this view as something the pointer can fly to (or start from).
  func pointerTarget(_ id: String) -> some View {
    anchorPreference(key: PointerAnchorKey.self, value: .bounds) { [id: $0] }
  }

  /// Hosts the pointer for everything inside: resolves target anchors and draws the flight on top.
  func pointerLayer(_ request: PointerRequest?, frozenAt: Date? = nil) -> some View {
    overlayPreferenceValue(PointerAnchorKey.self) { anchors in
      GeometryReader { geo in
        PointerLayer(request: request, anchors: anchors, size: geo.size, proxy: geo, frozenAt: frozenAt)
      }
      .allowsHitTesting(false)
    }
  }
}

struct PointerRequest: Equatable, Sendable {
  var targetId: String
  /// Where it starts: the control you used. nil = bottom-right of the window.
  var originId: String?
  var label: String
  var startedAt: Date
}

private struct PointerLayer: View {
  var request: PointerRequest?
  var anchors: [String: Anchor<CGRect>]
  var size: CGSize
  var proxy: GeometryProxy
  var frozenAt: Date?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if let r = request, let target = anchors[r.targetId] {
      let bounds = CGRect(origin: .zero, size: size)
      let origin: CGPoint = {
        if let id = r.originId, let a = anchors[id] {
          let o = proxy[a]
          return CGPoint(x: o.midX, y: o.midY)
        }
        return CGPoint(x: size.width - 48, y: size.height - 48)
      }()
      let flight = PointerFlight(origin: origin, target: proxy[target], bounds: bounds, label: r.label,
                                 startedAt: r.startedAt, reduceMotion: reduceMotion)
      if let frozenAt {
        PointerGlyph(frame: flight.frame(at: frozenAt), label: r.label, bounds: bounds)
      } else {
        TimelineView(.animation) { ctx in
          PointerGlyph(frame: flight.frame(at: ctx.date), label: r.label, bounds: bounds)
        }
      }
    }
  }
}

/// The arrow and its one-line label. The arrow's tip sits exactly on `frame.position`.
struct PointerGlyph: View {
  var frame: PointerFlight.Frame
  var label: String
  var bounds: CGRect
  @Environment(\.colorScheme) private var scheme

  static let size: CGFloat = 18

  var body: some View {
    let p = Palette(scheme: scheme)
    // Label goes right of the pointer, or left when that would leave the window.
    let labelLeft = frame.position.x > bounds.width * 0.62
    ZStack(alignment: .topLeading) {
      ArrowShape()
        .fill(p.status(.working))
        .overlay(ArrowShape().stroke(.white, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round)))
        .frame(width: Self.size, height: Self.size)
        .shadow(color: .black.opacity(0.35), radius: 3, x: 0, y: 1.5)
        .rotationEffect(.degrees(frame.angle - PointerFlight.restAngle), anchor: .topLeading)
        .scaleEffect(frame.scale, anchor: .topLeading)
        .position(x: frame.position.x + Self.size / 2, y: frame.position.y + Self.size / 2)

      // Opaque, like a tooltip (s10a): the label often sits over text, and glass let that text bleed through.
      Text(label)
        .textStyle(Tokens.TypeScale.calloutEmphasis)
        .foregroundStyle(p.ink1)
        .lineLimit(1)
        .padding(.horizontal, Tokens.Space.s12)
        .frame(height: Tokens.Size.chip + Tokens.Space.s4)
        .background(Capsule().fill(p.isDark ? Color(hex: 0x2C2C30) : .white))
        .overlay(Capsule().strokeBorder(p.ringStrong, lineWidth: 1))
        .compositingGroup()
        .shadow(color: .black.opacity(p.isDark ? 0.45 : 0.16), radius: 6, x: 0, y: 3)
        .fixedSize()
        .alignmentGuide(.leading) { d in labelLeft ? d.width : 0 }
        .offset(x: frame.position.x + (labelLeft ? -6 : Self.size + 4), y: frame.position.y + Self.size - 4)
        .opacity(frame.labelVisible ? 1 : 0)
        .animation(Motion.outExpo(Tokens.Duration.fast), value: frame.labelVisible)
    }
    .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
    .opacity(frame.opacity)
    .accessibilityElement()
    .accessibilityLabel(frame.labelVisible ? label : "")
  }
}

/// A cursor-like arrow with its tip at the top-left corner of its frame, pointing up-left.
struct ArrowShape: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    let w = r.width, h = r.height
    p.move(to: CGPoint(x: r.minX, y: r.minY))
    p.addLine(to: CGPoint(x: r.minX + w * 0.92, y: r.minY + h * 0.52))
    p.addLine(to: CGPoint(x: r.minX + w * 0.50, y: r.minY + h * 0.58))
    p.addLine(to: CGPoint(x: r.minX + w * 0.30, y: r.minY + h * 0.98))
    p.closeSubpath()
    return p
  }
}
