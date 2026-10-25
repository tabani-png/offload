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
        Text(rail.hoverLabel)
          .textStyle(Tokens.TypeScale.label)
          .monospacedDigit()
          .foregroundStyle(p.ink1)
          .padding(.horizontal, Tokens.Space.s12)
          .frame(height: Tokens.Size.chip + Tokens.Space.s8)
          .glass(cornerRadius: (Tokens.Size.chip + Tokens.Space.s8) / 2, material: .popover)
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
            Text(badge)
              .textStyle(Tokens.TypeScale.badge)
              .monospacedDigit()
              .foregroundStyle(p.onStatus(.needsYou))
              .frame(minWidth: Tokens.Space.s16, minHeight: Tokens.Space.s16)
              .background(Circle().fill(p.status(.needsYou)))
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
      ForEach(rail.dots) { dot in
        StatusDot(role: dot.role, pulses: dot.pulses, size: Tokens.Size.dot)
          .frame(width: Self.width, height: Tokens.Size.tag)
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
      toolButton(rail.observerPaused ? "play.fill" : "pause.fill", ink: p.ink2,
                 label: rail.observerPaused ? "Resume watching" : "Pause watching", action: onPause)
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
