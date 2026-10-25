import Foundation
import Testing

// S08: the Swift mirror of the s05 additions to brain/src/api/types.ts (workflows, dry run, approve, connectors,
// the richer dashboard, timeline) and their mapping onto the review and dashboard view models. Fixtures follow
// the TypeScript field for field: epoch-ms times, minutes, `null` where the type says `| null`.

private func decode<T: Decodable>(_ t: T.Type, _ json: String) throws -> T {
  try BrainWire.decoder.decode(t, from: Data(json.utf8))
}

private let workflowJSON = #"""
{
  "id": "wf_1", "insightId": "ins_a1", "taskId": "task_1", "kind": "email.outreach", "name": "Investor outreach",
  "description": "Drafts investor emails in your voice.", "state": "ready_for_review", "needsYou": [], "autoRun": false,
  "createdAt": 1792800000000, "activatedAt": null,
  "connectors": [
    { "id": "gmail", "name": "Gmail", "how": "gmail-mcp", "required": true, "status": "connected" },
    { "id": "gsheets", "name": "Google Sheets", "how": "composio:googlesheets", "required": true, "status": "missing" },
    { "id": "hubspot", "name": "HubSpot", "how": "composio:hubspot", "required": false, "status": "missing_env" }
  ],
  "estimatedHoursSavedPerWeek": 21.9, "arithmetic": "98.4/day × 5 days × 3.0 min = 24.6 h/wk → saves 21.9 h/wk (89%)",
  "pendingBatch": null, "lastDryRunAt": 1792800300000,
  "path": "/Users/x/.offload/workflows/wf_1", "skillMd": "---\nname: investor-outreach\n---\n", "facts": "Raising $2.5M.",
  "steps": [
    { "id": "s1", "type": "read", "title": "Read the list", "detail": "Pipeline sheet", "connector": "gsheets", "sideEffect": false },
    { "id": "s2", "type": "draft", "title": "Draft", "detail": "In your voice", "connector": null, "sideEffect": false },
    { "id": "s3", "type": "approval_gate", "title": "You approve the batch", "detail": "Nothing sends first", "connector": null, "sideEffect": false },
    { "id": "s4", "type": "send", "title": "Send", "detail": "Gmail", "connector": "gmail", "sideEffect": true },
    { "id": "s5", "type": "log", "title": "Log to the pipeline", "detail": "Contacted", "connector": "gsheets", "sideEffect": true, "script": "scripts/log.ts" }
  ],
  "schedule": { "type": "cron", "cron": "0 9 * * 1-5", "timezone": "America/Toronto", "note": "Weekdays at 09:00" },
  "trigger": { "type": "schedule", "detail": "Weekdays at 09:00" },
  "batchSize": 8, "models": { "draft": "claude-opus-5-5", "cheap": "claude-sonnet-5-5" },
  "batches": [],
  "pendingItems": [
    { "key": "k1", "to": "Tomás Ibarra <tomas@northline.fund>", "subject": "Intro", "body": "Hi Tomás", "warnings": [] },
    { "key": "k2", "to": "grace@larchmontseed.com", "subject": "Intro", "body": "Hi Grace", "warnings": [] }
  ]
}
"""#

private let dryRunJSON = #"""
{
  "version": 1, "workflowId": "wf_1", "ranAt": 1792800300000, "batchHash": "9f2c…e1",
  "instances": [{
    "instanceId": "inst_1", "day": "2026-10-19", "start": 1792386840000,
    "recipient": { "email": "priya@haldenvc.com", "firstName": "Priya", "org": "Halden Ventures" },
    "subject": "Intro: Offload seed round",
    "draft": "Hi Priya,\n\nWorth 20 minutes next week?\n\nMuhammad",
    "observed": { "excerpt": "Hi Priya,\n\nFree for 20 minutes Tuesday?\n\nMuhammad", "minutes": 3.2, "eventIds": ["e1"] },
    "estimate": { "observedMinutes": 3.2, "reviewSeconds": 20, "savedMinutes": 2.9 },
    "examplesUsed": ["m12", "m31"], "warnings": []
  }, {
    "instanceId": "inst_2", "day": "2026-10-19", "start": 1792387080000,
    "recipient": { "email": "daniel@ashgrove.capital", "firstName": "Daniel", "org": "Ashgrove Capital" },
    "subject": "Following up", "draft": null,
    "observed": { "excerpt": "Hi Daniel", "minutes": 2.8, "eventIds": [] },
    "estimate": { "observedMinutes": 2.8, "reviewSeconds": 20, "savedMinutes": 2.5 },
    "examplesUsed": [], "warnings": ["no drafting dry run for this kind"]
  }],
  "skipped": 1,
  "sideEffects": { "attempted": 4, "denied": 4 },
  "totals": { "instances": 2, "observedMinutes": 6.0, "reviewMinutes": 0.7, "savedMinutes": 5.4, "arithmetic": "6.0 min − 0.7 min = 5.4 min" },
  "gateLog": [{ "at": 1792800300100, "tool": "mcp__gmail__send_email", "toolClass": "side_effect", "decision": "deny", "reason": "dry_run" }],
  "warnings": []
}
"""#

private let connectorsJSON = #"""
{
  "version": 1, "configPath": "/Users/x/.offload/connectors.json", "configErrors": [],
  "servers": [{ "name": "composio", "transport": "http", "catalog": ["gsheets", "hubspot"], "status": "missing_env", "missingEnv": ["COMPOSIO_API_KEY"] }],
  "catalog": [
    { "id": "gmail", "name": "Gmail", "how": "gmail-mcp", "status": "connected", "servers": ["gmail"] },
    { "id": "hubspot", "name": "HubSpot", "how": "composio:hubspot", "status": "missing_env", "servers": ["composio"] }
  ],
  "insights": [{ "insightId": "ins_a1", "name": "Outreach emails", "ready": false, "connectors": [
    { "id": "gmail", "name": "Gmail", "role": "primary", "status": "connected" },
    { "id": "gsheets", "name": "Google Sheets", "role": "also", "status": "missing" }
  ] }]
}
"""#

private let dashboardJSON = #"""
{
  "version": 1,
  "automations": [{
    "id": "wf_1", "insightId": "ins_a1", "name": "Investor outreach", "status": "approved",
    "connectors": [{ "id": "gmail", "name": "Gmail", "how": "gmail-mcp", "reach": 1, "role": "primary" }],
    "estimatedHoursSavedPerWeek": 21.9, "measuredHoursSavedPerWeek": 16.8,
    "workflowId": "wf_1", "state": "needs_you", "needsYou": ["A batch of 8 waits for your review."],
    "arithmetic": "…", "measured": { "activatedAt": 1792540800000, "daysBefore": 2, "daysAfter": 2,
      "hoursPerWeekBefore": 24.1, "hoursPerWeekAfter": 7.3, "hoursSavedPerWeek": 16.8, "arithmetic": "…" },
    "pendingBatch": { "hash": "h1", "kind": "live", "state": "pending", "createdAt": 1792800000000, "approvedAt": null, "items": 8, "sent": 0 }
  }],
  "totals": { "estimatedHoursSavedPerWeek": 21.9, "measuredHoursSavedPerWeek": 16.8 },
  "suggestions": []
}
"""#

private let timelineJSON = #"""
{
  "version": 1, "day": "2026-10-21", "activeMinutes": 30,
  "spans": [
    { "id": "sp2", "day": "2026-10-21", "start": 1792591200000, "end": 1792592100000, "activeMinutes": 15, "app": "com.google.Chrome",
      "appName": "Chrome", "title": "Intro", "host": "mail.google.com", "taskId": "task_1", "eventIds": [] },
    { "id": "sp1", "day": "2026-10-21", "start": 1792573200000, "end": 1792574100000, "activeMinutes": 15, "app": "com.google.Chrome",
      "appName": "Chrome", "title": "Intro", "host": "mail.google.com", "taskId": "task_1", "eventIds": [] }
  ],
  "byTask": [{ "taskId": "task_1", "name": "Outreach emails", "kind": "email.outreach", "minutes": 30 }]
}
"""#

@Suite("S08 wire contract")
struct S08WireTests {
  @Test("workflow detail maps steps, the gate, connectors with state, schedule note and batch size")
  func workflow() throws {
    let w = try decode(WorkflowDTO.self, workflowJSON).toWorkflow(dryRunHash: "9f2c…e1")
    #expect(w.state == .readyForReview)
    #expect(w.steps.map(\.type) == [.read, .draft, .approvalGate, .send, .log])
    #expect(w.steps[0].connectorId == "gsheets" && w.steps[1].connectorId == nil)
    #expect(w.connectors.map(\.state) == [.connected, .missing, .missingEnv])
    #expect(w.connectors[1].kind == .composio)
    #expect(w.schedule.summary == "Weekdays at 09:00 · 8 a batch" && w.schedule.batchSize == 8)
    #expect(w.logTarget == "Google Sheets")
    #expect(w.skillMarkdown.contains("investor-outreach"))
    #expect(w.toneCard.isEmpty)  // not on the wire: the view says so
    #expect(w.batchHash == "9f2c…e1")
  }

  @Test("pending items become the first run's recipients, with or without a display name")
  func recipients() throws {
    let w = try decode(WorkflowDTO.self, workflowJSON).toWorkflow()
    #expect(w.nextBatch.map(\.email) == ["tomas@northline.fund", "grace@larchmontseed.com"])
    #expect(w.nextBatch[0].name == "Tomás Ibarra")
    #expect(FirstRunPlan(workflow: w).headline == "Send 2 emails to these recipients")
  }

  @Test("with no pending items the plan says the first run picks them and you see each one first")
  func noRecipientsYet() throws {
    var dto = try decode(WorkflowDTO.self, workflowJSON)
    dto.pendingItems = []
    let plan = FirstRunPlan(workflow: dto.toWorkflow())
    #expect(plan.headline == "Draft up to 8 emails")
    #expect(plan.pendingNote?.contains("before anything sends") == true)
    #expect(plan.steps[0] == "Draft up to 8 emails in your voice.")
  }

  @Test("summary-only workflows (GET /workflows) decode without the detail fields")
  func summaryList() throws {
    let detail = try decode(WorkflowDTO.self, workflowJSON)
    var summary = detail
    summary.steps = nil; summary.skillMd = nil; summary.schedule = nil; summary.batchSize = nil; summary.pendingItems = nil
    let data = try JSONEncoder().encode(WorkflowsResponse(version: 1, workflows: [summary]))
    let back = try BrainWire.decoder.decode(WorkflowsResponse.self, from: data)
    #expect(back.workflows[0].toWorkflow().steps.isEmpty)
    #expect(back.workflows[0].scheduleSummary == "Weekdays at 09:00")  // falls back to the trigger detail
  }

  @Test("dry run: drafts against what you sent, code arithmetic, denied side effects, the batch hash")
  func dryRun() throws {
    let d = try decode(DryRunResponse.self, dryRunJSON).toDryRun()
    #expect(d.batchHash == "9f2c…e1")
    #expect(d.deniedSideEffects == 4)
    #expect(d.items.count == 2)
    #expect(d.items[0].recipient.display == "Priya, Halden Ventures")
    #expect(d.items[0].whatYouSent.contains("Tuesday"))
    #expect(d.items[0].minutesSaved == 2.9 && d.items[0].reviewSeconds == 20)
    #expect(d.items[0].sentAt == Date(timeIntervalSince1970: 1_792_386_840))
    #expect(d.items[1].ourDraft.isEmpty)  // draft: null
  }

  @Test("the review approves the dry run's hash, not one the workflow carried")
  func approvesDryRunHash() throws {
    var w = try decode(WorkflowDTO.self, workflowJSON).toWorkflow()
    var flow = ApprovalFlow(workflow: w)
    #expect(flow.handle(.approve, at: Date()).isEmpty)  // no dry run yet, nothing to approve
    let d = try decode(DryRunResponse.self, dryRunJSON).toDryRun()
    w = w.adopting(d)
    #expect(w.batchHash == "9f2c…e1")
    flow = ApprovalFlow(workflow: w)
    #expect(flow.canApprove)
    var other = d
    other.workflowId = "wf_other"
    #expect(MockBrainClient.outreachWorkflow.adopting(other).batchHash == "b_7f3a91c2")  // another workflow's run
  }

  @Test("GET /connectors: catalog and per-insight statuses become one id → state map")
  func connectors() throws {
    let states = try decode(ConnectorsResponse.self, connectorsJSON).states()
    #expect(states == ["gmail": .connected, "hubspot": .missingEnv, "gsheets": .missing])
    let i = MockBrainClient.outreach.applying(connectorStates: states)
    #expect(i.connectors.first?.state == .connected)
  }

  @Test("dashboard: s05 state, needs-you reason, measured hours and the pending batch time")
  func dashboard() throws {
    let r = try decode(DashboardResponse.self, dashboardJSON)
    let a = r.automations[0].toDashboardAutomation(taskId: "task_1")
    #expect(a.state == .needsYou)  // state wins over the legacy "approved"
    #expect(a.needsYouReason == "A batch of 8 waits for your review.")
    #expect(a.measuredHoursPerWeek == 16.8 && a.workflowId == "wf_1")
    #expect(a.lastRunAt == Date(timeIntervalSince1970: 1_792_800_000))
    #expect(a.nextRunAt == nil)  // not on the wire
    #expect(r.hoursSaved == HoursSaved(estimated: 21.9, measured: 16.8))
    #expect(r.toAutomations().map(\.status) == [.failed])  // rail: needs_you reads amber
  }

  @Test("timeline: spans in time order; hatched only after the task's automation was turned on")
  func timeline() throws {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let t = try decode(TimelineResponse.self, timelineJSON)
    let on = Date(timeIntervalSince1970: 1_792_580_000)  // between the two spans
    let day = t.toTimelineDay(activeSince: ["task_1": on], calendar: cal)
    #expect(day.bars.map(\.id) == ["sp1", "sp2"])
    #expect(day.bars.map(\.automated) == [false, true])
    #expect(day.date == cal.date(from: DateComponents(year: 2026, month: 10, day: 21)))
    #expect(t.toTimelineDay(activeSince: [:], calendar: cal).bars.allSatisfy { !$0.automated })
  }
}
