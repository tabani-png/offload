import Combine
import Foundation

/// Main-actor state for the dashboard window: data, J/K selection, the pointer request and observer pause.
@MainActor
final class DashboardModel: ObservableObject {
  @Published private(set) var data: DashboardData?
  @Published private(set) var selection = DashboardSelection([])
  @Published private(set) var pointer: PointerRequest?
  @Published private(set) var paused = false
  /// Why the dashboard could not load, as one calm sentence (s09a).
  @Published private(set) var problem: String?
  /// s10d: the sidebar's place, the files kept until you delete them, and the auto-send sheet.
  @Published var section: DashboardSection = .overview
  @Published private(set) var keptFiles: [KeptFile] = []
  @Published private(set) var autoSend: AutoSendSheet?
  @Published private(set) var autoSendWorking = false

  enum AutoSendSheet: Equatable {
    /// Before: what turning it on does.
    case offer(automationId: String, workflowId: String, name: String)
    /// After: who it covers (the brain's pin).
    case result(AutoRunResult)
  }

  var onOpenWorkflow: ((String) -> Void)?
  var onConnect: ((Connector) -> Void)?
  var onTogglePause: ((Bool) -> Void)?

  private let client: BrainClient
  private let clock: () -> Date
  private var pointerClear: DispatchWorkItem?

  /// Longest possible pointer run (two 1.4 s flights and the 3 s hold) plus a margin.
  static let pointerLifetime: Double = 1.4 * 2 + PointerFlight.hold + 0.4

  init(client: BrainClient, clock: @escaping () -> Date = Date.init) {
    self.client = client
    self.clock = clock
  }

  var automations: [DashboardAutomation] { DashboardOrder.sorted(data?.automations ?? []) }
  var now: Date { clock() }

  func load() async {
    do {
      set(try await client.dashboard())
      problem = nil
    } catch {
      problem = BrainError.message(for: error)
    }
    keptFiles = (try? await client.keptFiles()) ?? keptFiles
  }

  func show(_ s: DashboardSection) { section = s }

  // MARK: auto-send (s10d, brain s10b autoRunPin)

  func offerAutoSend(_ a: DashboardAutomation) {
    guard let wf = a.workflowId else { return }
    autoSend = .offer(automationId: a.id, workflowId: wf, name: a.name)
  }

  /// POST auto-run on; the sheet then shows who it covers, from the brain's pin.
  func confirmAutoSend() {
    guard case .offer(let id, let wf, _) = autoSend, !autoSendWorking else { return }
    autoSendWorking = true
    Task {
      defer { autoSendWorking = false }
      do {
        let r = try await client.setAutoRun(workflowId: wf, enabled: true)
        markAutoRun(id, on: r.enabled, people: r.pinnedRecipients.count)
        autoSend = .result(r)
      } catch {
        autoSend = nil
        problem = BrainError.message(for: error)
      }
    }
  }

  func turnOffAutoSend(_ a: DashboardAutomation) {
    guard let wf = a.workflowId else { return }
    Task {
      if (try? await client.setAutoRun(workflowId: wf, enabled: false)) != nil { markAutoRun(a.id, on: false, people: nil) }
    }
  }

  func dismissAutoSend() { autoSend = nil }

  private func markAutoRun(_ id: String, on: Bool, people: Int?) {
    guard var d = data, let i = d.automations.firstIndex(where: { $0.id == id }) else { return }
    d.automations[i].autoRun = on
    d.automations[i].autoRunPeople = people
    data = d
  }

  /// Fresh permission rows from the observer, without reloading the brain.
  func updatePermissions(_ rows: [PermissionState], paused observerPaused: Bool?) {
    guard var d = data else { return }
    d.observing.permissions = rows
    data = d
    if let observerPaused { paused = observerPaused }
  }

  func set(_ d: DashboardData) {
    data = d
    let keep = selection.selectedId
    selection = DashboardSelection(d.automations)
    if let keep { selection.select(keep) }
    paused = d.observing.state == .paused
  }

  func select(_ id: String) { selection.select(id) }

  func send(_ key: DashboardKey) {
    switch key {
    case .next, .previous: selection.move(key)
    case .point:
      if let id = selection.selectedId, let a = automations.first(where: { $0.id == id }) {
        section = .automations
        point(at: a)
      }
    case .evidence:
      section = .week
      showEvidence()
    case .open:
      if let id = selection.selectedId, let a = automations.first(where: { $0.id == id }), let wf = a.workflowId {
        onOpenWorkflow?(wf)
      }
    case .escape: clearPointer()
    }
  }

  func togglePause() {
    paused.toggle()
    onTogglePause?(paused)
  }

  /// s10d: the observer row's one action. Resume when paused or not recording; Settings when a grant is missing.
  var observerAction: ObserverAction {
    guard let d = data else { return .resume }
    return ObserverAction.forState(paused ? .paused : d.observing.state, permissions: d.observing.permissions)
  }

  func performObserverAction() {
    switch observerAction {
    case .pause:
      paused = true
      onTogglePause?(true)
    case .resume:
      paused = false
      if var d = data, d.observing.state == .stale { d.observing.state = .watching; data = d }
      onTogglePause?(false)
    case .openSettings(let url):
      onOpenURL?(url)
    }
  }

  var onOpenURL: ((URL) -> Void)?
  var onReveal: ((String) -> Void)?

  // MARK: pointer

  /// Where P on a row points (Core: DashboardPointer, so it is tested).
  static func pointerTarget(for a: DashboardAutomation) -> (id: String, label: String) { DashboardPointer.target(for: a) }

  func point(at a: DashboardAutomation) {
    let t = Self.pointerTarget(for: a)
    startPointer(PointerRequest(targetId: t.id, originId: "lead.\(a.id)", label: t.label, startedAt: clock()))
  }

  /// "Show the evidence" on the timeline: fly to the span the top insight is built on.
  func showEvidence() {
    guard let d = data, let bar = Self.evidenceBar(d) else { return }
    startPointer(PointerRequest(targetId: "bar.\(bar.id)", originId: "timeline.evidence",
                                label: Self.evidenceLabel(bar, tasks: d.tasks), startedAt: clock()))
  }

  static func evidenceBar(_ d: DashboardData) -> TimelineBar? { d.evidenceBar }

  static func evidenceLabel(_ bar: TimelineBar, tasks: [TimelineTask]) -> String {
    let minutes = Int((bar.end.timeIntervalSince(bar.start) / 60).rounded())
    let task = tasks.first { $0.id == bar.taskId }?.name.lowercased() ?? "this task"
    let dur = minutes >= 60 ? (minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min") : "\(minutes) min"
    return "\(Format.weekdayClock(bar.start)) · \(dur) of \(task), by hand"
  }

  func startPointer(_ r: PointerRequest) {
    pointer = r
    pointerClear?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.pointer = nil }
    pointerClear = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.pointerLifetime, execute: work)
  }

  func clearPointer() {
    pointerClear?.cancel()
    pointer = nil
  }

  // MARK: snapshot support

  func preview(_ d: DashboardData, pointer: PointerRequest? = nil, section: DashboardSection = .overview,
               keptFiles: [KeptFile] = MockBrainClient.sampleKeptFiles, autoSend: AutoSendSheet? = nil) {
    set(d)
    self.pointer = pointer
    self.section = section
    self.keptFiles = keptFiles
    self.autoSend = autoSend
  }
}
