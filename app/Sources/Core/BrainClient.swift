import Foundation

/// What the app needs from the brain (Bun/TS on 127.0.0.1). `HTTPBrainClient` talks to the real brain (s09a);
/// `MockBrainClient` serves the sample week for `--mock`, snapshots and tests.
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

  // s05c (defaults in BrainEdits.swift for the mock): tone card, SKILL.md text, observer passthrough.
  func toneCard(workflowId: String) async throws -> ToneCard
  func saveToneCard(workflowId: String, text: String) async throws -> ToneCard
  func skill(workflowId: String) async throws -> SkillDoc
  func saveSkill(workflowId: String, edit: SkillEdit) async throws -> SkillDoc
  func observer() async throws -> ObserverReport?

  // s09b: the newest stored dry run (GET /workflows/:id/dry-runs/latest), so opening a review never re-drafts.
  func latestDryRun(workflowId: String) async throws -> DryRun?

  // s10d (brain s10b): auto-send with its pin, and the files kept until you delete them.
  func setAutoRun(workflowId: String, enabled: Bool) async throws -> AutoRunResult
  func keptFiles() async throws -> [KeptFile]

  // s10e: connect a tool from inside Offload (POST/GET /connectors/:id/link). Never approves or sends.
  /// `method` nil = the brain's first choice for this connector.
  func startLink(connectorId: String, method: ConnectMethod?) async throws -> ConnectLink
  func linkStatus(connectorId: String) async throws -> ConnectLink

  // s14: your role and industry (GET/PUT /context, context only, never a number) and the plan variant you keep
  // (POST /workflows/:id/plan {variant}, returns the workflow detail).
  func getContext() async throws -> ContextResponse
  func putContext(_ context: UserContext) async throws -> ContextResponse
  func choosePlan(workflowId: String, variant: String) async throws -> Workflow
  /// POST /workflows/:id/tools {stepId, toolId}; returns the detail (the dry run is reset).
  func chooseTool(workflowId: String, stepId: String, toolId: String) async throws -> Workflow

  // s17: the Connections center (GET/POST /connections…, Connections.swift). Setup and test only read; build ends in a
  // dry run. Defaults (an older brain) say "not found".
  func connections(query: String) async throws -> ConnectionsPage
  func connection(id: String) async throws -> ConnectionDetail
  func setupConnection(id: String, _ setup: ConnectionSetup) async throws -> ConnectionDetail
  func testConnection(id: String) async throws -> ConnectionTest
  func buildWorkflow(connectionId: String) async throws -> ConnectionBuild
}

enum BrainError: Error, Equatable {
  case notFound(String)
  /// Nothing listens: the brain is not running (or is between restarts).
  case unreachable
  /// The app launched the brain and is waiting for its first line.
  case starting
  case timedOut
  /// 401/403: the per-launch token or the Host check did not match.
  case unauthorized
  /// 409: not allowed in the current state. The brain's own words, e.g. "connect Gmail first".
  case conflict(String)
  case badRequest(String)
  case server(Int, String)
  /// The body did not decode as the v1 contract.
  case badResponse(String)

  /// One calm sentence for the UI. Never a stack trace, never a status code on its own.
  var userMessage: String {
    switch self {
    case .notFound: return "That is no longer there. It may have been removed."
    case .unreachable: return "Brain is not running. Offload restarts it on its own; this clears in a few seconds."
    case .starting: return "Brain is starting. This takes a few seconds."
    case .timedOut: return "The brain is taking too long to answer. Try again in a moment."
    case .unauthorized: return "Offload could not reach its own background helper. Quit and reopen Offload."
    case .conflict(let m): return BrainError.sentence(m.isEmpty ? "Not possible right now." : m)
    case .badRequest: return "The brain could not read that request. Nothing was changed."
    case .server: return "The brain hit a problem. Nothing was changed; details are in its log."
    case .badResponse: return "The brain answered in a form this app does not read. Update both together."
    }
  }

  /// Capitalised, ends with a full stop.
  static func sentence(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = t.first else { return t }
    let body = first.uppercased() + t.dropFirst()
    return body.hasSuffix(".") || body.hasSuffix("?") || body.hasSuffix("!") ? body : body + "."
  }

  /// Any error as a calm sentence.
  static func message(for error: Error) -> String {
    (error as? BrainError)?.userMessage ?? BrainError.unreachable.userMessage
  }
}

/// Realistic sample data: one founder's week, 38.5 active hours tracked.
struct MockBrainClient: BrainClient {
  /// s10a: the consistent sample week (SampleWeek), so --mock shows the same figures on every screen.
  func status() async throws -> ObserverStatus { SampleWeek.status }

  func insights() async throws -> [Insight] { SampleWeek.insights }

  func evidence(insightId: String) async throws -> [EvidenceSpan] {
    guard let spans = Self.sampleEvidence[insightId] else { throw BrainError.notFound(insightId) }
    return spans
  }

  func automations() async throws -> [Automation] { Self.sampleAutomations }

  func connectorStates() async throws -> [String: ConnectorState] {
    var s = Self.connectorStates
    for id in MockLinks.connected { s[id] = .connected }
    return s
  }

