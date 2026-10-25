import SwiftUI

// s06 components. Each reads its palette from the colour scheme and its numbers from Tokens.

// MARK: Keycap

/// A visible key. Every action has one (rule 7).
struct Keycap: View {
  var label: String
  var pressed = false
  var prominent = false
  /// Inside the white primary button: the same key, in the primary's own ink.
  var onPrimary = false
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.key, style: .continuous)
    Text(label)
      .textStyle(label.count > 2 ? Tokens.TypeScale.keyWord : Tokens.TypeScale.key)
      .monospacedDigit()
      // s10d: on the primary the key reads at 85% of the label's ink (62% was much fainter than the label).
      .foregroundStyle(onPrimary ? p.primaryInk.opacity(0.85) : (prominent ? p.ink1 : p.ink2))
      .padding(.horizontal, label.count > 1 ? Tokens.Space.s4 : 0)
      .frame(minWidth: Tokens.Size.key, minHeight: Tokens.Size.key)
      .background(shape.fill(onPrimary ? p.primaryInk.opacity(0.12) : (pressed ? p.ringStrong : p.fillStrong)))
      .overlay(shape.strokeBorder(onPrimary ? p.primaryInk.opacity(0.22) : p.ring, lineWidth: 1))
      // A faint lower lip gives the key its depth without a drop shadow.
      .overlay(
        shape.strokeBorder(
          LinearGradient(stops: [.init(color: .clear, location: 0.6),
                                 .init(color: .black.opacity(p.isDark ? 0.35 : 0.10), location: 1)],
                         startPoint: .top, endPoint: .bottom), lineWidth: 1))
      .scaleEffect(pressed ? Tokens.Motion.pressScale : 1)
      .accessibilityLabel("Key \(label)")
  }
}

// MARK: StatusDot

/// 8-pt dot in a status colour. `pulses` adds the live ring; Reduce Motion freezes it into a halo.
struct StatusDot: View {
  var role: StatusRole
  var pulses = false
  var size: CGFloat = Tokens.Size.dot
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let color = Palette(scheme: scheme).status(role)
    let plan = MotionPlan.pulse(reduceMotion: reduceMotion)
    ZStack {
      if pulses {
        if plan.repeats && !isSnapshot {
          TimelineView(.animation) { ctx in
            ring(color: color, phase: ctx.date.timeIntervalSinceReferenceDate
              .truncatingRemainder(dividingBy: plan.duration) / plan.duration)
          }
        } else {
          // Frozen: a still halo, the same footprint as mid-pulse.
          Circle().fill(color.opacity(0.18)).frame(width: size, height: size).scaleEffect(1.85)
        }
      }
      Circle().fill(color).frame(width: size, height: size)
    }
    .frame(width: size * 2.4, height: size * 2.4)
    .accessibilityLabel(role.rawValue)
  }

  private func ring(color: Color, phase: Double) -> some View {
    let eased = CubicBezier.outExpo.value(at: phase)
    return Circle()
      .fill(color.opacity(0.45 * (1 - eased)))
      .frame(width: size, height: size)
      .scaleEffect(1 + 1.4 * eased)
  }
}

// MARK: Chip

struct Chip: View {
  enum Style { case neutral, positive, recommended }
  var text: String
  var style: Style = .neutral
  var symbol: String? = nil
  var dot: StatusRole? = nil
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let (ink, fill, ring): (Color, Color, Color?) = {
      switch style {
      case .neutral: return (p.ink2, p.fill, p.ring)
      case .positive: let g = p.status(.done); return (p.statusInk(.done), g.opacity(0.14), g.opacity(0.22))
      // A tag, not a control: tint only, no ring (s10d removed the always-invisible one).
      case .recommended: return (p.statusInk(.needsYou), p.status(.needsYou).opacity(0.15), nil)
      }
    }()
    HStack(spacing: Tokens.Space.s4) {
      if let dot { Circle().fill(p.status(dot)).frame(width: Tokens.Size.dotSmall, height: Tokens.Size.dotSmall) }
      if let symbol { Image(systemName: symbol).symbolStyle(Tokens.TypeScale.Symbol.small) }
      Text(text).textStyle(style == .recommended ? Tokens.TypeScale.caption : Tokens.TypeScale.calloutEmphasis)
    }
    .foregroundStyle(ink)
    .padding(.horizontal, Tokens.Space.s8)
    .frame(height: style == .recommended ? Tokens.Size.tag : Tokens.Size.chip)
    .background(Capsule().fill(fill))
    .overlay { if let ring { Capsule().strokeBorder(ring, lineWidth: 1) } }
    .fixedSize()
  }
}

