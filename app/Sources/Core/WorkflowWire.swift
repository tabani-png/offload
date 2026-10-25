import Foundation

// Swift mirror of the s05 additions to brain/src/api/types.ts: workflows, dry run, approve, connectors and the
// richer dashboard. Field names match the TypeScript exactly; new optional fields decode as nil from older
// brains. Mappers below are the only place these wire shapes become the s08 view models.

// MARK: connectors (GET /connectors)

struct WorkflowConnectorDTO: Codable, Equatable {
  var id: String
  var name: String
  var how: String
  var required: Bool
  var status: String  // "connected" | "missing_env" | "missing"

  func toConnector() -> Connector {
    let s = ConnectorState(wire: status)
    return Connector(id: id, name: name, kind: Self.kind(how: how, id: id), connected: s == .connected,
                     missingEnv: s == .missingEnv)
  }

  static func kind(how: String, id: String) -> ConnectorKind {
    if how == "gmail-mcp" { return .mcp }
    if how.hasPrefix("composio:") { return .composio }
    if id.contains("calendar") || id == "gcal" { return .calendar }
    return .localScript
  }
}

struct ConnectorsResponse: Codable, Equatable {
  struct Server: Codable, Equatable {
    var name: String
    var transport: String
    var catalog: [String]
    var status: String
    var missingEnv: [String]
  }
  struct CatalogEntry: Codable, Equatable {
    var id: String
    var name: String
    var how: String
    var status: String
    var servers: [String]
  }
  struct InsightConnectors: Codable, Equatable {
    struct Item: Codable, Equatable { var id: String; var name: String; var role: String; var status: String }
    var insightId: String
    var name: String
    var ready: Bool
    var connectors: [Item]
  }
  var version: Int
  var configPath: String
  var configErrors: [String]
  var servers: [Server]
  var catalog: [CatalogEntry]
  var insights: [InsightConnectors]

  /// Catalog id → state. The per-insight list uses the same ids and statuses; the catalog wins on conflict.
  func states() -> [String: ConnectorState] {
    var out: [String: ConnectorState] = [:]
    for i in insights { for c in i.connectors { out[c.id] = ConnectorState(wire: c.status) } }
    for c in catalog { out[c.id] = ConnectorState(wire: c.status) }
    return out
  }
}

// MARK: workflows

struct BatchSummaryDTO: Codable, Equatable {
  var hash: String
  var kind: String   // "dry_run" | "live"
  var state: String  // "pending" | "approved" | "sending" | "sent" | "partial" | "failed"
  var createdAt: Double
  var approvedAt: Double?
  var items: Int
  var sent: Int
}

struct BatchItemDTO: Codable, Equatable {
  var key: String
  var to: String
  var subject: String
  var body: String
  var warnings: [String]

  /// "Priya Raman <priya@haldenvc.com>" or a bare address.
  func toRecipient() -> Recipient {
    let t = to.trimmingCharacters(in: .whitespaces)
    if let lt = t.lastIndex(of: "<"), let gt = t.lastIndex(of: ">"), lt < gt {
      let name = t[..<lt].trimmingCharacters(in: CharacterSet(charactersIn: " \""))
      let email = String(t[t.index(after: lt)..<gt])
      return Recipient(name: name.isEmpty ? email : name, org: "", email: email)
    }
    return Recipient(name: t, org: "", email: t)
  }
}

struct WorkflowStepDTO: Codable, Equatable {
  var id: String
  var type: String
  var title: String
  var detail: String
  var connector: String?
  var sideEffect: Bool
  var script: String?

  func toStep() -> WorkflowStep {
    WorkflowStep(id: id, type: StepType(rawValue: type) ?? .read, title: title, detail: detail, connectorId: connector)
  }
}

struct WorkflowScheduleDTO: Codable, Equatable {
  var type: String  // "manual" | "cron"
  var cron: String?
  var timezone: String?
  var note: String?
}

struct WorkflowTriggerDTO: Codable, Equatable {
  var type: String
  var detail: String
}

