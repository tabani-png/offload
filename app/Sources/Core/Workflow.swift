import Foundation

// s08 view models for the workflow review window and the dashboard. The wire mirror (WorkflowWire.swift) maps the
// brain's s05 routes onto these. Every number is the brain's (ADR 0005); the app formats and lays out only.

/// Step types from the brain's `workflow.json` (s05 AC-3).
enum StepType: String, Codable, CaseIterable, Sendable {
  case read
  case draft
  case approvalGate = "approval_gate"
  case send
  case log

  /// SF Symbol per type. The gate is a lock: nothing past it runs without you.
  var symbol: String {
    switch self {
    case .read: return "doc.text.magnifyingglass"
    case .draft: return "pencil.line"
    case .approvalGate: return "lock.fill"
    case .send: return "paperplane"
    case .log: return "tablecells"
    }
  }

  /// Steps that change something outside the Mac. Every one of them sits behind the gate.
  var isSideEffect: Bool { self == .send || self == .log }
}

struct WorkflowStep: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var type: StepType
  var title: String
  var detail: String
  var connectorId: String? = nil

  var isGate: Bool { type == .approvalGate }
}

/// Automation lifecycle on GET /dashboard and GET /workflows (s05 AC-7).
enum WorkflowState: String, Codable, CaseIterable, Sendable {
  case drafting
  case readyForReview = "ready_for_review"
  case active
  case paused
  case needsYou = "needs_you"

  init(wire: String) { self = WorkflowState(rawValue: wire) ?? .drafting }

  var label: String {
    switch self {
    case .drafting: return "Drafting"
    case .readyForReview: return "Ready for review"
    case .active: return "Active"
    case .paused: return "Paused"
    case .needsYou: return "Needs you"
    }
  }
}

struct Recipient: Codable, Equatable, Identifiable, Sendable {
  var name: String
  var org: String
  var email: String
  var id: String { email }

  /// "Priya Raman, Halden Ventures"
  var display: String { org.isEmpty ? name : "\(name), \(org)" }
}

struct WorkflowSchedule: Codable, Equatable, Sendable {
  /// Plain words from the brain, e.g. "Weekdays at 09:00".
  var summary: String
  var batchSize: Int
  var nextRunAt: Date?
}

struct Workflow: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var insightId: String
  var name: String
  var summary: String
  var state: WorkflowState
  var connectors: [Connector]
  var schedule: WorkflowSchedule
  var steps: [WorkflowStep]
  /// SKILL.md verbatim, for the sheet.
  var skillMarkdown: String
  /// The tone card (style card for this bucket), editable inline.
  var toneCard: String
  var toneEdited: Bool = false
  /// Who the first live run writes to, in order.
  var nextBatch: [Recipient]
  /// Where the log step writes, e.g. "Investor pipeline (Google Sheets)".
  var logTarget: String
  /// The account the send step uses.
  var sendFrom: String
  var estimatedHoursPerWeek: Double
  /// The brain binds an approval to this exact batch (s05 AC-5).
  var batchHash: String
  /// Why an active workflow waits for you, in the brain's plain words (s09a). Empty otherwise.
  var needsYou: [String] = []

  var gate: WorkflowStep? { steps.first(where: \.isGate) }

  /// The approval is for the dry run you are looking at: its batch hash replaces whatever this workflow carried.
  func adopting(_ dryRun: DryRun) -> Workflow {
    guard !dryRun.batchHash.isEmpty, dryRun.workflowId == id else { return self }
    var w = self
    w.batchHash = dryRun.batchHash
    return w
  }
  var sendStep: WorkflowStep? { steps.first { $0.type == .send } }
}

/// One instance of last week's real work, re-done by the workflow in dry-run mode.
struct DryRunItem: Codable, Equatable, Identifiable, Sendable {
  var id: String
  var recipient: Recipient
  var subject: String
  var sentAt: Date
  var ourDraft: String
  var whatYouSent: String
  /// Minutes you spent on it last week (observed).
  var observedMinutes: Double
  /// Seconds the brain budgets for reviewing our draft.
  var reviewSeconds: Double
  /// Brain arithmetic: observed minus review.
  var minutesSaved: Double
}

struct DryRun: Codable, Equatable, Sendable {
  var workflowId: String
  var ranAt: Date
  var items: [DryRunItem]
  /// Side-effect calls the gate denied and logged during the dry run (proof nothing went out).
  var deniedSideEffects: Int
  /// Approving this exact hash marks the workflow reviewed (active). A dry-run batch can never be sent (s05).
  var batchHash: String = ""
}

// MARK: connectors

/// GET /connectors catalog status (s05 AC-1).
enum ConnectorState: String, Codable, CaseIterable, Sendable {
  case connected
  case missingEnv = "missing_env"
  case missing

  init(wire: String) { self = ConnectorState(rawValue: wire) ?? .missing }
}

/// What a connector chip shows. Colour means state: green connected, amber needs a key, grey not connected.
struct ConnectorChipModel: Equatable, Sendable {
  var name: String
  var role: StatusRole
  /// Present when the chip offers an action: "Connect…" or "Add key…".
  var action: String?
  var accessibilityLabel: String

  init(_ c: Connector) {
    name = c.name
    switch c.state {
    case .connected:
      role = .done; action = nil; accessibilityLabel = "\(c.name), connected"
    case .missingEnv:
      role = .needsYou; action = "Add key…"; accessibilityLabel = "\(c.name), needs its key"
    case .missing:
      role = .neutral; action = "Connect…"; accessibilityLabel = "\(c.name), not connected"
    }
  }
}

extension Connector {
  var state: ConnectorState { connected ? .connected : (missingEnv ? .missingEnv : .missing) }

  /// Applies live GET /connectors state. Unknown ids keep what they had.
  func applying(_ states: [String: ConnectorState]) -> Connector {
    guard let s = states[id] else { return self }
    var c = self
    c.connected = s == .connected
    c.missingEnv = s == .missingEnv
    return c
  }
}

extension Insight {
  func applying(connectorStates: [String: ConnectorState]) -> Insight {
    var i = self
    i.connectors = connectors.map { $0.applying(connectorStates) }
    return i
  }
}
