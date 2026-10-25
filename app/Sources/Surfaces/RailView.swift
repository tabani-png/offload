import SwiftUI

/// The edge rail: three glass capsules stacked at the right screen edge.
/// Inbox (amber badge while an insight waits) · status (observer dot + one per active automation) · tools.
struct RailView: View {
  var rail: RailModel
  var hoveringStatus: Bool
  var onInbox: () -> Void = {}
  var onPause: () -> Void = {}
  var onMic: () -> Void = {}
  var onMore: () -> Void = {}
  var onHoverStatus: (Bool) -> Void = { _ in }
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let width: CGFloat = 40

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(alignment: .statusCenter, spacing: Tokens.Space.s8) {
      if hoveringStatus {
        // s10d: one line per dot, in the dots' order and shapes, so each dot has a name.
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          ForEach(rail.hoverLines, id: \.id) { line in
            HStack(spacing: Tokens.Space.s8) {
              RailMark(role: line.role, observer: line.id == "observer", pulses: false)
              Text(line.text).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink1)
            }
          }
        }
        .padding(.horizontal, Tokens.Space.s12)
        .padding(.vertical, Tokens.Space.s8)
        .glass(cornerRadius: Tokens.Radius.row, material: .popover)
        .fixedSize()
        .transition(.rise(reduceMotion: reduceMotion))
        .alignmentGuide(.statusCenter) { $0[VerticalAlignment.center] }
      }
      VStack(spacing: Tokens.Space.s8) {
        inbox(p)
        status(p)
          .onHover { onHoverStatus($0) }
          .alignmentGuide(.statusCenter) { $0[VerticalAlignment.center] }
        tools(p)
      }
    }
    .animation(Motion.outExpo(), value: hoveringStatus)
  }

  private func inbox(_ p: Palette) -> some View {
    Button(action: onInbox) {
      Image(systemName: "tray")
        .symbolStyle(Tokens.TypeScale.Symbol.large)
        .foregroundStyle(p.ink1)
        .frame(width: Self.width, height: Self.width)
        .glass(cornerRadius: Self.width / 2, material: .popover)
        .overlay(alignment: .topTrailing) {
          if let badge = rail.inboxBadge {
            // s10d: insights waiting are suggestions, not alarms: a neutral count. Amber stays for what needs you.
            Text(badge)
              .textStyle(Tokens.TypeScale.badge)
              .monospacedDigit()
              .foregroundStyle(p.primaryInk)
              .frame(minWidth: Tokens.Space.s16, minHeight: Tokens.Space.s16)
              .background(Circle().fill(p.ink1))
              .offset(x: Tokens.Space.nudge, y: -Tokens.Space.nudge)
              .transition(.scale.combined(with: .opacity))
          }
        }
        .contentShape(Circle())
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel(rail.inboxBadge.map { "Inbox, \($0) waiting" } ?? "Inbox")
    .help("Inbox · ⌥Space")
  }

  private func status(_ p: Palette) -> some View {
    VStack(spacing: 0) {
      // s10d: the observer is a ring, set apart by a hairline; automations are solid dots below it.
      ForEach(Array(rail.dots.enumerated()), id: \.element.id) { i, dot in
        if i == 1 {
          Rectangle().fill(p.ring).frame(width: Tokens.Space.s16, height: Tokens.Layout.hairline)
            .padding(.vertical, Tokens.Space.nudge)
        }
        RailMark(role: dot.role, observer: dot.id == "observer", pulses: dot.pulses)
          .frame(width: Self.width, height: Tokens.Size.tag)
          .help(dot.id == "observer" ? rail.observerLabel : (rail.dotNames[dot.id] ?? ""))
      }
      if rail.overflowCount > 0 {
        Text("+\(rail.overflowCount)")
          .textStyle(Tokens.TypeScale.caption)
          .foregroundStyle(p.ink3)
          .frame(height: Tokens.Space.s16)
      }
    }
    .padding(.vertical, Tokens.Space.s8)
    .frame(width: Self.width)
    .glass(cornerRadius: Self.width / 2, material: .popover)
    .contentShape(Capsule())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(rail.hoverLabel)
  }

  private func tools(_ p: Palette) -> some View {
    VStack(spacing: 0) {
      toolButton(rail.observerResumable ? "play.fill" : "pause.fill", ink: p.ink2,
                 label: rail.observerResumable ? "Resume watching" : "Pause watching", action: onPause)
      toolButton(rail.micRole == .recording ? "mic.fill" : "mic",
                 ink: rail.micRole == .recording ? p.status(.recording) : p.ink2,
                 label: rail.micRole == .recording ? "Stop listening" : "Talk", action: onMic)
      toolButton("ellipsis", ink: p.ink2, label: "More", action: onMore)
    }
    .padding(.vertical, Tokens.Space.s4)
    .frame(width: Self.width)
    .glass(cornerRadius: Self.width / 2, material: .popover)
  }

  private func toolButton(_ symbol: String, ink: Color, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .symbolStyle(Tokens.TypeScale.Symbol.regular)
        .foregroundStyle(ink)
        .frame(width: Self.width, height: Tokens.Size.control)
        .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel(label)
    .help(label)
  }
}

/// Live rail bound to the model.
struct LiveRail: View {
  @ObservedObject var model: InboxModel
  var onInbox: () -> Void
  var onMore: () -> Void

  var body: some View {
    RailView(rail: model.rail, hoveringStatus: model.hoveringStatus,
             onInbox: onInbox,
             onPause: { model.togglePause() },
             onMic: { model.micRecording.toggle() },
             onMore: onMore,
             onHoverStatus: { model.hoveringStatus = $0 })
  }
}

extension VerticalAlignment {
  private enum StatusCenter: AlignmentID {
    static func defaultValue(in d: ViewDimensions) -> CGFloat { d[VerticalAlignment.center] }
  }
  /// Lines the hover label up with the status capsule, not the whole rail.
  static let statusCenter = VerticalAlignment(StatusCenter.self)
}

/// s10d: a rail status mark. The observer is a ring (it watches); an automation is a solid dot (it does). Same
/// colours as everywhere: blue in flight, amber needs you, green done, grey paused.
struct RailMark: View {
  var role: StatusRole
  var observer: Bool
  var pulses: Bool
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    if observer {
      let c = Palette(scheme: scheme).status(role)
      ZStack {
        if pulses { StatusDot(role: role, pulses: true, size: Tokens.Size.dot).opacity(0.6) }
        Circle().strokeBorder(c, lineWidth: Tokens.Layout.nowLine + 0.5)
          .frame(width: Tokens.Size.dot + Tokens.Space.nudge, height: Tokens.Size.dot + Tokens.Space.nudge)
        Circle().fill(c).frame(width: Tokens.Space.nudge + 1, height: Tokens.Space.nudge + 1)
      }
      .frame(width: Tokens.Size.dot * 2.4, height: Tokens.Size.dot * 2.4)
      .accessibilityLabel("Observer")
    } else {
      StatusDot(role: role, pulses: pulses, size: Tokens.Size.dot)
    }
  }
}