/// WorkflowSummaryDTO, plus the WorkflowDetailDTO fields as optionals (GET /workflows/:id fills them).
struct WorkflowDTO: Codable, Equatable {
  var id: String
  var insightId: String
  var taskId: String
  var kind: String
  var name: String
  var description: String
  var state: String
  var needsYou: [String]
  var autoRun: Bool
  var createdAt: Double
  var activatedAt: Double?
  var connectors: [WorkflowConnectorDTO]
  var estimatedHoursSavedPerWeek: Double
  var arithmetic: String
  var pendingBatch: BatchSummaryDTO?
  var lastDryRunAt: Double?
  // s05c (optional)
  var lastRunAt: Double? = nil
  var nextRunAt: Double? = nil
  // s10b (optional): what auto-send is pinned to
  var autoRunPin: AutoRunPinDTO? = nil
  // detail
  var path: String?
  var skillMd: String?
  var facts: String?
  var steps: [WorkflowStepDTO]?
  var schedule: WorkflowScheduleDTO?
  var trigger: WorkflowTriggerDTO?
  var batchSize: Int?
  var batches: [BatchSummaryDTO]?
  var pendingItems: [BatchItemDTO]?

  /// "Weekdays at 09:00 · 8 a batch". The brain's own note; "Manual" when there is no schedule.
  var scheduleSummary: String {
    let base: String = {
      guard let s = schedule else { return trigger?.detail ?? "Manual" }
      if s.type == "cron" { return (s.note?.isEmpty == false ? s.note! : s.cron ?? "On a schedule") }
      return "Manual"
    }()
    guard let n = batchSize else { return base }
    return "\(base) · \(n) a batch"
  }

  /// The tone card is not part of the v1 workflow detail. The view says so instead of inventing one.
  func toWorkflow(dryRunHash: String? = nil) -> Workflow {
    let steps = (self.steps ?? []).map { $0.toStep() }
    let conns = connectors.map { $0.toConnector() }
    let logConnector = steps.first { $0.type == .log && $0.connectorId != nil }?.connectorId
    let logTarget = logConnector.flatMap { id in conns.first { $0.id == id }?.name } ?? "the log on this Mac"
    return Workflow(
      id: id, insightId: insightId, name: name, summary: description, state: WorkflowState(wire: state),
      connectors: conns,
      schedule: WorkflowSchedule(summary: scheduleSummary, batchSize: batchSize ?? 0, nextRunAt: nextRunAt.map(BrainWire.date(ms:))),
      steps: steps, skillMarkdown: skillMd ?? "", toneCard: "", nextBatch: (pendingItems ?? []).map { $0.toRecipient() },
      logTarget: logTarget, sendFrom: "your account", estimatedHoursPerWeek: estimatedHoursSavedPerWeek,
      batchHash: dryRunHash ?? "", needsYou: needsYou, arithmetic: arithmetic, facts: facts ?? "", autoRun: autoRun, path: path ?? "")
  }
}

struct WorkflowsResponse: Codable, Equatable {
  var version: Int
  var workflows: [WorkflowDTO]
}

// MARK: dry run (POST /workflows/:id/dry-run)

struct GateDecisionDTO: Codable, Equatable {
  var at: Double
  var tool: String
  var toolClass: String
  var decision: String
  var reason: String
  var itemKey: String?
}

struct DryRunInstanceDTO: Codable, Equatable {
  struct Who: Codable, Equatable { var email: String; var firstName: String; var org: String }
  struct Observed: Codable, Equatable { var excerpt: String; var minutes: Double; var eventIds: [String] }
  struct Estimate: Codable, Equatable { var observedMinutes: Double; var reviewSeconds: Double; var savedMinutes: Double }
  var instanceId: String
  var day: String
  var start: Double
  var recipient: Who
  var subject: String
  var draft: String?
  var observed: Observed
  var estimate: Estimate
  var examplesUsed: [String]
  var warnings: [String]

  func toItem() -> DryRunItem {
    DryRunItem(id: instanceId, recipient: Recipient(name: recipient.firstName, org: recipient.org, email: recipient.email),
               subject: subject, sentAt: BrainWire.date(ms: start), ourDraft: draft ?? "",
               whatYouSent: observed.excerpt, observedMinutes: estimate.observedMinutes,
               reviewSeconds: estimate.reviewSeconds, minutesSaved: estimate.savedMinutes)
  }
}

