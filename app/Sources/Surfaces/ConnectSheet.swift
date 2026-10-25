import Combine
import SwiftUI

/// s10e (DESIGN-REVIEW-3 M1): one connect, from the first press to "connected". Drives the pure `ConnectFlow` with the
/// brain's link route, polls once a second while waiting, opens the browser only for a real sign-in URL, and hands
/// back when the connector is connected. It never approves, arms or sends anything.
@MainActor
final class ConnectSession: ObservableObject {
  @Published private(set) var flow: ConnectFlow
  let returnsToConfirm: Bool

  /// The connector is connected: refresh states (the sheet stays up showing the green row).
  var onConnected: ((Connector) -> Void)?
  /// Back to where the sheet came from (the confirm sheet, or nothing).
  var onClose: (() -> Void)?
  var onOpenURL: ((URL) -> Void)?

  private let client: BrainClient
  private let clock: () -> Date
  private var pollTask: Task<Void, Never>?
  private var closeTask: Task<Void, Never>?
  /// After connecting, the sheet shows the green row this long, then goes back by itself.
  static let returnAfter: Double = 2.4

  init(connector: Connector, returnsToConfirm: Bool, client: BrainClient, clock: @escaping () -> Date = Date.init) {
    flow = ConnectFlow(connector: connector)
    self.returnsToConfirm = returnsToConfirm
    self.client = client
    self.clock = clock
  }

  var copy: ConnectCopy { ConnectCopy(flow: flow, returnsToConfirm: returnsToConfirm) }

  /// ⌘↩ / the white button: Connect, Try again, or (once connected) go back.
  func primary() {
    if flow.phase == .connected { close(); return }
    // s10e: after a failure the primary is the next method the brain offered.
    run(flow.phase == .failed ? flow.tryNext(at: clock()) : flow.connect(at: clock()))
  }

  /// Esc: stop waiting and go back. Nothing the brain started is undone (it never sends).
  func cancel() {
    flow.cancel()
    close()
  }

  func close() {
    pollTask?.cancel()
    closeTask?.cancel()
    onClose?()
  }

  /// Snapshots: put the flow in a phase without a brain.
  func preview(_ link: ConnectLink?) {
    _ = flow.connect(at: clock())
    if let link { _ = flow.receive(link, at: clock()) }
  }

  private func run(_ effects: [ConnectFlow.Effect]) {
    for e in effects {
      switch e {
      case .startLink:
        let id = flow.connector.id
        let method = flow.method
        pollTask?.cancel()
        pollTask = Task { [weak self] in
          guard let self else { return }
          do {
            let l = try await self.client.startLink(connectorId: id, method: method)
            self.run(self.flow.receive(l, at: self.clock()))
          } catch {
            self.flow.fail(ConnectCopy.didNotStart + " " + BrainError.message(for: error))
          }
        }
      case .poll:
        let id = flow.connector.id
        pollTask = Task { [weak self] in
          try? await Task.sleep(nanoseconds: UInt64(ConnectFlow.pollInterval * 1_000_000_000))
          guard let self, !Task.isCancelled else { return }
          guard self.flow.tick(at: self.clock()) == [.poll] else { return }
          do {
            let l = try await self.client.linkStatus(connectorId: id)
            self.run(self.flow.receive(l, at: self.clock()))
          } catch {
            self.flow.fail(BrainError.message(for: error))
          }
        }
      case .openURL(let url):
        onOpenURL?(url)
      case .connected:
        var c = flow.connector
        c.connected = true
        c.missingEnv = false
        onConnected?(c)
        closeTask = Task { [weak self] in
          try? await Task.sleep(nanoseconds: UInt64(Self.returnAfter * 1_000_000_000))
          guard let self, !Task.isCancelled else { return }
          self.close()
        }
      }
    }
  }
}

/// The sheet: what the tool is for, how it connects, one white action; then a blue spinner while you finish in the
/// browser; then a green "connected" row.
struct ConnectSheet: View {
  @ObservedObject var session: ConnectSession
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  static let width: CGFloat = Tokens.Layout.connectSheet

  var body: some View {
    let p = Palette(scheme: scheme)
    let copy = session.copy
    let phase = session.flow.phase
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: Tokens.Space.s12) {
        Image(systemName: copy.symbol).symbolStyle(Tokens.TypeScale.Symbol.large * 1.4)
          .foregroundStyle(p.ink1)
          .frame(width: Tokens.Space.s40, height: Tokens.Space.s40)
          .background(RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous).fill(p.fill))
          .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous).strokeBorder(p.ring, lineWidth: Tokens.Layout.hairline))
        VStack(alignment: .leading, spacing: Tokens.Space.nudge) {
          Text(copy.title).textStyle(Tokens.TypeScale.sheetTitle).foregroundStyle(p.ink1)
          Text(copy.route).textStyle(Tokens.TypeScale.footnote).foregroundStyle(p.ink3)
        }
      }
      Text(copy.purpose).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, Tokens.Space.s16)

      if let status = copy.status {
        RingBox {
          HStack(alignment: .center, spacing: Tokens.Space.s12) {
            switch phase {
            case .starting, .waiting:
              Spinner(role: .working)
            case .connected:
              StatusDot(role: .done, size: Tokens.Size.dot).frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
            default:
              StatusDot(role: .needsYou, size: Tokens.Size.dot).frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
            }
            Text(status).paragraphStyle(Tokens.TypeScale.label)
              .foregroundStyle(phase == .connected ? p.statusInk(.done) : p.ink1)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, Tokens.Space.s16)
          .padding(.vertical, Tokens.Space.s12)
        }
        .padding(.top, Tokens.Space.s16)
        .transition(.rise(reduceMotion: false))
      }
      if let note = copy.note {
        Text(note).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, Tokens.Space.s12)
      }
      HStack(spacing: Tokens.Space.s8) {
        Spacer()
        if phase != .connected {
          SecondaryButton(title: session.returnsToConfirm ? "Back" : "Cancel", key: "esc") { session.cancel() }
        }
        if let primary = copy.primary {
          PrimaryButton(title: primary, key: "⌘↩") { session.primary() }
        }
      }
      .padding(.top, Tokens.Space.s20)
    }
    .padding(Tokens.Space.s24)
    .frame(width: Self.width, alignment: .leading)
    .background(p.sheetFill)
    .animation(isSnapshot ? nil : Motion.outExpo(Tokens.Duration.base), value: phase)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(copy.title)
  }
}

/// A small blue arc that turns while something is in flight; frozen in snapshots and with Reduce Motion.
struct Spinner: View {
  var role: StatusRole = .working
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let c = Palette(scheme: scheme).status(role)
    Group {
      if isSnapshot || reduceMotion {
        arc(c, angle: 40)
      } else {
        TimelineView(.animation) { ctx in
          arc(c, angle: ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9 * 360)
        }
      }
    }
    .frame(width: Tokens.Space.s16, height: Tokens.Space.s16)
    .accessibilityLabel("Working")
  }

  private func arc(_ c: Color, angle: Double) -> some View {
    ZStack {
      Circle().stroke(c.opacity(0.22), lineWidth: Tokens.Layout.nowLine + 0.5)
      Circle().trim(from: 0, to: 0.3).stroke(c, style: StrokeStyle(lineWidth: Tokens.Layout.nowLine + 0.5, lineCap: .round))
        .rotationEffect(.degrees(angle))
    }
  }
}
