import Combine
import Foundation

/// Main-actor wrapper around the pure `InboxState`: owns the clock, the commit timer, evidence loading and
/// the rail's status. Views observe it; panels call `send(_:)` with mapped keys.
@MainActor
final class InboxModel: ObservableObject {
  @Published private(set) var state: InboxState
  @Published private(set) var evidence: [String: [EvidenceSpan]] = [:]
  @Published private(set) var status: ObserverStatus?
  @Published private(set) var automations: [Automation] = []
  @Published private(set) var pressedOption: Int?
  @Published var micRecording = false
  @Published var hoveringStatus = false

  /// Called when Esc peels past the last layer, or an action lands and the card should get out of the way.
  var onClose: (() -> Void)?
  /// Called when a staged action lands, so later slices can POST it to the brain.
  var onCommit: ((PendingAction) -> Void)?
  /// A connector chip's Connect… / Add key… action.
  var onConnect: ((Connector) -> Void)?

  private let client: BrainClient
  private let clock: () -> Date
  private var commitTimer: Timer?

  init(client: BrainClient, insights: [Insight] = [], clock: @escaping () -> Date = Date.init) {
    self.client = client
    self.clock = clock
    self.state = InboxState(insights: insights)
  }

  var rail: RailModel {
    var s = status ?? ObserverStatus(state: .watching, daysStored: 0, windowDays: 7, nextPurge: clock(), insightsWaiting: 0)
    s.insightsWaiting = state.insights.count
    return RailModel(status: s, automations: automations, micRecording: micRecording)
  }

  func load() async {
    do {
      async let st = client.status()
      async let ins = client.insights()
      async let autos = client.automations()
      let (s, i, a) = try await (st, ins, autos)
      // GET /connectors is best effort: without it the chips keep the insight's own state.
      let connectors = (try? await client.connectorStates()) ?? [:]
      status = s
      automations = a
      state.replaceInsights(i.map { $0.applying(connectorStates: connectors) })
    } catch {
      // Brain unreachable: the rail stays up in its neutral state; nothing is invented.
      status = nil
    }
  }

  func send(_ key: CardKey) {
    if case .option(let n) = key { flash(n) }
    apply(state.handle(key, at: clock()))
  }

  func togglePause() {
    guard var s = status else { return }
    s.state = s.state == .watching ? .paused : .watching
    status = s
  }

  private func apply(_ effects: [CardEffect]) {
    for effect in effects {
      switch effect {
      case .staged(let action):
        scheduleCommit(for: action)
      case .undone:
        commitTimer?.invalidate()
      case .committed(let action):
        commitTimer?.invalidate()
        onCommit?(action)
      case .showEvidence(let id):
        loadEvidence(id)
      case .close:
        onClose?()
      case .hideEvidence, .moved, .becameEmpty:
        break
      }
    }
    objectWillChange.send()
  }

  private func scheduleCommit(for action: PendingAction) {
    commitTimer?.invalidate()
    guard let deadline = state.pending?.deadline else { return }
    let timer = Timer(fire: deadline, interval: 0, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.apply(self.state.tick(at: max(self.clock(), deadline)))
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    commitTimer = timer
  }

  private func loadEvidence(_ id: String) {
    guard evidence[id] == nil else { return }
    Task {
      if let spans = try? await client.evidence(insightId: id) { evidence[id] = spans }
    }
  }

  private func flash(_ n: Int) {
    pressedOption = n
    DispatchQueue.main.asyncAfter(deadline: .now() + Tokens.Duration.press) { [weak self] in
      if self?.pressedOption == n { self?.pressedOption = nil }
    }
  }

  // MARK: snapshot support

  /// Puts the model in a fixed state for offscreen rendering.
  func preview(state: InboxState, evidence: [String: [EvidenceSpan]] = [:], status: ObserverStatus?,
               automations: [Automation], hoveringStatus: Bool = false, micRecording: Bool = false) {
    self.state = state
    self.evidence = evidence
    self.status = status
    self.automations = automations
    self.hoveringStatus = hoveringStatus
    self.micRecording = micRecording
  }
}
