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
  @Published var section: DashboardSection = DashboardSection.home
  /// s23: where the time goes (GET /time), for the week or one stored day (`timeDay`), and why it could not load.
  @Published private(set) var time: TimeBreakdown?
  @Published private(set) var timeDay: String?
  @Published private(set) var timeProblem: String?
  /// s23: the breakdown's dimension (task, app, kind of work).
  @Published var timeDimension: TimeDimension = .task
  /// The stored days of the week, for the day picker (kept while a day is shown).
  @Published private(set) var timeWeekDays: [String] = []
  @Published private(set) var keptFiles: [KeptFile] = []
  @Published private(set) var autoSend: AutoSendSheet?
  @Published private(set) var autoSendWorking = false
  /// s10e: the connect sheet while it is up, and which week the timeline shows.
  @Published private(set) var connect: ConnectSession?
  @Published var week: TimelineWeek = .this
  /// s14: needs-you lines that belong to Offload itself, not to an automation (local models not running).
  @Published var notices: [String] = []
  /// s14: the Claude captioner opt-in, and a tertiary note when the change waits for the next launch.
  @Published var claudeVision = false
  @Published var claudeVisionNote: String?
  var onClaudeVision: ((Bool) -> Void)?

  /// Offload's own needs-you lines plus the captioner's (GET /status captioner.needsYou).
  var allNotices: [String] {
    notices + [data?.observing.captioner?.needsYouLine, data?.observing.models?.needsYouLine].compactMap { $0 }
  }

  func toggleClaudeVision() {
    claudeVision.toggle()
    onClaudeVision?(claudeVision)
  }

  /// A sheet is up (auto-send or connect): the window behind is dimmed and keys go to the sheet.
  var sheetUp: Bool { autoSend != nil || connect != nil }

  enum AutoSendSheet: Equatable {
    /// Before: what turning it on does.
    case offer(automationId: String, workflowId: String, name: String)
    /// After: who it covers (the brain's pin).
    case result(AutoRunResult)
  }

  var onOpenWorkflow: ((String) -> Void)?
  /// s10f (M4): the sidebar's Connections link (⌘K).
  var onOpenConnections: (() -> Void)?
  /// s10e: the inbox (the empty Automations page's one action).
  var onOpenInbox: (() -> Void)?
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
    await loadTime()
  }

  /// s23: GET /time for the week (`day` nil) or one stored day. Reading time drafts nothing.
  func loadTime(day: String? = nil) async {
    do {
      let b = try await client.timeBreakdown(day: day)
      time = b
      timeDay = day
      if b.window.kind == .week { timeWeekDays = b.window.days }
      timeProblem = nil
    } catch {
      timeProblem = BrainError.message(for: error)
    }
  }

  func showTimeDay(_ day: String?) { Task { await loadTime(day: day) } }

  /// s23: a workflow is opened only from a finding whose best fix is a workflow, and only when the person asks: the
  /// existing draft flow (POST /workflows/draft), then the review window.
  func openInsight(_ insightId: String) {
    Task {
      do {
        let w = try await client.workflow(forInsight: insightId)
        onOpenWorkflow?(w.id)
      } catch {
        timeProblem = BrainError.message(for: error)
      }
    }
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

  // MARK: connect (s10e)

  /// Opens the connect sheet in the dashboard window. Connecting never turns anything on or sends.
  func openConnect(_ c: Connector) {
    let s = ConnectSession(connector: c, returnsToConfirm: false, client: client, clock: clock)
    s.onOpenURL = { [weak self] in self?.onOpenURL?($0) }
    s.onConnected = { [weak self] _ in Task { await self?.load() } }
    s.onClose = { [weak self] in self?.connect = nil }
    connect = s
  }

  /// Snapshots and QA: the sheet in a fixed phase.
  func previewConnect(_ c: Connector, link: ConnectLink?) {
    openConnect(c)
    if let link { connect?.preview(link) }
  }

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
      if let d = data { week = d.evidenceWeek }
      showEvidence()
    case .open:
      if let id = selection.selectedId, let a = automations.first(where: { $0.id == id }), let wf = a.workflowId {
        onOpenWorkflow?(wf)
      }
    case .escape: clearPointer()
    case .week:
      section = .week
      let weeks = data.map(TimelineWeek.available) ?? [.this]
      if weeks.count > 1 { week = week == .this ? .before : .this }
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
    startPointer(PointerRequest(targetId: t.id, originId: "lead.\(a.id)", label: t.label, startedAt: clock(), rowId: "rowband.\(a.id)"))
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

  /// s23 snapshots: the time screen on a fixed breakdown.
  func previewTime(_ b: TimeBreakdown, weekDays: [String] = NeutralWeek.days, dimension: TimeDimension = .task) {
    time = b
    timeDay = b.window.kind == .day ? b.window.days.first : nil
    timeWeekDays = weekDays
    timeDimension = dimension
    timeProblem = nil
    section = .time
  }

  func preview(_ d: DashboardData, pointer: PointerRequest? = nil, section: DashboardSection = .overview,
               keptFiles: [KeptFile] = MockBrainClient.sampleKeptFiles, autoSend: AutoSendSheet? = nil,
               week: TimelineWeek = .this) {
    set(d)
    self.week = week
    self.pointer = pointer
    self.section = section
    self.keptFiles = keptFiles
    self.autoSend = autoSend
  }
}
