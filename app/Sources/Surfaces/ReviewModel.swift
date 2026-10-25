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
  @Published var toneDraft: String
  @Published var skillDraft: String

  var onApproved: ((Workflow) -> Void)?
  var onDiscarded: ((String) -> Void)?
  var onConnect: ((Connector) -> Void)?

  private let client: BrainClient
  private let clock: () -> Date
  private var timer: Timer?

  init(workflow: Workflow, dryRun: DryRun?, client: BrainClient, clock: @escaping () -> Date = Date.init) {
    flow = ApprovalFlow(workflow: workflow)
    self.dryRun = dryRun
    self.client = client
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
            message = "Turned on. First run \(Format.runTime(w.schedule.nextRunAt, now: clock(), past: false))."
            onApproved?(w)
          } catch {
            message = "The brain did not accept the approval. Nothing was turned on."
          }
        }
      case .discarded(let id):
        timer?.invalidate()
        Task {
          try? await client.discard(workflowId: id)
          onDiscarded?(id)
        }
      case .edit:
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
        let d = try await client.dryRun(workflowId: id, limit: 5)
        dryRun = d
        adoptBatchHash(from: d)
        message = nil
      } catch {
        message = "Dry run failed. The workflow is unchanged."
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
