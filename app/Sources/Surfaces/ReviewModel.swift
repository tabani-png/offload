import Combine
import Foundation

enum ReviewSheet: Equatable {
  case skill(editing: Bool)
  case confirm
  /// s10e: connecting a tool (from the confirm sheet, a chip or the footer). Carries the connector id.
  case connect(String)
}

/// Main-actor wrapper around the pure `ApprovalFlow`: owns the clock, the countdown timer, the dry-run calls and
/// which sheet is up. The window controller presents sheets and feeds keys; views only render.
@MainActor
final class ReviewModel: ObservableObject {
  @Published private(set) var flow: ApprovalFlow
  @Published private(set) var dryRun: DryRun?
  @Published private(set) var runningDryRun = false
  @Published private(set) var sheet: ReviewSheet?
  @Published private(set) var message: String?
  /// A section id the window should scroll to (QA and "show me the dry run").
  @Published var scrollRequest: String?
  /// s10d: a text box has focus, so R, E and S type letters instead of acting (the action bar says so).
  @Published var textEditing = false
  static let dryRunSectionId = "section.dryrun"
  /// s05c: the tone card and SKILL.md text from the brain, and the editable copy of the SKILL fields.
  @Published private(set) var tone: ToneCard?
  @Published private(set) var toneLoaded = false
  @Published private(set) var saving = false
  @Published private(set) var skillDoc: SkillDoc?
  @Published var skillEdit: SkillDoc?
  @Published var toneDraft: String
  @Published var skillDraft: String

  /// s10e: the connect sheet's session while it is up.
  @Published private(set) var connect: ConnectSession?
  /// s10e: "Edit notes" under the voice facts shows the text box.
  @Published var editingVoice = false
  /// s14: POST /workflows/:id/plan is in flight.
  @Published private(set) var choosingPlan = false
  /// s14: keyboard focus on a step's tool row (T), and a POST /workflows/:id/tools in flight.
  @Published private(set) var toolFocus: ToolFocus?
  @Published private(set) var choosingTool = false
  var onOpenURL: ((URL) -> Void)?

  var onApproved: ((Workflow) -> Void)?
  var onDiscarded: ((String) -> Void)?
  var onConnect: ((Connector) -> Void)?

  private let client: BrainClient
  private let clock: () -> Date
  private var timer: Timer?
  /// Instances per dry run (each one is a model call on the real brain).
  let dryRunLimit: Int

  init(workflow: Workflow, dryRun: DryRun?, client: BrainClient, dryRunLimit: Int = 5, clock: @escaping () -> Date = Date.init) {
    flow = ApprovalFlow(workflow: workflow)
    self.dryRun = dryRun
    self.client = client
    self.dryRunLimit = dryRunLimit
    self.clock = clock
    toneDraft = workflow.toneCard
    skillDraft = workflow.skillMarkdown
    if let dryRun { adoptBatchHash(from: dryRun) }
  }

  /// The approval is for the dry run you are looking at: its hash replaces whatever the workflow carried.
  private func adoptBatchHash(from d: DryRun) {
    let w = flow.workflow.adopting(d)
    if w != flow.workflow { flow.replaceWorkflow(w) }
  }

  var workflow: Workflow { flow.workflow }
  var toneEdited: Bool { toneDraft != workflow.toneCard || workflow.toneEdited }
  /// The draft differs from what the brain holds: Save is offered.
  var toneUnsaved: Bool { toneLoaded && toneDraft != (tone?.text ?? "") }
  var skillUnsaved: Bool {
    guard let a = skillDoc, let b = skillEdit else { return false }
    return !SkillEdit.diff(from: a, to: b).isEmpty
  }

  /// GET tone and skill. Failures leave the window as it was and say so once.
  func loadEditables() {
    let id = workflow.id
    Task {
      do {
        let t = try await client.toneCard(workflowId: id)
        tone = t
        var w = workflow
        w.toneCard = t.text ?? ""
        w.toneEdited = t.edited
        flow.replaceWorkflow(w)
        toneDraft = t.text ?? ""
      } catch {
        NSLog("Offload: tone card: %@", String(describing: error))
      }
      toneLoaded = true
      if let d = try? await client.skill(workflowId: id) {
        skillDoc = d
        skillDraft = d.skillMd
      }
    }
  }