  /// s10e: a deterministic demo sign-in: waiting, then connected after `MockLinks.delay` seconds. No browser.
  func startLink(connectorId: String, method: ConnectMethod?) async throws -> ConnectLink {
    MockLinks.start(connectorId)
    let name = [Self.gmail, Self.sheets, Self.calendar, Self.hubspot].first { $0.id == connectorId }?.name ?? connectorId
    return ConnectLink(connectorId: connectorId, name: name, via: connectorId == "gmail" ? .gmailMCP : .composio,
                       state: .waiting, url: nil, simulated: true,
                       message: "Demo sign-in: no browser opens and nothing is sent.", startedAt: Date(), connectedAt: nil,
                       method: method ?? Self.methods(connectorId).first, methods: Self.methods(connectorId))
  }

  func linkStatus(connectorId: String) async throws -> ConnectLink {
    let name = [Self.gmail, Self.sheets, Self.calendar, Self.hubspot].first { $0.id == connectorId }?.name ?? connectorId
    let done = MockLinks.poll(connectorId)
    return ConnectLink(connectorId: connectorId, name: name, via: connectorId == "gmail" ? .gmailMCP : .composio,
                       state: done ? .connected : .waiting, url: nil, simulated: true,
                       message: done ? "\(name) is connected." : "Demo sign-in: no browser opens and nothing is sent.",
                       startedAt: nil, connectedAt: done ? Date() : nil,
                       method: Self.methods(connectorId).first, methods: Self.methods(connectorId))
  }

  /// How the sample's connectors are reached, in order.
  static func methods(_ id: String) -> [ConnectMethod] { id == "gmail" ? [.mcp, .composio] : [.composio] }

  func workflow(id: String) async throws -> Workflow {
    // s14: the general (plan) sample workflows are found by id too; they are not in the email demo's list.
    guard let w = (Self.sampleWorkflows + Self.planWorkflows + [Self.outreachToolsWorkflow]).first(where: { $0.id == id }) else { throw BrainError.notFound(id) }
    return MockContext.plan(for: w)
  }

  // MARK: s14

  func getContext() async throws -> ContextResponse { MockContext.response() }

  func putContext(_ context: UserContext) async throws -> ContextResponse {
    MockContext.store(context)
    return MockContext.response()
  }

  /// Keeps the tool you picked for a step (chosenBy "user"), like the brain's POST /workflows/:id/tools.
  func chooseTool(workflowId: String, stepId: String, toolId: String) async throws -> Workflow {
    let w = try await workflow(id: workflowId)
    guard let t = w.tools.first(where: { $0.stepId == stepId }), t.options.contains(where: { $0.id == toolId }) else {
      throw BrainError.badRequest("unknown step or tool")
    }
    MockContext.chooseTool(workflowId, stepId, toolId)
    return MockContext.plan(for: w)
  }

  /// Keeps the variant you picked (chosenBy "user"), like the brain's POST /workflows/:id/plan.
  func choosePlan(workflowId: String, variant: String) async throws -> Workflow {
    let w = try await workflow(id: workflowId)
    guard let plan = w.plan else { throw BrainError.conflict("this workflow has no plan") }
    guard plan.variants.contains(where: { $0.id == variant }) else { throw BrainError.badRequest("variant must be a or b") }
    MockContext.choose(workflowId, variant)
    return MockContext.plan(for: w)
  }

  /// POST /workflows/draft {insightId}. The mock has drafts for outreach and scheduling.
  func workflow(forInsight insightId: String) async throws -> Workflow {
    guard let w = Self.sampleWorkflows.first(where: { $0.insightId == insightId }) else {
      throw BrainError.notFound(insightId)
    }
    return w
  }

  func dryRun(workflowId: String, limit: Int) async throws -> DryRun {
    guard var d = Self.sampleDryRuns[workflowId] ?? Self.planDryRuns[workflowId] else { throw BrainError.notFound(workflowId) }
    d.items = Array(d.items.prefix(max(0, limit)))
    if var g = d.general {
      g.instances = Array(g.instances.prefix(max(0, limit)))
      d.general = g
    }
    return d
  }

  func approve(workflowId: String, batchHash: String) async throws -> Workflow {
    var w = try await workflow(id: workflowId)
    guard w.batchHash == batchHash else { throw BrainError.notFound(batchHash) }
    w.state = .active
    return w
  }

  func discard(workflowId: String) async throws { _ = try await workflow(id: workflowId) }

  func latestDryRun(workflowId: String) async throws -> DryRun? { Self.sampleDryRuns[workflowId] ?? Self.planDryRuns[workflowId] }

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
    // s10e: the card's week is the week before Offload (MockWeek.before), Mon 12 to Fri 16.
    let start = cal.date(from: DateComponents(year: 2026, month: 10, day: 12 + day, hour: h, minute: m))!
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
      span("sp_out_6", day: 3, 16, 31, minutes: 2.7, app: "Chrome", title: "Re: Intro: Offload seed round", host: "mail.google.com", who: "Brightwater Angels"),
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
