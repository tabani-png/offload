import Foundation

/// What the app needs from the brain (Bun/TS on 127.0.0.1). The live HTTP client lands with s04/s05;
/// until then the app runs on `MockBrainClient`.
protocol BrainClient: Sendable {
  func status() async throws -> ObserverStatus
  func insights() async throws -> [Insight]
  func evidence(insightId: String) async throws -> [EvidenceSpan]
  func automations() async throws -> [Automation]

  // s08: GET /connectors, workflows (s05 AC-7), dashboard.
  func connectorStates() async throws -> [String: ConnectorState]
  func workflow(id: String) async throws -> Workflow
  func workflow(forInsight insightId: String) async throws -> Workflow
  func dryRun(workflowId: String, limit: Int) async throws -> DryRun
  func approve(workflowId: String, batchHash: String) async throws -> Workflow
  func discard(workflowId: String) async throws
  func dashboard() async throws -> DashboardData
}

enum BrainError: Error, Equatable {
  case notFound(String)
  case unreachable
}

/// Realistic sample data: one founder's week, 38.5 active hours tracked.
struct MockBrainClient: BrainClient {
  func status() async throws -> ObserverStatus {
    ObserverStatus(state: .watching, daysStored: 4, windowDays: 7,
                   nextPurge: Self.weekStart.addingTimeInterval(8 * 86_400),
                   insightsWaiting: Self.sampleInsights.count)
  }

  func insights() async throws -> [Insight] { Self.sampleInsights }

  func evidence(insightId: String) async throws -> [EvidenceSpan] {
    guard let spans = Self.sampleEvidence[insightId] else { throw BrainError.notFound(insightId) }
    return spans
  }

  func automations() async throws -> [Automation] { Self.sampleAutomations }

  func connectorStates() async throws -> [String: ConnectorState] { Self.connectorStates }

  func workflow(id: String) async throws -> Workflow {
    guard let w = Self.sampleWorkflows.first(where: { $0.id == id }) else { throw BrainError.notFound(id) }
    return w
  }

  /// POST /workflows/draft {insightId}. The mock has drafts for outreach and scheduling.
  func workflow(forInsight insightId: String) async throws -> Workflow {
    guard let w = Self.sampleWorkflows.first(where: { $0.insightId == insightId }) else {
      throw BrainError.notFound(insightId)
    }
    return w
  }

  func dryRun(workflowId: String, limit: Int) async throws -> DryRun {
    guard var d = Self.sampleDryRuns[workflowId] else { throw BrainError.notFound(workflowId) }
    d.items = Array(d.items.prefix(max(0, limit)))
    return d
  }

  func approve(workflowId: String, batchHash: String) async throws -> Workflow {
    var w = try await workflow(id: workflowId)
    guard w.batchHash == batchHash else { throw BrainError.notFound(batchHash) }
    w.state = .active
    return w
  }

  func discard(workflowId: String) async throws { _ = try await workflow(id: workflowId) }

  func dashboard() async throws -> DashboardData { Self.sampleDashboard }

  // MARK: sample data

  /// Monday 2026-10-19 00:00 UTC.
  static let weekStart = Date(timeIntervalSince1970: 1_792_368_000)

