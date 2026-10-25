import Combine
import Foundation

enum ReviewSheet: Equatable {
  case skill(editing: Bool)
  case confirm
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
  static let dryRunSectionId = "section.dryrun"
  /// s05c: the tone card and SKILL.md text from the brain, and the editable copy of the SKILL fields.
  @Published private(set) var tone: ToneCard?
  @Published private(set) var toneLoaded = false
  @Published private(set) var saving = false
  @Published private(set) var skillDoc: SkillDoc?
  @Published var skillEdit: SkillDoc?
  @Published var toneDraft: String
  @Published var skillDraft: String

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
      message = "The tone card is too long. Keep it under \(max / 1024) KB."
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
        message = "Tone card saved. The next dry run writes in it."
      } catch {
        message = "Tone card not saved. \(BrainError.message(for: error))"
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
        message = "SKILL.md saved. Run the dry run again to see it."
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

  func send(_ key: ReviewKey) { apply(flow.handle(key, at: clock())) }

  func dismissSheet() {
    if sheet == .confirm { send(.escape) } else { sheet = nil }
  }

  func loadDryRunIfNeeded() {
    guard dryRun == nil, !runningDryRun else { return }
    rerun()
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
        sheet = .skill(editing: false)
      case .rerunDryRun:
        rerun()
      }
    }
  }

  private func rerun() {
    runningDryRun = true
    let id = workflow.id
    Task {
      defer { runningDryRun = false }
      do {
        let d = try await client.dryRun(workflowId: id, limit: dryRunLimit)
        dryRun = d
        adoptBatchHash(from: d)
        message = nil
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
}
