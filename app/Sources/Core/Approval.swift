import Foundation

/// A 5-second window with Esc to cancel. Same arithmetic as the card's `UndoWindow`, for actions that are not
/// about an insight (approve, discard).
struct Countdown: Equatable, Sendable {
  var startedAt: Date
  var duration: Double = Tokens.undoSeconds

  func elapsed(at now: Date) -> Double { max(0, now.timeIntervalSince(startedAt)) }
  func isExpired(at now: Date) -> Bool { elapsed(at: now) >= duration }
  func fractionRemaining(at now: Date) -> Double { max(0, min(1, 1 - elapsed(at: now) / duration)) }
  var deadline: Date { startedAt.addingTimeInterval(duration) }
  /// Rounds up, so it never reads "0s" while you can still cancel.
  func secondsLeftLabel(at now: Date) -> String { "\(secondsShown(at: now))s" }
  func secondsShown(at now: Date) -> Int { CountdownMath.secondsShown(elapsed: elapsed(at: now), duration: duration) }
  /// The label's seconds over the window (s10a): "Turning on in 4s" draws 80%.
  func hairline(at now: Date) -> Double { CountdownMath.hairline(elapsed: elapsed(at: now), duration: duration) }
}

/// Keys in the workflow review window. ⌘ chords that are not ours pass through (⌘W, ⌘Q, ⌘C…).
enum ReviewKey: Equatable, Sendable {
  case approve   // ⌘↩
  case confirm   // ↩ (in the confirmation)
  case escape    // Esc
  case edit      // E
  case rerun     // R
  case discard   // ⌘⌫
  case skill     // S

  static let returnKeyCodes: Set<UInt16> = [36, 76]
  static let deleteKeyCode: UInt16 = 51
  static let escapeKeyCode: UInt16 = 53

  /// `textEditing` is true while a text field or the tone card has focus: then only ⌘↩ and Esc are ours, so
  /// typing "e" or "r" into the tone card never triggers Edit or Run again.
  init?(characters: String, keyCode: UInt16, command: Bool, control: Bool = false, option: Bool = false,
        textEditing: Bool = false) {
    if control || option { return nil }
    if keyCode == Self.escapeKeyCode { self = .escape; return }
    if command {
      if Self.returnKeyCodes.contains(keyCode) { self = .approve; return }
      if keyCode == Self.deleteKeyCode && !textEditing { self = .discard; return }
      return nil
    }
    if textEditing { return nil }
    if Self.returnKeyCodes.contains(keyCode) { self = .confirm; return }
    switch characters.lowercased() {
    case "e": self = .edit
    case "r": self = .rerun
    case "s": self = .skill
    default: return nil
    }
  }
}

/// Exactly what the first live run will do, said before you confirm.
struct FirstRunPlan: Equatable, Sendable {
  var workflowName: String
  var sendCount: Int
  var recipients: [Recipient]
  var sendVia: String
  var sendFrom: String
  var logTarget: String
  var schedule: String
  var firstRunAt: Date?
  var gated: Bool
  /// Connectors a step after the gate needs but that are not connected: said up front, in amber.
  var blockers: [String]

  init(workflow w: Workflow) {
    workflowName = w.name
    let batch = Array(w.nextBatch.prefix(max(0, w.schedule.batchSize)))
    recipients = batch
    sendCount = batch.count
    let sendConnector = w.sendStep?.connectorId.flatMap { id in w.connectors.first { $0.id == id } }
    sendVia = sendConnector?.name ?? "Gmail"
    sendFrom = w.sendFrom
    logTarget = w.logTarget
    schedule = w.schedule.summary
    firstRunAt = w.schedule.nextRunAt
    gated = w.gate != nil
    batchSize = w.schedule.batchSize
    let gateIndex = w.steps.firstIndex(where: \.isGate) ?? -1
    var seen = Set<String>()
    var missing: [Connector] = []
    blockers = w.steps.enumerated().compactMap { i, step -> String? in
      guard i > gateIndex, let id = step.connectorId, !seen.contains(id),
            let c = w.connectors.first(where: { $0.id == id }), c.state != .connected else { return nil }
      seen.insert(id)
      missing.append(c)
      return c.state == .missingEnv
        ? "\(c.name) is signed out. \(step.title) waits until you sign in."
        : "\(c.name) is not connected. \(step.title) waits until you connect it."
    }
    self.missing = missing
  }

  /// s10a: connectors a step after your approval needs that are not connected. While any is missing, Turn on is
  /// disabled (it would arm something that cannot run) and the sheet's primary connects the first one.
  var missing: [Connector]
  var canTurnOn: Bool { missing.isEmpty }

  /// The reason Turn on is disabled, said next to it.
  var turnOnBlockedReason: String? {
    guard let first = missing.first else { return nil }
    let verb = first.state == .missingEnv ? "Sign in to \(first.name)" : "Connect \(first.name)"
    let more = missing.count > 1 ? " and \(missing.dropFirst().map(\.name).joined(separator: " and "))" : ""
    return "\(verb)\(more) first. Turn on needs every step able to run."
  }

  /// The sheet's primary while blocked: "Connect Google Sheets" / "Sign in to HubSpot".
  var connectTitle: String? {
    guard let first = missing.first else { return nil }
    return first.state == .missingEnv ? "Sign in to \(first.name)" : "Connect \(first.name)"
  }

  static func emails(_ n: Int) -> String { n == 1 ? "1 email" : "\(n) emails" }

  /// Batch size, for when the brain has not picked the recipients yet.
  var batchSize: Int

  /// "Send 8 emails to these recipients", or, before the brain has picked them, "Draft up to 8 emails".
  var headline: String {
    sendCount > 0 ? "Send \(Self.emails(sendCount)) to these recipients" : "Draft up to \(Self.emails(batchSize))"
  }