  static let outreach = Insight(
    id: "ins_outreach", kind: "outreach", taskPhrase: "investor outreach emails", unitPlural: "emails",
    timeShare: 0.65, instanceCount: 500, medianMinutes: 3, taskHours: 25, trackedHours: 38.5, sameness: 0.86,
    saving: SavingEstimate(savingPct: 0.9, reviewMinutesPerInstance: 0.3, hoursPerWeekLow: 20, hoursPerWeekHigh: 24,
                           arithmetic: "100/day × 5 days × 3.0 min = 25.0 h/wk → review 500 × 18 s = 2.5 h/wk → saves 22.5 h/wk (90%)"),
    connectors: [Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: false)],
    evidenceIds: (1...6).map { "sp_out_\($0)" })

  static let scheduling = Insight(
    id: "ins_scheduling", kind: "scheduling", taskPhrase: "scheduling back-and-forth", unitPlural: "threads",
    timeShare: 0.14, instanceCount: 46, medianMinutes: 7, taskHours: 5.4, trackedHours: 38.5, sameness: 0.72,
    saving: SavingEstimate(savingPct: 0.86, reviewMinutesPerInstance: 1, hoursPerWeekLow: 3.9, hoursPerWeekHigh: 5.0,
                           arithmetic: "9.2/day × 5 days × 7.0 min = 5.4 h/wk → review 46 × 60 s = 0.8 h/wk → saves 4.6 h/wk (86%)"),
    connectors: [Connector(id: "gcal", name: "Google Calendar", kind: .calendar, connected: false),
                 Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: false)],
    evidenceIds: (1...4).map { "sp_sch_\($0)" })

  static let crmUpdate = Insight(
    id: "ins_crm", kind: "crm-update", taskPhrase: "copying replies into the CRM", unitPlural: "updates",
    timeShare: 0.09, instanceCount: 120, medianMinutes: 1.7, taskHours: 3.4, trackedHours: 38.5, sameness: 0.91,
    saving: SavingEstimate(savingPct: 0.88, reviewMinutesPerInstance: 0.2, hoursPerWeekLow: 2.6, hoursPerWeekHigh: 3.2),
    connectors: [Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: false),
                 Connector(id: "hubspot", name: "HubSpot", kind: .composio, connected: false)],
    evidenceIds: (1...4).map { "sp_crm_\($0)" })

  static let sampleInsights: [Insight] = [outreach, scheduling, crmUpdate]

  static let sampleAutomations: [Automation] = [
    Automation(id: "auto_digest", name: "Weekly investor update", status: .running, hoursSavedEstimated: 1.5, hoursSavedMeasured: 1.2),
    Automation(id: "auto_invoice", name: "Invoice chasers", status: .awaitingApproval, hoursSavedEstimated: 0.8, hoursSavedMeasured: nil),
    Automation(id: "auto_notes", name: "Call notes to Drive", status: .done, hoursSavedEstimated: 0.6, hoursSavedMeasured: 0.6),
  ]

  private static func span(_ id: String, day: Int, _ h: Int, _ m: Int, minutes: Double,
                           app: String, title: String, host: String? = nil, who: String? = nil) -> EvidenceSpan {
    // Wall-clock times in the viewer's own time zone, so "09:14" reads as 09:14 wherever it renders.
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .current
    let start = cal.date(from: DateComponents(year: 2026, month: 10, day: 19 + day, hour: h, minute: m))!
    return EvidenceSpan(id: id, start: start, end: start.addingTimeInterval(minutes * 60 + 20), activeMinutes: minutes,
                        app: app, title: title, urlHost: host, eventIds: ["\(id)_ev1", "\(id)_ev2"],
                        counterparty: who)
  }

  static let sampleEvidence: [String: [EvidenceSpan]] = [
    "ins_outreach": [
      span("sp_out_1", day: 0, 9, 14, minutes: 3.2, app: "Chrome", title: "Intro: Offload seed round, Halden Ventures", host: "mail.google.com", who: "Halden Ventures"),
      span("sp_out_2", day: 0, 9, 18, minutes: 2.8, app: "Chrome", title: "Following up on our call, Ashgrove Capital", host: "mail.google.com", who: "Ashgrove Capital"),
      span("sp_out_3", day: 1, 10, 2, minutes: 3.1, app: "Chrome", title: "Quick question on your fund thesis", host: "mail.google.com", who: "Northline Fund"),
      span("sp_out_4", day: 1, 10, 6, minutes: 2.9, app: "Numbers", title: "Investor pipeline.numbers"),
      span("sp_out_5", day: 2, 8, 47, minutes: 3.4, app: "Chrome", title: "Deck and data room access, Pellow Partners", host: "mail.google.com", who: "Pellow Partners"),
      span("sp_out_6", day: 3, 16, 31, minutes: 2.7, app: "Chrome", title: "Re: Intro: Offload seed round", host: "mail.google.com", who: "Halden Ventures"),
    ],
    "ins_scheduling": [
      span("sp_sch_1", day: 0, 11, 40, minutes: 6.5, app: "Chrome", title: "Re: Time next week?", host: "mail.google.com", who: "Daniel Osei"),
      span("sp_sch_2", day: 0, 11, 47, minutes: 4.0, app: "Calendar", title: "Week of 19 October"),
      span("sp_sch_3", day: 2, 14, 5, minutes: 7.8, app: "Chrome", title: "Re: Moving Thursday's call", host: "mail.google.com", who: "Lena Fischer"),
      span("sp_sch_4", day: 3, 9, 30, minutes: 7.1, app: "Chrome", title: "Re: Coffee in SoMa?", host: "mail.google.com", who: "Priya Raman"),
    ],
    "ins_crm": [
      span("sp_crm_1", day: 0, 17, 2, minutes: 1.6, app: "Chrome", title: "Contacts · Halden Ventures", host: "app.hubspot.com"),
      span("sp_crm_2", day: 1, 17, 20, minutes: 1.9, app: "Chrome", title: "Deals · Seed round", host: "app.hubspot.com"),
      span("sp_crm_3", day: 2, 17, 11, minutes: 1.5, app: "Chrome", title: "Contacts · Pellow Partners", host: "app.hubspot.com"),
      span("sp_crm_4", day: 3, 17, 45, minutes: 1.8, app: "Chrome", title: "Notes · Ashgrove Capital", host: "app.hubspot.com"),
    ],
  ]
}
