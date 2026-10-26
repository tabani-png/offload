import AppKit
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
    // transform, not set: a target inside another target (or an obstacle) must not hide the inner one.
    transformAnchorPreference(key: PointerAnchorKey.self, value: .bounds) { $0[id] = $1 }
  }

  /// s10d: marks text the pointer's label must never cover. Shares the anchor key with targets; every anchor that is
  /// not the target is an obstacle for the label.
  func pointerObstacle(_ id: String) -> some View {
    transformAnchorPreference(key: PointerAnchorKey.self, value: .bounds) { $0["obstacle.\(id)"] = $1 }
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
  /// s10f (P9): the anchor of the table row the target sits in; the label then goes below that row.
  var rowId: String? = nil
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
      let targetRect = proxy[target]
      let obstacles = anchors.filter { $0.key != r.targetId && $0.key != r.rowId }.map { proxy[$0.value] }
      let row = r.rowId.flatMap { anchors[$0] }.map { proxy[$0] }
      let label = PointerLabelPlacement.place(
        label: PointerGlyph.labelSize(r.label), tip: flight.landing,
        arrow: CGSize(width: PointerGlyph.size, height: PointerGlyph.size),
        target: targetRect, obstacles: obstacles, bounds: bounds, row: row)
      if let frozenAt {
        PointerGlyph(frame: flight.frame(at: frozenAt), label: r.label, labelRect: label.rect, bounds: bounds)
      } else {
        TimelineView(.animation) { ctx in
          PointerGlyph(frame: flight.frame(at: ctx.date), label: r.label, labelRect: label.rect, bounds: bounds)
        }
      }
    }
  }
}

/// The arrow and its one-line label. The arrow's tip sits exactly on `frame.position`; the label sits where
/// `PointerLabelPlacement` found free space (s10d), never over the target or other text.
struct PointerGlyph: View {
  var frame: PointerFlight.Frame
  var label: String
  var labelRect: CGRect
  var bounds: CGRect
  @Environment(\.colorScheme) private var scheme

  static let size: CGFloat = 18
  static let labelHeight: CGFloat = Tokens.Size.chip + Tokens.Space.s4

  /// The label's size: its text in the callout-emphasis face plus the capsule's padding.
  static func labelSize(_ text: String) -> CGSize {
    let style = Tokens.TypeScale.calloutEmphasis
    let font = NSFont.systemFont(ofSize: style.size, weight: .medium)
    let w = (text as NSString).size(withAttributes: [.font: font, .kern: style.tracking]).width
    return CGSize(width: ceil(w) + Tokens.Space.s12 * 2 + 2, height: labelHeight)
  }

  var body: some View {
    let p = Palette(scheme: scheme)
    ZStack(alignment: .topLeading) {
      ArrowShape()
        .fill(p.status(.working))
        .overlay(ArrowShape().stroke(.white, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round)))
        .frame(width: Self.size, height: Self.size)
        .shadow(color: .black.opacity(0.35), radius: 3, x: 0, y: 1.5)
        .rotationEffect(.degrees(frame.angle - PointerFlight.restAngle), anchor: .topLeading)
        .scaleEffect(frame.scale, anchor: .topLeading)
        .position(x: frame.position.x + Self.size / 2, y: frame.position.y + Self.size / 2)

      // Opaque, like a tooltip (s10a): glass let the text under it bleed through.
      Text(label)
        .textStyle(Tokens.TypeScale.calloutEmphasis)
        .foregroundStyle(p.ink1)
        .lineLimit(1)
        .fixedSize()
        .frame(width: labelRect.width, height: labelRect.height)
        .background(Capsule().fill(p.isDark ? Color(hex: 0x2C2C30) : .white))
        .overlay(Capsule().strokeBorder(p.ringStrong, lineWidth: 1))
        .compositingGroup()
        .shadow(color: .black.opacity(p.isDark ? 0.45 : 0.16), radius: 6, x: 0, y: 3)
        .offset(x: labelRect.minX, y: labelRect.minY)
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
