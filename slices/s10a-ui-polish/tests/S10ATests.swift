import Foundation
import Testing

// S10A: UI polish after DESIGN-REVIEW-1. One source of truth for every figure, honest hero, neutral timeline inks
// with 3:1 contrast and merged spans, countdown bars that match their seconds, Turn on blocked while a connector is
// missing, plain words, and the s09b brain additions (latest dry run, stub model label).

enum S10AFixture {
  static let s09a = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("s09a-wiring/tests/fixtures")
  static func data(_ name: String) -> Data { (try? Data(contentsOf: s09a.appendingPathComponent(name))) ?? Data() }

  static func matches(_ pattern: String, in strings: [String]) -> [String] {
    let re = try! NSRegularExpression(pattern: pattern)
    return strings.flatMap { s in
      re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { m in
        Range(m.range(at: 1), in: s).map { String(s[$0]) }
      }
    }
  }

  static var card: CardCopy { CardCopy(SampleWeek.outreach) }
  static var review: ReviewCopy { ReviewCopy(workflow: SampleWeek.workflow, dryRun: SampleWeek.dryRun) }
  static var confirm: ConfirmCopy { ConfirmCopy(plan: FirstRunPlan(workflow: SampleWeek.workflow), now: MockBrainClient.reviewNow) }
  static var dashboard: DashboardCopy { DashboardCopy(SampleWeek.dashboard, now: MockBrainClient.reviewNow) }
}

@Suite("S10A one source of truth")
struct S10AConsistencyTests {
  @Test("card, review and dashboard print the same weekly saving for the same workflow")
  func sameSaving() {
    let card = S10AFixture.card, review = S10AFixture.review, dash = S10AFixture.dashboard
    #expect(card.savingChip == "Saves 21.9 h a week")
    #expect(review.savingChip == card.savingChip)
    let row = dash.rows.first { $0.name == SampleWeek.workflow.name }!
    #expect(row.saved == "16.8 h" && row.savedQualifier == "measured")
    #expect(dash.heroDetail == "Estimated 21.9 h a week")
  }