  func saveTone() {
    guard toneUnsaved, !saving else { return }
    let text = toneDraft
    if let max = tone?.maxBytes, !ToneCard.fits(text, maxBytes: max) {
      message = "That is too long for your voice. Keep it under \(max / 1024) KB."
      return
    }
    saving = true
    Task {
      defer { saving = false }
      do {
        let t = try await client.saveToneCard(workflowId: workflow.id, text: text)
        tone = t
        var w = workflow
        w.toneCard = t.text ?? ""
        w.toneEdited = t.edited
        flow.replaceWorkflow(w)
        message = "Your voice is saved. The next dry run writes in it."
      } catch {
        message = "Your voice was not saved. \(BrainError.message(for: error))"
      }
    }
  }

  func saveSkill() {
    guard let old = skillDoc, let new = skillEdit, !saving else { return }
    let problems = SkillEdit.problems(new)
    if let first = problems.first { message = first; return }
    let edit = SkillEdit.diff(from: old, to: new)
    if edit.isEmpty { sheet = nil; return }
    saving = true
    Task {
      defer { saving = false }
      do {
        let d = try await client.saveSkill(workflowId: workflow.id, edit: edit)
        skillDoc = d
        skillEdit = d
        skillDraft = d.skillMd
        if let w = try? await client.workflow(id: workflow.id) {
          var w = w.adopting(dryRun ?? DryRun(workflowId: "", ranAt: Date(), items: [], deniedSideEffects: 0))
          w.toneCard = workflow.toneCard
          w.toneEdited = workflow.toneEdited
          if w.batchHash.isEmpty { w.batchHash = workflow.batchHash }
          flow.replaceWorkflow(w)
        }
        message = "Steps saved. Run the dry run again to see them."
        sheet = nil
      } catch {
        if case .badRequest(let m)? = error as? BrainError {
          message = "Not saved. \(BrainError.sentence(m))"
        } else {
          message = "Not saved. \(BrainError.message(for: error))"
        }
      }
    }
  }

  /// Snapshots: the steps as the editor shows them, from the workflow (the brain's GET /skill live).
  var previewSkillDoc: SkillDoc {
    let w = workflow
    return SkillDoc(workflowId: w.id, skillMd: w.skillMarkdown, description: w.summary,
                    steps: w.steps.map { SkillStep(id: $0.id, type: $0.type.rawValue, title: $0.title, detail: $0.detail,
                                                   connector: $0.connectorId, sideEffect: $0.type.isSideEffect) },
                    gates: w.steps.filter(\.isGate).map(\.id),
                    limits: .init(descriptionChars: 400, titleChars: 80, detailChars: 400))
  }

  /// s14: the typed plan of a general workflow, and the generic dry run. nil for the email workflows.
  var planCopy: PlanCopy? { workflow.plan.map { PlanCopy(plan: $0) } }
  var generalCopy: GeneralDryRunCopy? {
    guard let d = dryRun, let g = d.general else { return nil }
    return GeneralDryRunCopy(g, ranAt: d.ranAt)
  }

  /// s14: keep the other variant (1 or 2, or a click). The brain answers with the workflow detail.
  func choosePlan(_ variant: String) {
    guard let plan = workflow.plan, plan.chosen != variant, !choosingPlan,
          let v = plan.variants.first(where: { $0.id == variant }) else { return }
    choosingPlan = true
    let id = workflow.id
    Task {
      defer { choosingPlan = false }
      do {
        var w = try await client.choosePlan(workflowId: id, variant: variant)
        w.toneCard = workflow.toneCard
        w.toneEdited = workflow.toneEdited
        if w.batchHash.isEmpty { w.batchHash = workflow.batchHash }
        flow.replaceWorkflow(w)
        message = "Using \(v.label.lowercased()). Press R to run the dry run with it."
      } catch {
        message = "The plan was not changed. \(BrainError.message(for: error))"
      }
    }
  }

