import SwiftUI

/// S2-13: company sync state where people already look. The rail gets a building mark with the state dot (only once
/// a company is in play; its tooltip says the state); the dashboard gets one ringed row with the label, one quiet
/// sentence and the next step.
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

  /// The chip stays short so the row never squeezes the name; the sentence under it says the rest.
  var chipText: String {
    if case .syncing = state { return state.label(now: now) }
    return state.short
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
            Text(status.isConnected ? status.tenantLabel : "Connect your company").textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
              .fixedSize().layoutPriority(1)
            Chip(text: chipText, dot: state.role)
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

/// A ScrollView live; in snapshots the content itself, top-aligned and clipped (ImageRenderer draws no
/// NSScrollView content), the way the dashboard and Connections pages do it.
struct CompanyScroll<Content: View>: View {
  var axes: Axis.Set = .vertical
  @ViewBuilder var content: Content
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    if isSnapshot {
      content.frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading).clipped()
    } else {
      ScrollView(axes) { content }
    }
  }
}
