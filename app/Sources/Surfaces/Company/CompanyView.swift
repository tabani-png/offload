import SwiftUI

/// S2-13: the Company window. One ringed header that says the state and holds the single white action (Connect
/// to company, or Read the notice), then what the company sees and never sees, the workflows I can share, and the
/// self-view link. Sheets attach under the toolbar like every other Offload window.
struct CompanyView: View {
  @ObservedObject var model: CompanyModel
  var now: Date = Date()
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  static let width: CGFloat = 720

  var body: some View {
    let p = Palette(scheme: scheme)
    CompanyScroll {
      VStack(alignment: .leading, spacing: Tokens.Space.s24) {
        header(p)
        if model.status.isConnected {
          WindowSection(title: CompanyCopy.sees, trailing: model.status.tenantLabel) {
            RingBox(padding: Tokens.Space.s16) {
              HStack(alignment: .top, spacing: Tokens.Space.s24) {
                VisibilityList(title: "Sees", symbol: "checkmark", items: CompanyVisibility.sees(model.status))
                VisibilityList(title: "Never sees", symbol: "xmark", items: CompanyVisibility.neverSees)
              }
              VStack(alignment: .leading, spacing: Tokens.Space.s8) {
                SectionHeader(title: CompanyCopy.featuresOn)
                FeatureChips(status: model.status)
              }
              .padding(.top, Tokens.Space.s16)
            }
          }
          shareSection(p)
          footer(p)
        }
      }
      .padding(Tokens.Space.s24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(p.canvas)
    .animation(isSnapshot ? nil : Motion.outExpo(Tokens.Duration.base), value: model.syncState)
    .onAppear { if !isSnapshot { model.refresh() } }
  }

  // MARK: header

  private var headerTitle: String {
    model.status.isConnected ? CompanyCopy.connected(model.status) : CompanyCopy.connect
  }

  private var primaryTitle: String? {
    switch model.syncState {
    case .notConnected, .revoked: return CompanyCopy.connect
    case .waitingForNotice: return CompanyCopy.readNotice
    default: return nil
    }
  }

  private func header(_ p: Palette) -> some View {
    let state = model.syncState
    return RingBox(padding: Tokens.Space.s20) {
      HStack(alignment: .top, spacing: Tokens.Space.s16) {
        Image(systemName: "building.2").symbolStyle(Tokens.TypeScale.Symbol.large * 1.4)
          .foregroundStyle(p.ink1)
          .frame(width: Tokens.Space.s40, height: Tokens.Space.s40)
          .background(RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous).fill(p.fill))
          .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous).strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
        VStack(alignment: .leading, spacing: Tokens.Space.s4) {
          Text(headerTitle).textStyle(Tokens.TypeScale.display).foregroundStyle(p.ink1)
          HStack(spacing: Tokens.Space.s8) {
            if state == .connecting { Spinner(role: .working) } else { StatusDot(role: state.role, size: Tokens.Size.dot) }
            Text(state.label(now: now)).textStyle(Tokens.TypeScale.label).monospacedDigit()
              .foregroundStyle(state.role == .neutral ? p.ink2 : p.statusInk(state.role))
          }
          Text(state.detail(model.status)).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .fixedSize(horizontal: false, vertical: true)
          if case .failed(let why) = model.connect {
            Text(why).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.statusInk(.needsYou))
              .fixedSize(horizontal: false, vertical: true)
          }
          if state == .notConnected || state == .revoked {
            Text(CompanyCopy.connectNote).paragraphStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.top, Tokens.Space.s4)
          }
        }
        Spacer(minLength: Tokens.Space.s12)
        if let title = primaryTitle {
          PrimaryButton(title: title, key: "⌘↩") { model.primary() }
        } else if state == .connecting, model.signInURL != nil {
          SecondaryButton(title: CompanyCopy.reopenSignIn) { model.reopenSignIn() }
        }
      }
    }
  }

  // MARK: share

  private func shareSection(_ p: Palette) -> some View {
    WindowSection(title: CompanyCopy.shareTitle, trailing: model.canShare ? nil : "After you read the notice") {
      RingBox {
        if model.workflows.isEmpty {
          Text("Workflows you turn on show up here, ready to share.").textStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
            .padding(Tokens.Space.s16)
        }
        ForEach(Array(model.workflows.enumerated()), id: \.element.id) { i, wf in
          if i > 0 { RowDivider() }
          HStack(spacing: Tokens.Space.s12) {
            VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
              Text(wf.name).textStyle(Tokens.TypeScale.label).foregroundStyle(p.ink1)
              Text(wf.status == .paused ? "Paused" : "Runs on this Mac").textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
            }
            Spacer(minLength: Tokens.Space.s12)
            SecondaryButton(title: CompanyCopy.shareAction) { model.share(workflowId: wf.id) }
              .disabled(!model.canShare || model.busy)
          }
          .padding(.horizontal, Tokens.Space.s16)
          .frame(minHeight: Tokens.Size.row + Tokens.Space.s16)
        }
      }
    }
  }

  // MARK: footer

  private func footer(_ p: Palette) -> some View {
    HStack(spacing: Tokens.Space.s12) {
      if model.selfViewURL != nil {
        Button(action: model.openSelfView) {
          HStack(spacing: Tokens.Space.s4) {
            Text(CompanyCopy.selfView).textStyle(Tokens.TypeScale.calloutEmphasis)
            Image(systemName: "arrow.up.right").symbolStyle(Tokens.TypeScale.Symbol.small, weight: .semibold)
          }
          .foregroundStyle(p.ink2)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityHint("Opens in your browser")
      }
      Spacer()
      if let m = model.message {
        Text(m).textStyle(Tokens.TypeScale.callout).foregroundStyle(p.statusInk(.needsYou)).lineLimit(2)
      }
      // Pause never waits for the notice; only Resume does.
      // Its own in-flight flag: a share or ack in progress never disables or swallows it.
      let paused = CompanyControls.isPaused(model.status)
      let title = model.pausing ? (model.pausingTo ? CompanyCopy.pausing : CompanyCopy.resuming)
                                : (paused ? CompanyCopy.resume : CompanyCopy.pause)
      SecondaryButton(title: title) { model.togglePause() }
        .disabled(model.pausing || (paused ? !CompanyControls.resumeEnabled(model.status) : !CompanyControls.pauseEnabled(model.status)))
    }
  }
}

/// The sheet the window shows right now, if any.
struct CompanySheetHost: View {
  @ObservedObject var model: CompanyModel

  var body: some View {
    switch model.sheet {
    case .notice: CompanyNoticeSheet(model: model)
    case .share(let preview): CompanyShareSheet(model: model, preview: preview)
    case nil: EmptyView()
    }
  }
}

/// The live window's root: the page with the attached sheet over it.
struct CompanyWindowRoot: View {
  @ObservedObject var model: CompanyModel

  var body: some View {
    CompanyView(model: model)
      .attachedSheet(model.sheet != nil) { CompanySheetHost(model: model) }
  }
}