  /// s14: T moves the focus to the next step's tool row.
  func focusNextTool() { toolFocus = ToolFocus.next(after: toolFocus, tools: workflow.tools) }
  func moveTool(_ delta: Int) { toolFocus?.move(delta, tools: workflow.tools) }
  func clearToolFocus() { toolFocus = nil }

  /// ↩ on a focused tool row: keep the option under the focus.
  func confirmTool() {
    guard let f = toolFocus else { return }
    if let p = f.pick(workflow.tools) { chooseTool(stepId: p.stepId, toolId: p.toolId) } else { toolFocus = nil }
  }

  /// Keep another tool for a step. The brain resets the dry run, so the review asks for a new one.
  func chooseTool(stepId: String, toolId: String) {
    guard !choosingTool, let t = workflow.tools.first(where: { $0.stepId == stepId }), t.chosen != toolId else { return }
    choosingTool = true
    let id = workflow.id
    Task {
      defer { choosingTool = false }
      do {
        var w = try await client.chooseTool(workflowId: id, stepId: stepId, toolId: toolId)
        w.toneCard = workflow.toneCard
        w.toneEdited = workflow.toneEdited
        flow.replaceWorkflow(w)
        dryRun = nil
        toolFocus = nil
        message = ToolsCopy.changed
      } catch {
        message = "The tool was not changed. \(BrainError.message(for: error))"
      }
    }
  }

  /// Snapshots: the focus on a step's row at an option.
  func previewToolFocus(_ f: ToolFocus?) { toolFocus = f }

  /// Every string the window shows (s10a).
  var copy: ReviewCopy { ReviewCopy(workflow: workflow, dryRun: dryRun, running: runningDryRun) }

  func send(_ key: ReviewKey) {
    // s10e: while the connect sheet is up, Esc goes back and ⌘↩ / ↩ press its primary.
    if let s = connect, case .connect = sheet {
      switch key {
      case .escape: s.cancel()
      case .approve, .confirm: s.primary()
      default: break
      }
      return
    }
    // s10a: Turn on is disabled while a connector a later step needs is missing; ↩ and ⌘↩ say why instead.
    // s10d: the reason is already in the sheet, once, as the amber lines. ↩ / ⌘↩ press the sheet's primary, which
    // while blocked is "Connect …".
    if !ArmGuard.allows(key, flow: flow) {
      connectFirstMissing()
      return
    }
    // s10f (M3): on a sample dry run the footer's primary is Run with my voice, on ⌘↩.
    if key == .approve, case .reviewing = flow.phase, sheet == nil, dryRun?.isSample == true {
      runWithVoice()
      return
    }
    // s10e (M8): in the review itself, while a step is blocked the footer's primary is Connect, on ⌘↩.
    if key == .approve, case .reviewing = flow.phase, sheet == nil, case .connect(let c) = ReviewPrimary.forWorkflow(workflow) {
      openConnect(c)
      return
    }
    apply(flow.handle(key, at: clock()))
  }

  /// The footer's Approve, pressed with the mouse while it is secondary: opens the confirmation as ⌘↩ used to.
  func approveNow() { apply(flow.handle(.approve, at: clock())) }

  /// The confirm sheet's primary while Turn on is blocked.
  func connectFirstMissing() {
    if let c = flow.plan.missing.first { openConnect(c) }
  }

  /// s10e: the connect sheet, over the confirm sheet's place when that is up (and back to it after).
  func openConnect(_ c: Connector) {
    let s = ConnectSession(connector: c, returnsToConfirm: flow.isConfirmOpen, client: client, clock: clock)
    s.onOpenURL = { [weak self] in self?.onOpenURL?($0) }
    s.onConnected = { [weak self] k in self?.connected(k) }
    s.onClose = { [weak self] in self?.closeConnect() }
    connect = s
    sheet = .connect(c.id)
  }

  func closeConnect() {
    connect = nil
    sheet = flow.isConfirmOpen ? .confirm : nil
  }