// MARK: OptionRow

/// A numbered choice. One may carry a quiet Recommended tag (rule 10).
struct OptionRow: View {
  enum State { case idle, highlighted, chosen, muted }
  var number: Int
  var title: String
  var recommended = false
  var state: State = .idle
  var pressed = false
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    HStack(spacing: Tokens.Space.s12) {
      Keycap(label: "\(number)", pressed: pressed, prominent: state == .highlighted)
      Text(title)
        .textStyle(Tokens.TypeScale.body)
        .foregroundStyle(state == .muted ? p.ink3 : p.ink1)
      Spacer(minLength: Tokens.Space.s8)
      if state == .chosen {
        Image(systemName: "checkmark")
          .symbolStyle(Tokens.TypeScale.Symbol.regular, weight: .semibold)
          .foregroundStyle(p.status(.working))
          .transition(.opacity)
      } else if recommended {
        Chip(text: "Recommended", style: .recommended)
      }
    }
    .padding(.leading, Tokens.Space.s8)
    .padding(.trailing, Tokens.Space.s12)
    .frame(height: Tokens.Size.row)
    .background(shape.fill(fill(p)))
    .overlay(shape.strokeBorder(ring(p), lineWidth: 1))
    .scaleEffect(pressed ? MotionPlan.press(reduceMotion: reduceMotion).scale : 1)
    .contentShape(shape)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
    .accessibilityHint(recommended ? "Recommended. Press \(number)." : "Press \(number).")
  }
}

extension OptionRow {
  /// A staged choice carries the working blue: it is in flight until the undo window closes.
  fileprivate func fill(_ p: Palette) -> Color {
    switch state {
    case .chosen: return p.status(.working).opacity(p.isDark ? 0.14 : 0.10)
    case .highlighted: return p.fillStrong
    case .idle, .muted: return p.fill
    }
  }

  fileprivate func ring(_ p: Palette) -> Color {
    switch state {
    case .chosen: return p.status(.working).opacity(0.45)
    case .highlighted: return p.ringStrong
    case .idle, .muted: return p.ring
    }
  }
}

// MARK: Buttons

/// The single white action in a view (rule 1). Near-black on light.
struct PrimaryButton: View {
  var title: String
  var key: String? = nil
  var action: () -> Void = {}
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    Button(action: action) {
      HStack(spacing: Tokens.Space.s8) {
        Text(title).textStyle(Tokens.TypeScale.label)
        if let key {
          // The same Keycap as everywhere else (s10a), toned for the primary fill.
          Keycap(label: key, onPrimary: isEnabled)
        } else {
          Image(systemName: "arrow.right").symbolStyle(Tokens.TypeScale.Symbol.regular)
        }
      }
      // s10d: disabled keeps its label, the way a disabled AppKit button does: a quiet fill and tertiary ink, never
      // a faded white pill with nothing on it.
      .foregroundStyle(isEnabled ? p.primaryInk : p.ink3)
      .padding(.leading, Tokens.Space.s16)
      .padding(.trailing, key == nil ? Tokens.Space.s16 : Tokens.Space.s8)
      .frame(height: Tokens.Size.control)
      .background(Capsule().fill(isEnabled ? p.primaryFill : p.fill))
      .overlay { if !isEnabled { Capsule().strokeBorder(p.ring, lineWidth: 1) } }
      .contentShape(Capsule())
    }
    .buttonStyle(PressStyle())
  }

  @Environment(\.isEnabled) private var isEnabled
}

/// Translucent companion to the primary.
struct SecondaryButton: View {
  var title: String
  var key: String? = nil
  var action: () -> Void = {}
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    Button(action: action) {
      HStack(spacing: Tokens.Space.s8) {
        Text(title).textStyle(Tokens.TypeScale.label)
        if let key { Keycap(label: key) }
      }
      .foregroundStyle(isEnabled ? p.ink1 : p.ink3)
      .padding(.leading, Tokens.Space.s16)
      .padding(.trailing, key == nil ? Tokens.Space.s16 : Tokens.Space.s8)
      .frame(height: Tokens.Size.control)
      .background(Capsule().fill(p.fillStrong))
      .overlay(Capsule().strokeBorder(p.ring, lineWidth: 1))
      .contentShape(Capsule())
    }
    .buttonStyle(PressStyle())
  }

  @Environment(\.isEnabled) private var isEnabled
}

// MARK: ProgressHairline

