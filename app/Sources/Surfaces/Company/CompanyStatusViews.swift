import SwiftUI

/// S2-13: company sync state where people already look. The rail gets one more hover line (a building mark with
/// the state dot); the dashboard gets one ringed row with the label, one quiet sentence and the next step.
/// Colour = state only: the dot is the only hue, the mark and the text stay ink.

/// The building glyph in a 40-pt glass capsule, like the rail's other capsules, with the state dot at its corner.
struct CompanyRailMark: View {
  var state: CompanySyncState
  var action: () -> Void = {}
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    Button(action: action) {
      Image(systemName: "building.2")
        .symbolStyle(Tokens.TypeScale.Symbol.large)
        .foregroundStyle(p.ink1)
        .frame(width: RailView.width, height: RailView.width)
        .glass(cornerRadius: RailView.width / 2, material: .popover)
        .overlay(alignment: .topTrailing) {
          Circle().fill(p.status(state.role))
            .frame(width: Tokens.Size.dot, height: Tokens.Size.dot)
            .overlay(Circle().strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
            .offset(x: -Tokens.Space.nudge, y: Tokens.Space.nudge)
        }
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel("Company: \(state.short)")
  }
}

/// The rail's hover line for company sync, in the same popover glass as the observer's lines.
struct CompanyRailLine: View {
  var state: CompanySyncState
  var now: Date = Date()
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    HStack(spacing: Tokens.Space.s8) {
      StatusDot(role: state.role, size: Tokens.Size.dot)
      Text(state.label(now: now)).textStyle(Tokens.TypeScale.label).monospacedDigit().foregroundStyle(p.ink1)
    }
    .padding(.horizontal, Tokens.Space.s12)
    .padding(.vertical, Tokens.Space.s8)
    .glass(cornerRadius: Tokens.Radius.row, material: .popover)
    .fixedSize()
  }
}

/// The dashboard's company row: mark, label, sentence, and one quiet next step (never a white primary: the
/// dashboard's page owns its one primary).
struct CompanySyncRow: View {
  var status: CompanyStatus
  var state: CompanySyncState
  var now: Date = Date()
  var onOpen: () -> Void = {}
  @Environment(\.colorScheme) private var scheme

  var nextStep: String {
    switch state {
    case .notConnected, .revoked: return "Connect…"
    case .waitingForNotice: return "Read the notice"
    case .notSetUp: return "Learn more"
    default: return "Open"
    }
  }

  var body: some View {
    let p = Palette(scheme: scheme)
    RingBox {
      HStack(alignment: .center, spacing: Tokens.Space.s12) {
        Image(systemName: "building.2").symbolStyle(Tokens.TypeScale.Symbol.large)
          .foregroundStyle(p.ink2)
          .frame(width: Tokens.Space.s32, height: Tokens.Space.s32)
          .background(RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous).fill(p.fill))
        VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
          HStack(spacing: Tokens.Space.s8) {
            Text(status.isConnected ? status.tenantLabel : "Company").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
            Chip(text: state.label(now: now), dot: state.role)
          }
          Text(state.detail(status)).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: Tokens.Space.s12)
        SecondaryButton(title: nextStep, action: onOpen)
      }
      .padding(.horizontal, Tokens.Space.s16)
      .padding(.vertical, Tokens.Space.s12)
    }
    .accessibilityElement(children: .combine)
  }
}