  private func connected(_ c: Connector) {
    flow.updateConnectors([:], connected: c)
    Task {
      if let states = try? await client.connectorStates() { flow.updateConnectors(states, connected: c) }
    }
  }

  func dismissSheet() {
    if case .connect = sheet { connect?.cancel(); return }
    if sheet == .confirm { send(.escape) } else { sheet = nil }
  }

  /// The newest stored dry run first (GET /workflows/:id/dry-runs/latest, s09b); only when there is none does
  /// opening the window draft a new one. R always runs again.
  func loadDryRunIfNeeded() {
    guard dryRun == nil, !runningDryRun else { return }
    runningDryRun = true
    let id = workflow.id
    Task {
      let latest = try? await client.latestDryRun(workflowId: id)
      if let d = latest, d.workflowId == id || d.workflowId.isEmpty {
        dryRun = d
        adoptBatchHash(from: d)
        runningDryRun = false
      } else {
        runningDryRun = false
        rerun()
      }
    }
  }

  private func apply(_ effects: [ApprovalFlow.Effect]) {
    for e in effects {
      switch e {
      case .openConfirm:
        sheet = .confirm
      case .closeConfirm:
        if sheet == .confirm { sheet = nil }
      case .armed, .discardStaged:
        scheduleTick()
      case .cancelled, .discardUndone:
        timer?.invalidate()
      case .approved(let id, let hash):
        timer?.invalidate()
        Task {
          do {
            let w = try await client.approve(workflowId: id, batchHash: hash)
            flow.replaceWorkflow(w)
            message = ReviewMessages.approved(w, now: clock())
            onApproved?(w)
          } catch {
            message = ReviewMessages.approvalFailed(error)
          }
        }
      case .discarded(let id):
        timer?.invalidate()
        Task {
          try? await client.discard(workflowId: id)
          onDiscarded?(id)
        }
      case .edit:
        skillEdit = skillDoc
        sheet = .skill(editing: true)
      case .showSkill:
        // s10d: the page already lists the steps; S opens the one place that changes them.
        skillEdit = skillDoc
        sheet = .skill(editing: true)
      case .rerunDryRun:
        rerun()
      }
    }
  }

  /// s10f (M3): the sample run's primary. Runs the dry run again; if the brain still drafts with the offline sample
  /// model, the bar says so instead of pretending the drafts are in your voice.
  func runWithVoice() {
    guard !runningDryRun else { return }
    rerun(wantVoice: true)
  }

  private func rerun(wantVoice: Bool = false) {
    runningDryRun = true
    let id = workflow.id
    Task {
      defer { runningDryRun = false }
      do {
        let d = try await client.dryRun(workflowId: id, limit: dryRunLimit)
        dryRun = d
        adoptBatchHash(from: d)
        message = wantVoice && d.isSample ? ReviewCopy.stillSample : nil
      } catch {
        message = ReviewMessages.dryRunFailed(error)
      }
    }
  }

  private func scheduleTick() {
    timer?.invalidate()
    guard let deadline = flow.countdown?.deadline else { return }
    let t = Timer(fire: deadline, interval: 0, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.apply(self.flow.tick(at: max(self.clock(), deadline)))
      }
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  // MARK: snapshot support

  /// Puts the model into a fixed state for offscreen rendering, by replaying keys at fixed times.
  func preview(keys: [(ReviewKey, Date)], sheet: ReviewSheet? = nil) {
    for (k, at) in keys { _ = flow.handle(k, at: at) }
    self.sheet = sheet ?? (flow.isConfirmOpen ? .confirm : nil)
  }

  /// Snapshots: the connect sheet for `c` in a fixed phase (nil link = the intro).
  func previewConnect(_ c: Connector, link: ConnectLink?) {
    openConnect(c)
    if let link { connect?.preview(link) }
  }

  /// Snapshots: as after connecting `c`, back on the confirm sheet.
  func previewConnected(_ c: Connector) {
    flow.updateConnectors([:], connected: c)
  }
}