  @Test("every 'h a week' on the three screens is the estimate or the one measured figure, never a third number")
  func noThirdNumber() {
    // The card's receipt lines (hours by hand, review time) and its likely range are other quantities, checked below.
    let card = S10AFixture.card
    let all = [card.title, card.facts, card.savingChip ?? ""] + S10AFixture.review.allStrings + S10AFixture.confirm.allStrings
      + S10AFixture.dashboard.allStrings
    #expect(card.range.contains("19.7–22.9 h a week"))
    let perWeek = Set(S10AFixture.matches(#"(\d+(?:\.\d+)?) h a week"#, in: all))
    #expect(perWeek == ["21.9", "16.8"])
    let estimates = Set(S10AFixture.matches(#"(?:Saves|Estimated) (\d+(?:\.\d+)?) h"#, in: all))
    #expect(estimates == ["21.9"])
    // The card's saving line and its arithmetic say the same digits.
    #expect(S10AFixture.card.arithmetic.last?.result.hasPrefix("21.9 h") == true)
  }

  @Test("the batch size is one number on the review, its schedule and the confirm sheet")
  func batchSize() {
    let n = SampleWeek.workflow.schedule.batchSize
    let strings = S10AFixture.review.allStrings + S10AFixture.confirm.allStrings
    let sizes = Set(S10AFixture.matches(#"(\d+) emails"#, in: strings))
    #expect(sizes == ["\(n)"])
    #expect(S10AFixture.review.schedule.contains("up to \(n) emails a batch"))
  }

  @Test("the rail and the dashboard count the same stored days")
  func days() {
    #expect(SampleWeek.rail.observerLabel.hasSuffix("Day 7 of 7"))
    #expect(S10AFixture.dashboard.observingDays == "7 of 7 days stored")
    #expect(SampleWeek.status.daysStored == SampleWeek.dashboard.observing.daysStored)
  }

  @Test("live brain fixtures: the card chip and the dashboard row print the brain's 22.0, not 22")
  func liveFixtures() throws {
    let ins = try JSONDecoder().decode(InsightsResponse.self, from: S10AFixture.data("insights.json")).toInsights()
    let dash = try JSONDecoder().decode(DashboardResponse.self, from: S10AFixture.data("dashboard.json"))
    let card = CardCopy(ins[0])
    #expect(card.savingChip == "Saves 22.0 h a week")
    let a = dash.automations[0].toDashboardAutomation()
    #expect(Figures.savedHours(value: a.estimatedHoursPerWeek, arithmetic: a.arithmetic) == "22.0 h")
    #expect(card.title == "Outreach emails take 65% of your week")  // s10d: whole percent in the headline
    #expect(card.facts == "495 emails this week, about 3.0 min each")
  }

  @Test("the chip reads the brain's printed digits even when the raw value rounds differently")
  func printedDigits() {
    #expect(Figures.saves(value: 22, arithmetic: "… → saves 22.0 h/wk (89%)") == "Saves 22.0 h a week")
    #expect(Figures.saves(value: 2.2083, arithmetic: nil) == "Saves 2.2 h a week")
    #expect(Figures.printedSaving("no saving here") == nil)
  }

  @Test("hours always carry one decimal, like the brain")
  func hours() {
    #expect(Figures.hours(22) == "22.0 h")
    #expect(Figures.hours(0.5) == "0.5 h")
    #expect(Figures.range(low: 18.5625, high: 22.6875) == "18.6–22.7 h a week")
    #expect(Figures.count(1, "emails") == "1 email" && Figures.count(1200, "emails") == "1,200 emails")
  }

  @Test("arithmetic steps keep the brain's digits and split formula from result")
  func steps() {
    let line = "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)"
    let s = Figures.arithmeticSteps(line)
    #expect(s.map(\.label) == ["By hand", "Your review", "Saved"])
    #expect(s.map(\.formula) == ["98.4/day × 5 days × 3.0 min", "492 × 20 s", ""])
    #expect(s.map(\.result) == ["24.6 h", "2.7 h", "21.9 h (89%)"])
    let digits = Set(S10AFixture.matches(#"(\d+(?:\.\d+)?)"#, in: s.map(\.text)))
    #expect(digits.isSubset(of: Set(S10AFixture.matches(#"(\d+(?:\.\d+)?)"#, in: [line]))))
  }
}

@Suite("S10A dashboard hero")
struct S10AHeroTests {
  private func data(_ edit: (inout DashboardData) -> Void) -> DashboardData {
    var d = SampleWeek.dashboard
    edit(&d)
    return d
  }

  @Test("nothing turned on: 'Nothing saved yet', no number, the estimate as secondary text")
  func nothingSaved() {
    let d = data {
      $0.automations = $0.automations.map { var a = $0; a.state = .readyForReview; a.measuredHoursPerWeek = nil; return a }
      $0.hours = HoursSaved(estimated: 0, measured: nil)
    }
    let c = DashboardCopy(d, now: MockBrainClient.reviewNow)
    #expect(c.heroValue == nil && c.heroPlaceholder == "Nothing saved yet")
    #expect(c.heroDetail.contains("21.9 h a week") && c.heroDetail.contains("once you turn it on"))
  }

  @Test("on but not measured: no number either")
  func notMeasured() {
    let d = data { $0.hours = HoursSaved(estimated: 21.9, measured: nil) }
    let c = DashboardCopy(d, now: MockBrainClient.reviewNow)
    #expect(c.heroValue == nil && c.heroPlaceholder == "Nothing measured yet")
    #expect(c.heroDetail.hasPrefix("Estimated"))
  }

  @Test("measured: the measured number, labelled, with the estimate beside it")
  func measured() {
    let c = S10AFixture.dashboard
    #expect(c.heroValue == "16.8 h a week" && c.heroQualifier == "Measured")
  }

  @Test("ready for review and needs you are one amber count")
  func counts() {
    let c = S10AFixture.dashboard
    #expect(c.counts.map { "\($0.n) \($0.label)" } == ["1 active", "2 need you"])
    #expect(c.counts.filter { $0.role == .needsYou }.count == 1)
  }
}

@Suite("S10A timeline")
struct S10ATimelineTests {
  private func bar(_ id: String, _ task: String, _ h0: Int, _ m0: Int, _ h1: Int, _ m1: Int, automated: Bool = false) -> TimelineBar {
    TimelineBar(id: id, taskId: task, start: MockBrainClient.local(19, h0, m0), end: MockBrainClient.local(19, h1, m1),
                automated: automated, title: "", counterparty: nil)
  }

  @Test("every task ink is at least 3:1 against its box, dark and light")
  func contrast() {
    for dark in [true, false] {
      for rank in 0..<4 {
        #expect(TimelineInk.contrast(rank: rank, dark: dark) >= 3, "rank \(rank) dark \(dark)")
      }
    }
  }

  @Test("inks step down in luminance contrast: rank 0 is the strongest")
  func steps() {
    for dark in [true, false] {
      let c = (0..<4).map { TimelineInk.contrast(rank: $0, dark: dark) }
      #expect(c == c.sorted(by: >))
      #expect(Set(c).count == 4)
    }
  }

  @Test("same-task spans less than 3 min apart become one bar with the first id")
  func joins() {
    let m = TimelineMerge.merge([bar("a", "t", 9, 0, 9, 10), bar("b", "t", 9, 12, 9, 30), bar("c", "t", 9, 40, 9, 50)])
    #expect(m.map(\.id) == ["a", "c"])
    #expect(m[0].end == MockBrainClient.local(19, 9, 30))
  }

  @Test("a span under 3 min joins the neighbour it touches")
  func absorbs() {
    let m = TimelineMerge.merge([bar("a", "t1", 9, 0, 9, 20), bar("b", "t2", 9, 20, 9, 22), bar("c", "t3", 9, 22, 9, 30)])
    #expect(m.map(\.id) == ["a", "c"])
    #expect(m[0].end == MockBrainClient.local(19, 9, 22))
  }

  @Test("an isolated short span stays (drawn at the minimum width)")
  func isolated() {
    let m = TimelineMerge.merge([bar("a", "t1", 9, 0, 9, 20), bar("b", "t2", 10, 0, 10, 1)])
    #expect(m.map(\.id) == ["a", "b"])
  }

  @Test("a barcode of sub-minute slivers turns into a few blocks")
  func barcode() {
    var bars: [TimelineBar] = []
    for i in 0..<60 { bars.append(bar("s\(i)", i % 3 == 0 ? "x" : "y", 9, i, 9, i)) }
    bars = bars.enumerated().map { i, b in
      var b = b
      b.start = MockBrainClient.local(19, 9, 0).addingTimeInterval(Double(i) * 40)
      b.end = b.start.addingTimeInterval(35)
      return b
    }
    #expect(TimelineMerge.merge(bars).count <= 2)
  }

  @Test("the axis spans whole two-hour steps and labels its last hour")
  func axis() {
    let l = TimelineLayout(startHour: 8, endHour: 19).evenSpan
    #expect(l.endHour == 20 && l.ticks.last == 20 && l.ticks.first == 8)
    #expect(TimelineLayout(startHour: 7, endHour: 21).evenSpan.ticks == [7, 9, 11, 13, 15, 17, 19, 21])
  }

  @Test("the evidence pointer lands on a drawn (merged) bar")
  func evidenceBar() {
    let b = SampleWeek.dashboard.evidenceBar
    let drawn = SampleWeek.dashboard.days.flatMap { TimelineMerge.merge($0.bars) }
    #expect(b.map { bar in drawn.contains { $0.id == bar.id } } == true)
  }
}

@Suite("S10A countdown")
struct S10ACountdownTests {
  @Test("the undo hairline is exactly the seconds the label shows over the window")
  func undo() {
    let start = Date(timeIntervalSince1970: 1000)
    let u = UndoWindow(action: .build("i"), startedAt: start)
    for (elapsed, shown) in [(0.0, 5), (0.4, 5), (1.0, 4), (1.6, 4), (2.5, 3), (4.99, 1), (5.0, 0), (9, 0)] {
      let now = start.addingTimeInterval(elapsed)
      #expect(u.secondsShown(at: now) == shown)
      #expect(u.secondsLeftLabel(at: now) == "\(shown)s")
      #expect(abs(u.hairline(at: now) - Double(shown) / Tokens.undoSeconds) < 1e-9)
    }
  }

  @Test("the arming countdown follows the same rule")
  func arming() {
    let start = Date(timeIntervalSince1970: 1000)
    let c = Countdown(startedAt: start)
    #expect(c.hairline(at: start.addingTimeInterval(1.6)) == 0.8)
    #expect(c.secondsLeftLabel(at: start.addingTimeInterval(1.6)) == "4s")
    #expect(c.hairline(at: start.addingTimeInterval(6)) == 0)
  }

  @Test("the undo line says what lands and in how long")
  func message() {
    #expect(UndoCopy.message(.build("i"), seconds: 4) == "Drafting the workflow in 4s")
    #expect(UndoCopy.message(.notNow("i"), seconds: 2) == "Snoozing until tomorrow in 2s")
  }
}

@Suite("S10A turn on")
struct S10ATurnOnTests {
  @Test("a missing connector disables Turn on, says why, and makes Connect the primary")
  func blocked() {
    let plan = FirstRunPlan(workflow: SampleWeek.workflow)
    #expect(!plan.canTurnOn)
    #expect(plan.connectTitle == "Connect Google Sheets")
    #expect(plan.turnOnBlockedReason?.hasPrefix("Connect Google Sheets first.") == true)
    let c = ConfirmCopy(plan: plan, now: MockBrainClient.reviewNow)
    #expect(!c.canTurnOn && c.blockedReason != nil)
  }

  @Test("↩ and ⌘↩ cannot arm while blocked; Esc still cancels")
  func guardKeys() {
    var flow = ApprovalFlow(workflow: SampleWeek.workflow)
    _ = flow.handle(.approve, at: Date(timeIntervalSince1970: 0))
    #expect(!ArmGuard.allows(.confirm, flow: flow))
    #expect(!ArmGuard.allows(.approve, flow: flow))
    #expect(ArmGuard.allows(.escape, flow: flow))
  }

  @Test("everything connected: Turn on is enabled and arms")
  func ready() {
    var w = SampleWeek.workflow
    w.connectors = w.connectors.map { $0.applying(["gsheets": .connected]) }
    var flow = ApprovalFlow(workflow: w)
    _ = flow.handle(.approve, at: Date(timeIntervalSince1970: 0))
    #expect(flow.plan.canTurnOn && ArmGuard.allows(.confirm, flow: flow))
    #expect(flow.handle(.confirm, at: Date(timeIntervalSince1970: 1)) == [.armed])
  }

  @Test("an Add key connector names the key, not a connection")
  func key() {
    var w = SampleWeek.workflow
    w.connectors = w.connectors.map { $0.id == "gsheets" ? Connector(id: "gsheets", name: "Google Sheets", kind: .composio, connected: false, missingEnv: true) : $0 }
    #expect(FirstRunPlan(workflow: w).connectTitle == "Sign in to Google Sheets")  // s10d: no "key" in copy
  }

  @Test("the confirm sheet does not number its lists and does not repeat the sender")
  func confirmLists() {
    let c = S10AFixture.confirm
    #expect(c.lines.count == 4 && c.lines.allSatisfy { !$0.symbol.isEmpty })
    let sender = SampleWeek.workflow.sendFrom
    #expect(c.allStrings.filter { $0.contains(sender) }.count == 1)
    #expect(!c.subtitle.contains(". ·") && !c.subtitle.contains("First run Not"))
  }
}

@Suite("S10A plain words")
struct S10APlainWordsTests {
  @Test("no presenter string carries an internal word")
  func noLeaks() {
    let all = S10AFixture.card.allStrings + S10AFixture.review.allStrings + S10AFixture.confirm.allStrings
      + S10AFixture.dashboard.allStrings
    for s in all { #expect(PlainWords.leaks(s) == nil, "\(s)") }
  }

  @Test("the real brain's step text comes out in plain words")
  func liveSteps() throws {
    let dto = try JSONDecoder().decode(WorkflowDTO.self, from: S10AFixture.data("workflow-draft.json"))
    let copy = ReviewCopy(workflow: dto.toWorkflow(), dryRun: nil)
    for s in copy.allStrings { #expect(PlainWords.leaks(s) == nil, "\(s)") }
    #expect(copy.steps[0].detail == "Read your recipient list.")
    #expect(copy.steps[1].detail.contains("not in the log yet"))
  }

  @Test("the brain's long schedule note gets one clean sentence per idea")
  func schedule() {
    let long = "Weekdays at 09:00 a new batch is drafted and waits for your review. · 20 a batch"
    #expect(ScheduleCopy.line(summary: long, batchSize: 20)
            == "Weekdays at 09:00 a new batch is drafted and waits for your review. Up to 20 emails a batch.")
    #expect(ScheduleCopy.line(summary: "Weekdays at 09:00 · 8 a batch", batchSize: 8) == "Weekdays at 09:00, up to 8 emails a batch.")
    #expect(ScheduleCopy.confirm(summary: "Weekdays at 09:00", batchSize: 8, firstRunAt: nil, now: Date())
            == "Not scheduled yet. Weekdays at 09:00, up to 8 emails a batch.")
  }

  @Test("card title is short, has no full stop and agrees in number")
  func title() {
    #expect(S10AFixture.card.title == "Investor outreach emails take 64% of your week")  // s10d
    #expect(CardCopy(SampleWeek.scheduling).title == "Scheduling back-and-forth takes 14% of your week")
  }

  @Test("evidence names the app a person knows and sets other apps apart")
  func evidence() {
    let e = EvidenceCopy(spans: MockBrainClient.sampleEvidence["ins_outreach"]!, insight: SampleWeek.outreach)
    #expect(e.header == "Recent emails in Gmail")
    #expect(e.rows.count == 5 && e.elsewhere?.contains("Numbers") == true)
  }

  @Test("onboarding never calls a skippable permission Required")
  func permissions() {
    #expect(PermissionKind.allCases.map(\.importance) == ["Needed for insights", "Recommended", "Optional"])
  }
}

/// Answers one route; anything else is a 404.
final class S10ATransport: BrainTransport, @unchecked Sendable {
  let path: String, body: Data, status: Int
  init(path: String, status: Int = 200, body: Data) { self.path = path; self.status = status; self.body = body }
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let ok = request.url?.path == path
    let code = ok ? status : 404
    return (ok ? body : Data(#"{"error":"not_found"}"#.utf8),
            HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
  }
}

@Suite("S10A brain additions")
struct S10ABrainTests {
  private func client(_ t: BrainTransport) -> HTTPBrainClient {
    HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:9")!, token: String(repeating: "t", count: 40))),
                    transport: t)
  }

  @Test("the latest stored dry run is read instead of drafting again, with its model label")
  func latest() async throws {
    var json = try JSONSerialization.jsonObject(with: S10AFixture.data("dry-run.json")) as! [String: Any]
    json["model"] = "stub"
    let id = json["workflowId"] as! String
    let t = S10ATransport(path: "/workflows/\(id)/dry-runs/latest", body: try JSONSerialization.data(withJSONObject: json))
    let d = try await client(t).latestDryRun(workflowId: id)
    #expect(d?.isSample == true && d?.workflowId == id)
    let copy = ReviewCopy(workflow: SampleWeek.workflow, dryRun: d)
    #expect(copy.sampleChip == "Sample drafts" && copy.oursTitle == "Sample draft")
  }

  @Test("no stored dry run (404) is nil, so the window runs one")
  func none() async throws {
    #expect(try await client(S10ATransport(path: "/nothing", body: Data())).latestDryRun(workflowId: "wf") == nil)
  }

  @Test("a real-model dry run is not labelled a sample")
  func real() {
    var d = SampleWeek.dryRun
    d.model = "real"
    #expect(ReviewCopy(workflow: SampleWeek.workflow, dryRun: d).sampleChip == nil)
  }

  @Test("the demo week runs the brain on the stub model; an env var overrides")
  func model() {
    #expect(BrainLaunch.model(environment: [:], demo: true) == "stub")
    #expect(BrainLaunch.model(environment: [:], demo: false) == nil)
    #expect(BrainLaunch.model(environment: ["OFFLOAD_BRAIN_MODEL": "real"], demo: true) == "real")
    let s = BrainLaunch.spec(bun: URL(fileURLWithPath: "/b"), repo: URL(fileURLWithPath: "/r"), home: URL(fileURLWithPath: "/h"),
                             token: "x", baseEnvironment: [:], model: "stub")
    #expect(Array(s.arguments.suffix(2)) == ["--model", "stub"])
  }

  @Test("dashboard rows take the brain's s09b taskId")
  func taskId() throws {
    var json = try JSONSerialization.jsonObject(with: S10AFixture.data("dashboard.json")) as! [String: Any]
    var autos = json["automations"] as! [[String: Any]]
    autos[0]["taskId"] = "t_x"
    json["automations"] = autos
    let d = try JSONDecoder().decode(DashboardResponse.self, from: try JSONSerialization.data(withJSONObject: json))
    #expect(d.automations[0].toDashboardAutomation().taskId == "t_x")
  }
}

@Suite("S10A brain log")
struct S10ALogTests {
  private func dir() -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("s10a-log-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  @Test("under the limit nothing moves")
  func small() throws {
    let log = dir().appendingPathComponent("brain.err.log")
    try Data(repeating: 1, count: 10).write(to: log)
    #expect(!LogRotation.rotateIfNeeded(log, maxBytes: 100))
  }

  @Test("at the limit it rotates, keeps two, and every file is 0600")
  func rotates() throws {
    let log = dir().appendingPathComponent("brain.err.log")
    let fm = FileManager.default
    for round in 1...3 {
      try Data(repeating: UInt8(round), count: 120).write(to: log)
      #expect(LogRotation.rotateIfNeeded(log, maxBytes: 100))
    }
    #expect(fm.fileExists(atPath: log.path + ".1") && fm.fileExists(atPath: log.path + ".2"))
    #expect(!fm.fileExists(atPath: log.path + ".3"))
    #expect(try Data(contentsOf: URL(fileURLWithPath: log.path + ".1")).first == 3)
    #expect(try Data(contentsOf: URL(fileURLWithPath: log.path + ".2")).first == 2)
    for f in [log.path, log.path + ".1", log.path + ".2"] {
      let mode = (try fm.attributesOfItem(atPath: f)[.posixPermissions] as? NSNumber)?.intValue
      #expect(mode == 0o600, "\(f)")
    }
    #expect(LogRotation.maxBytes == 5 * 1024 * 1024 && LogRotation.keep == 2)
  }

  @Test("purge runs only when the brain has the command")
  func purge() throws {
    let repo = dir()
    try FileManager.default.createDirectory(at: repo.appendingPathComponent("brain/src"), withIntermediateDirectories: true)
    let cli = repo.appendingPathComponent("brain/src/cli.ts")
    try "case \"serve\":".write(to: cli, atomically: true, encoding: .utf8)
    #expect(BrainLaunch.purgeArguments(repo: repo, home: URL(fileURLWithPath: "/h")) == nil)
    try "case \"purge\":".write(to: cli, atomically: true, encoding: .utf8)
    #expect(BrainLaunch.purgeArguments(repo: repo, home: URL(fileURLWithPath: "/h"))?.suffix(3) == ["purge", "--home", "/h"])
  }
}