/// A 2-pt bar. Neutral for shares, a status colour for live progress (undo countdown is blue).
struct ProgressHairline: View {
  var fraction: Double
  var role: StatusRole? = nil
  var height: CGFloat = 2
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(p.track)
        Capsule()
          .fill(role.map { p.status($0) } ?? p.ink2)
          .frame(width: max(height, geo.size.width * min(1, max(0, fraction))))
      }
    }
    .frame(height: height)
    .accessibilityValue(Format.percent(fraction))
  }
}

// MARK: SectionHeader

struct SectionHeader: View {
  var title: String
  var trailing: String? = nil
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(alignment: .firstTextBaseline) {
      Text(title).textStyle(Tokens.TypeScale.caption).foregroundStyle(p.ink3)
      Spacer()
      if let trailing { Text(trailing).textStyle(Tokens.TypeScale.caption).monospacedDigit().foregroundStyle(p.ink3) }
    }
    .accessibilityAddTraits(.isHeader)
  }
}

// MARK: HintPill

/// Teaches the shortcut in context, detached under the card.
struct HintPill<Content: View>: View {
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(spacing: Tokens.Space.s4) { content }
      .textStyle(Tokens.TypeScale.callout)
      .foregroundStyle(p.ink2)
      .padding(.horizontal, Tokens.Space.s12)
      .frame(height: Tokens.Size.control)
      .glass(cornerRadius: Tokens.Size.control / 2, material: .popover)
  }
}

// MARK: Card

/// Floating glass card, radius 24. Inner wells use 16 at an 8-pt inset; rows 12 (concentric).
struct Card<Content: View>: View {
  var width: CGFloat = 400
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 0) { content }
      .frame(width: width, alignment: .leading)
      .glass(cornerRadius: Tokens.Radius.card)
  }
}

/// Recessed area inside a card: radius 16, meant to sit 8 pt in from the card edge.
struct Well<Content: View>: View {
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.well, style: .continuous)
    VStack(alignment: .leading, spacing: Tokens.Space.s12) { content }
      .padding(Tokens.Space.s12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(shape.fill(p.fill))
      .overlay(shape.strokeBorder(p.ring, lineWidth: 1))
  }
}

// MARK: Mark and EmptyState

/// Our own glyph: an open tray with a weight lifting off it. Code-drawn, no assets.
struct OffloadMark: View {
  var size: CGFloat = 40
  var lifted: Double = 1  // 0 = resting in the tray, 1 = fully lifted
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    let line = size * 0.075
    ZStack {
      TrayShape()
        .stroke(p.ink2, style: StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round))
        .frame(width: size * 0.78, height: size * 0.34)
        .offset(y: size * 0.24)
      RoundedRectangle(cornerRadius: size * 0.09, style: .continuous)
        .fill(p.ink1)
        .frame(width: size * 0.34, height: size * 0.26)
        .offset(y: size * (0.14 - 0.36 * lifted))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// A shallow U: the tray.
struct TrayShape: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    let radius = r.height * 0.55
    p.move(to: CGPoint(x: r.minX, y: r.minY))
    p.addLine(to: CGPoint(x: r.minX, y: r.maxY - radius))
    p.addQuadCurve(to: CGPoint(x: r.minX + radius, y: r.maxY), control: CGPoint(x: r.minX, y: r.maxY))
    p.addLine(to: CGPoint(x: r.maxX - radius, y: r.maxY))
    p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY - radius), control: CGPoint(x: r.maxX, y: r.maxY))
    p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
    return p
  }
}

/// Calm empty state. The lifted block drifts a few points; Reduce Motion holds it still.
struct EmptyState: View {
  var title: String
  var message: String
  var statusLabel: String? = nil
  var statusRole: StatusRole = .working
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(spacing: 0) {
      Group {
        if reduceMotion || isSnapshot {
          OffloadMark(size: 44, lifted: 1)
        } else {
          TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            OffloadMark(size: 44, lifted: 0.88 + 0.12 * (0.5 + 0.5 * sin(t * 2 * .pi / 4)))
          }
        }
      }
      .padding(.bottom, Tokens.Space.s16)
      Text(title).textStyle(Tokens.TypeScale.title).foregroundStyle(p.ink1)
      Text(message)
        .paragraphStyle(Tokens.TypeScale.body)
        .foregroundStyle(p.ink2)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s4)
      if let statusLabel {
        HStack(spacing: Tokens.Space.nudge) {
          StatusDot(role: statusRole, pulses: statusRole == .working, size: Tokens.Size.dotSmall)
          Text(statusLabel).textStyle(Tokens.TypeScale.caption).monospacedDigit().foregroundStyle(p.ink3)
        }
        .padding(.top, Tokens.Space.s16)
      }
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}