struct DryRunResponse: Codable, Equatable {
  struct SideEffects: Codable, Equatable { var attempted: Int; var denied: Int }
  struct Totals: Codable, Equatable {
    var instances: Int; var observedMinutes: Double; var reviewMinutes: Double; var savedMinutes: Double; var arithmetic: String
  }
  var version: Int
  var workflowId: String
  var ranAt: Double
  var batchHash: String
  var instances: [DryRunInstanceDTO]
  var skipped: Int
  var sideEffects: SideEffects
  var totals: Totals
  var gateLog: [GateDecisionDTO]
  var warnings: [String]
  /// s09b: "stub" | "real"; absent on dry runs sealed before s09b.
  var model: String? = nil

  func toDryRun() -> DryRun {
    DryRun(workflowId: workflowId, ranAt: BrainWire.date(ms: ranAt), items: instances.map { $0.toItem() },
           deniedSideEffects: sideEffects.denied, batchHash: batchHash, model: model)
  }
}

struct ApproveResponse: Codable, Equatable {
  var version: Int
  var workflowId: String
  var batchHash: String
  var kind: String
  var result: String  // "activated" | "sending"
  var workflow: WorkflowDTO
}

// MARK: dashboard (s05 additions to AutomationDTO)

struct MeasuredSavingDTO: Codable, Equatable {
  var activatedAt: Double
  var daysBefore: Int
  var daysAfter: Int
  var hoursPerWeekBefore: Double
  var hoursPerWeekAfter: Double
  var hoursSavedPerWeek: Double
  var arithmetic: String
}

extension AutomationDTO {
  /// The s05 `state` when present, else the legacy 4-value status mapped onto it.
  var workflowState: WorkflowState {
    if let s = state { return WorkflowState(wire: s) }
    switch status {
    case "approved": return .active
    case "dry_run": return .readyForReview
    case "paused": return .paused
    default: return .drafting
    }
  }

  /// Run times from the s05c fields; before them, last run is the pending batch's approval (or creation).
  func toDashboardAutomation(taskId: String? = nil) -> DashboardAutomation {
    let taskId = taskId ?? self.taskId
    let st = workflowState
    // s05c brains send lastRunAt/nextRunAt; older ones fall back to the pending batch.
    let last = lastRunAt.map(BrainWire.date(ms:)) ?? pendingBatch.map { BrainWire.date(ms: $0.approvedAt ?? $0.createdAt) }
    return DashboardAutomation(
      id: id, workflowId: workflowId ?? id, insightId: insightId, name: name, state: st,
      connectors: connectors.map { $0.toConnector() }, lastRunAt: last, nextRunAt: nextRunAt.map(BrainWire.date(ms:)),
      estimatedHoursPerWeek: estimatedHoursSavedPerWeek, measuredHoursPerWeek: measuredHoursSavedPerWeek,
      needsYouReason: (needsYou ?? []).isEmpty ? nil : needsYou!.joined(separator: " "), taskId: taskId,
      arithmetic: arithmetic)
  }
}

extension DashboardResponse {
  var hoursSaved: HoursSaved {
    HoursSaved(estimated: totals.estimatedHoursSavedPerWeek, measured: totals.measuredHoursSavedPerWeek)
  }
}

// MARK: timeline (GET /timeline?day=)

extension TimelineResponse {
  /// One row. A span is drawn hatched when its task belongs to an automation that was active at that moment: that
  /// is your review time on work Offload now does (the observer only sees you, never Offload's own runs).
  func toTimelineDay(activeSince: [String: Date], calendar: Calendar = .current) -> TimelineDay {
    let date = ObservingState.parseDay(day, calendar: calendar) ?? Date(timeIntervalSince1970: 0)
    let bars = spans.sorted { $0.start < $1.start }.map { s -> TimelineBar in
      let start = BrainWire.date(ms: s.start)
      let automated = s.taskId.flatMap { activeSince[$0] }.map { start >= $0 } ?? false
      return TimelineBar(id: s.id, taskId: s.taskId ?? "other", start: start, end: BrainWire.date(ms: s.end),
                         automated: automated, title: s.title, counterparty: nil)
    }
    return TimelineDay(day: day, date: calendar.startOfDay(for: date), bars: bars, trackedMinutes: activeMinutes)
  }
}
