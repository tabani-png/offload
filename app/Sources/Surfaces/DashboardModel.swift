import Combine
import Foundation

/// Main-actor state for the dashboard window: data, J/K selection, the pointer request and observer pause.
@MainActor
final class DashboardModel: ObservableObject {
  @Published private(set) var data: DashboardData?
  @Published private(set) var selection = DashboardSelection([])
  @Published private(set) var pointer: PointerRequest?
  @Published private(set) var paused = false

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
    guard let d = try? await client.dashboard() else { return }
    set(d)
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
      if let id = selection.selectedId, let a = automations.first(where: { $0.id == id }) { point(at: a) }
    case .evidence: showEvidence()
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

  // MARK: pointer

  /// Where P on a row points: the first connector that is not ready, else the reason line.
  static func pointerTarget(for a: DashboardAutomation) -> (id: String, label: String) {
    if let c = a.connectors.first(where: { $0.state != .connected }) {
      let verb = c.state == .missingEnv ? "Add the \(c.name) key here" : "Connect \(c.name) here"
      return ("conn.\(a.id).\(c.id)", a.state == .needsYou ? "\(verb) and the waiting run finishes" : "\(verb) before it can run")
    }
    if a.state == .readyForReview { return ("row.\(a.id)", "Press ↩ to review it") }
    return ("row.\(a.id)", a.needsYouReason ?? a.name)
  }

  func point(at a: DashboardAutomation) {
    let t = Self.pointerTarget(for: a)
    startPointer(PointerRequest(targetId: t.id, originId: "lead.\(a.id)", label: t.label, startedAt: clock()))
  }

  /// "Show the evidence" on the timeline: fly to the span the top insight is built on.
  func showEvidence() {
    guard let d = data, let bar = d.days.flatMap(\.bars).first(where: { $0.id == MockBrainClient.evidenceBarId }) ?? d.days.flatMap(\.bars).first
    else { return }
    startPointer(PointerRequest(targetId: "bar.\(bar.id)", originId: "timeline.evidence",
                                label: Self.evidenceLabel(bar, tasks: d.tasks), startedAt: clock()))
  }

  static func evidenceLabel(_ bar: TimelineBar, tasks: [TimelineTask]) -> String {
    let minutes = Int((bar.end.timeIntervalSince(bar.start) / 60).rounded())
    let task = tasks.first { $0.id == bar.taskId }?.name.lowercased() ?? "this task"
    let dur = minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(minutes) min"
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

  func preview(_ d: DashboardData, pointer: PointerRequest? = nil) {
    set(d)
    self.pointer = pointer
  }
}