  /// Said when the recipient list is still empty: who decides, and that you still see each one first.
  var pendingNote: String? {
    sendCount > 0 ? nil : "The first run picks them from your list. You see every email and every recipient before anything sends."
  }

  /// The run, in order, in plain words.
  var steps: [String] {
    let n = sendCount > 0 ? sendCount : batchSize
    let emails = sendCount > 0 ? Self.emails(n) : "up to \(Self.emails(n))"
    var out = ["Draft \(emails) in your voice."]
    if gated { out.append("Hold \(sendCount > 0 ? "all \(n)" : "them") for you to approve as a batch. Nothing sends before that.") }
    out.append("Send \(sendCount > 0 ? Self.emails(n) : "the ones you approve") from \(sendFrom) through \(sendVia).")
    out.append("Log \(sendCount > 0 ? (n == 1 ? "1 row" : "\(n) rows") : "each send") to \(logTarget).")
    return out
  }
}

/// The review window's approval state machine. Pure, time passed in.
///
/// ⌘↩ opens the confirmation (it never approves by itself). ↩ in the confirmation arms a 5-second countdown;
/// Esc cancels it. Only when it runs out does the approval go to the brain. ⌘⌫ discards, also behind 5 s.
struct ApprovalFlow: Equatable, Sendable {
  enum Phase: Equatable, Sendable {
    case reviewing
    case confirming(since: Date)
    case armed(Countdown)
    case approved
    case discarding(Countdown)
    case discarded
  }

  enum Effect: Equatable, Sendable {
    case openConfirm(FirstRunPlan)
    case closeConfirm
    case armed
    case cancelled
    case approved(workflowId: String, batchHash: String)
    case discardStaged
    case discardUndone
    case discarded(workflowId: String)
    case edit
    case rerunDryRun
    case showSkill
  }

  /// A confirmation that just opened ignores ↩ for this long, so a double ⌘↩ cannot approve by accident.
  static let confirmDebounce: Double = 0.5

  var workflow: Workflow
  private(set) var phase: Phase = .reviewing

  init(workflow: Workflow) { self.workflow = workflow }

  var plan: FirstRunPlan { FirstRunPlan(workflow: workflow) }
  var isConfirmOpen: Bool {
    switch phase { case .confirming, .armed: return true; default: return false }
  }
  var countdown: Countdown? {
    switch phase { case .armed(let c), .discarding(let c): return c; default: return nil }
  }
  var isFinal: Bool { phase == .approved || phase == .discarded }
  /// Approval needs a dry run (its batch hash is what the brain approves) and a workflow still waiting for review.
  var canApprove: Bool {
    (workflow.state == .readyForReview || workflow.state == .needsYou) && !workflow.batchHash.isEmpty
  }

  mutating func handle(_ key: ReviewKey, at now: Date) -> [Effect] {
    switch phase {
    case .reviewing:
      switch key {
      case .approve:
        guard canApprove else { return [] }
        phase = .confirming(since: now)
        return [.openConfirm(plan)]
      case .edit: return [.edit]
      case .rerun: return [.rerunDryRun]
      case .skill: return [.showSkill]
      case .discard:
        phase = .discarding(Countdown(startedAt: now))
        return [.discardStaged]
      case .confirm, .escape: return []
      }

    case .confirming(let since):
      switch key {
      case .escape:
        phase = .reviewing
        return [.closeConfirm]
      case .confirm, .approve:
        guard now.timeIntervalSince(since) >= Self.confirmDebounce else { return [] }
        phase = .armed(Countdown(startedAt: now))
        return [.armed]
      default: return []
      }

    case .armed(let c):
      // Only Esc means anything here; the countdown is the last chance to stop it.
      guard key == .escape, !c.isExpired(at: now) else { return [] }
      phase = .reviewing
      return [.cancelled, .closeConfirm]

    case .discarding(let c):
      guard key == .escape, !c.isExpired(at: now) else { return [] }
      phase = .reviewing
      return [.discardUndone]

    case .approved, .discarded:
      return []
    }
  }

  /// Lands an expired countdown. Call on a timer.
  mutating func tick(at now: Date) -> [Effect] {
    switch phase {
    case .armed(let c) where c.isExpired(at: now):
      phase = .approved
      workflow.state = .active
      return [.approved(workflowId: workflow.id, batchHash: workflow.batchHash), .closeConfirm]
    case .discarding(let c) where c.isExpired(at: now):
      phase = .discarded
      return [.discarded(workflowId: workflow.id)]
    default:
      return []
    }
  }

  /// A fresh dry run or an edit replaces the workflow. The batch hash changes with it, so an approval is always
  /// for what you last saw.
  /// s10e: a connector was connected. The batch and its hash are unchanged, so an open confirmation stays open and
  /// its plan now reads the new state (Turn on becomes possible).
  mutating func updateConnectors(_ states: [String: ConnectorState], connected: Connector? = nil) {
    workflow.connectors = workflow.connectors.map { c in
      var c = c.applying(states)
      if let k = connected, k.id == c.id { c.connected = true; c.missingEnv = false }
      return c
    }
  }

  mutating func replaceWorkflow(_ w: Workflow) {
    workflow = w
    if case .confirming = phase { phase = .reviewing }
  }
}

/// s10a: whether a key may go to the approval flow. While the confirmation is open and a connector a step after your
/// approval needs is missing, ↩ and ⌘↩ do not arm Turn on (the button is disabled, with the reason beside it).
enum ArmGuard {
  static func allows(_ key: ReviewKey, flow: ApprovalFlow) -> Bool {
    guard case .confirming = flow.phase, key == .confirm || key == .approve else { return true }
    return flow.plan.canTurnOn
  }
}
