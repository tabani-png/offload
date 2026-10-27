import Foundation
import Testing

// S07: the app's Swift mirror of brain/src/api/types.ts (API_VERSION 1) and its mapping into the view models
// the rail and card render. Fixtures follow the brain's JSON exactly: epoch-ms times, 0..1 ratios, minutes.

private let insightsJSON = #"""
{
  "version": 1,
  "generatedAt": 1792800000000,
  "window": { "days": ["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23"], "activeMinutes": 2292, "events": 41000 },
  "insights": [{
    "id": "ins_a1", "rank": 1, "taskId": "task_1", "kind": "email.outreach", "name": "Outreach emails",
    "description": "Cold and follow-up emails to investors.", "category": "email",
    "app": { "bundleId": "com.google.Chrome", "name": "Chrome", "host": "mail.google.com" },
    "template": "Intro: <*>",
    "figures": {
      "instances":       { "value": 492,   "unit": "count",   "display": "492",      "eventCount": 3479 },
      "daysActive":      { "value": 5,     "unit": "days",    "display": "5 days",   "eventCount": 3479 },
      "instancesPerDay": { "value": 98.4,  "unit": "per_day", "display": "98.4/day", "eventCount": 3479 },
      "medianMinutes":   { "value": 3.0,   "unit": "minutes", "display": "3.0 min",  "eventCount": 3479 },
      "p90Minutes":      { "value": 4.6,   "unit": "minutes", "display": "4.6 min",  "eventCount": 3479 },
      "activeMinutes":   { "value": 1476,  "unit": "minutes", "display": "24.6 h",   "eventCount": 3479 },
      "share":           { "value": 0.644, "unit": "ratio",   "display": "64.4%",    "eventCount": 3479 },
      "sameness":        { "value": 0.86,  "unit": "score",   "display": "0.86",     "eventCount": 3479 }
    },
    "saving": {
      "weeklyItems": 492, "weeklyHoursNow": 24.6, "weeklyHoursAfter": 2.7, "weeklyHoursSaved": 21.9,
      "savingPct": 0.89, "reviewSecondsPerItem": 20,
      "range": { "low": { "hoursSaved": 19.7, "pct": 0.8 }, "high": { "hoursSaved": 22.9, "pct": 0.93 } },
      "arithmetic": "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)",
      "assumptions": ["You review every draft before it sends."]
    },
    "score": { "value": 0.91, "formula": "volume × sameness × reach", "factors": { "volume": 1, "sameness": 0.86, "reachability": 1, "judgement": 0.2, "risk": 0.1 } },
    "judge": { "judgement": 0.2, "risk": 0.1, "reasons": ["Templates repeat."] },
    "connectors": [
      { "id": "gmail", "name": "Gmail", "how": "gmail-mcp", "reach": 1, "role": "primary" },
      { "id": "hubspot", "name": "HubSpot", "how": "composio:hubspot", "reach": 0.6, "limits": "Notes only", "role": "also" }
    ],
    "identifiers": { "counterpartyCount": 310, "domainCount": 240, "topDomains": ["haldenvc.com"] },
    "keywords": ["seed", "round"],
    "examples": [{ "instanceId": "inst_1", "day": "2026-10-19", "start": 1792386840000, "minutes": 3.2, "title": "Intro: Offload seed round" }]
  }]
}
"""#

private let statusJSON = #"""
{
  "version": 1,
  "observer": { "state": "recording", "lastEventAt": 1792800000000 },
  "store": { "days": [
      { "day": "2026-10-19", "source": "encrypted", "events": 9000, "badLines": 0, "errors": [] },
      { "day": "2026-10-20", "source": "encrypted", "events": 9100, "badLines": 0, "errors": [] },
      { "day": "2026-10-21", "source": "both", "events": 8800, "badLines": 2, "errors": [] },
      { "day": "2026-10-22", "source": "encrypted", "events": 9300, "badLines": 0, "errors": [] }
    ], "events": 36200, "badLines": 2 },
  "retention": { "keepDays": 30, "nextPurgeDay": "2026-10-19", "nextPurgeAt": 1794960000000 },
  "analysis": { "generatedAt": 1792800000000, "windowDays": ["2026-10-19"], "tasks": 12, "insights": 3 }
}
"""#

private let evidenceJSON = #"""
{
  "version": 1, "insightId": "ins_a1", "taskId": "task_1",
  "figures": { "instances": { "eventIds": ["ev1","ev2"] }, "share": { "eventIds": ["ev1"] } },
  "instances": [{ "id": "inst_1", "day": "2026-10-19", "start": 1792386840000, "end": 1792387032000, "activeMinutes": 3.2, "spanIds": ["sp1"], "counterparties": ["a@haldenvc.com"] }],
  "spans": [
    { "id": "sp1", "day": "2026-10-19", "start": 1792386840000, "end": 1792387032000, "activeMinutes": 3.2, "app": "com.google.Chrome", "appName": "Chrome", "title": "Intro: Offload seed round", "host": "mail.google.com", "taskId": "task_1", "eventIds": ["ev1","ev2"] },
    { "id": "sp2", "day": "2026-10-19", "start": 1792387100000, "end": 1792387200000, "activeMinutes": 1.5, "app": "com.apple.Numbers", "appName": "Numbers", "title": "Pipeline", "host": "", "taskId": "task_1", "eventIds": ["ev3"] }
  ]
}
"""#

private let dashboardJSON = #"""
{
  "version": 1,
  "automations": [
    { "id": "a1", "insightId": "ins_a1", "name": "Outreach drafts", "status": "approved", "connectors": [], "estimatedHoursSavedPerWeek": 21.9, "measuredHoursSavedPerWeek": null },
    { "id": "a2", "insightId": "ins_b2", "name": "Scheduling", "status": "dry_run", "connectors": [], "estimatedHoursSavedPerWeek": 3.1, "measuredHoursSavedPerWeek": null }
  ],
  "totals": { "estimatedHoursSavedPerWeek": 25.0, "measuredHoursSavedPerWeek": null },
  "suggestions": []
}
"""#

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
  try BrainWire.decoder.decode(T.self, from: Data(json.utf8))
}

@Suite("S07 wire contract")
struct S07WireContractTests {
  @Test("InsightsResponse decodes and maps onto the card's numbers")
  func insights() throws {
    let wire = try decode(InsightsResponse.self, insightsJSON)
    #expect(wire.version == BrainWire.apiVersion)
    let i = try #require(wire.toInsights().first)
    #expect(i.id == "ins_a1")
    #expect(i.timeShare == 0.644)
    #expect(i.instanceCount == 492)
    #expect(i.medianMinutes == 3.0)
    #expect(abs(i.taskHours - 24.6) < 1e-9)
    #expect(abs(i.trackedHours - 38.2) < 1e-9)
    #expect(i.unitPlural == "emails")
    #expect(i.taskPhrase == "outreach emails")
    #expect(Format.headline(i) == "You spent 64% of your week on outreach emails.")
  }

  @Test("the brain's saving arithmetic is shown verbatim, never recomputed")
  func savingVerbatim() throws {
    let i = try #require(try decode(InsightsResponse.self, insightsJSON).toInsights().first)
    #expect(i.saving.hoursPerWeekLow == 19.7 && i.saving.hoursPerWeekHigh == 22.9)
    #expect(Format.savingArithmetic(i) == "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)")
    #expect(Format.savingRange(i.saving) == "19.7–22.9 h back a week")
  }

  @Test("connector `how` maps to a kind")
  func connectors() throws {
    let i = try #require(try decode(InsightsResponse.self, insightsJSON).toInsights().first)
    #expect(i.connectors.map(\.kind) == [.mcp, .composio])
    #expect(i.connectors.map(\.name) == ["Gmail", "HubSpot"])
  }

  @Test("StatusResponse maps observer state, stored days and the purge time")
  func status() throws {
    let s = try decode(StatusResponse.self, statusJSON).toObserverStatus()
    #expect(s.state == .watching)
    #expect(s.daysStored == 4)
    #expect(s.windowDays == 30)
    #expect(s.insightsWaiting == 3)
    #expect(s.nextPurge == Date(timeIntervalSince1970: 1_794_960_000))
    #expect(ObserverState(wire: "paused") == .paused)
    #expect(ObserverState(wire: "stale") == .stale)
    #expect(ObserverState(wire: "no_data") == .noData)
    #expect(ObserverState(wire: "something-new") == .noData)  // additive changes degrade, never crash
  }

  @Test("a stale observer turns the rail dot amber: it needs you")
  func staleRail() throws {
    var s = try decode(StatusResponse.self, statusJSON).toObserverStatus()
    s.state = .stale
    let rail = RailModel(status: s, automations: [], micRecording: false)
    #expect(rail.dots.first?.role == .needsYou)
    #expect(rail.observerLabel == "Not recording · Day 4 of 30")
  }

  @Test("EvidenceResponse spans map to evidence rows with epoch-ms times")
  func evidence() throws {
    let spans = try decode(EvidenceResponse.self, evidenceJSON).toEvidenceSpans()
    #expect(spans.map(\.id) == ["sp1", "sp2"])
    #expect(spans[0].start == Date(timeIntervalSince1970: 1_792_386_840))
    #expect(spans[0].app == "Chrome")
    #expect(spans[0].urlHost == "mail.google.com")
    #expect(spans[1].urlHost == nil)  // empty host means none
    #expect(spans[0].eventIds == ["ev1", "ev2"])
  }

  @Test("DashboardResponse automation states map onto rail colours")
  func dashboard() throws {
    let autos = try decode(DashboardResponse.self, dashboardJSON).toAutomations()
    #expect(autos.map(\.status) == [.running, .awaitingApproval])
    #expect(autos.map { StatusRole.forAutomation($0.status) } == [.done, .needsYou])  // s10e M7
    #expect(autos[0].hoursSavedMeasured == nil)
  }
}
