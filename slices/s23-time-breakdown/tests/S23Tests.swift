import Foundation
import Testing

// S23: the app leads with where your time goes. Written before the code (slices/s23-time-breakdown/SPEC.md).
// The wire tests decode tests/fixtures/time-*.json, recorded from the REAL brain on the neutral week by record.ts
// (verify.sh re-records and diffs them), so the app is checked against what the brain sends.
// Order on the first screen: breakdown → findings with hours → fix kind → workflows (last, as the answer to a finding).

enum S23FixtureError: Error { case noFindings }

enum S23Fixture {
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures")
  static func data(_ name: String) -> Data { (try? Data(contentsOf: dir.appendingPathComponent(name))) ?? Data() }
  static func week() throws -> TimeBreakdown { try TimeBreakdown.decode(data("time-week.json")) }
  static func day() throws -> TimeBreakdown { try TimeBreakdown.decode(data("time-day.json")) }
  static func nofix() throws -> TimeBreakdown { try TimeBreakdown.decode(data("time-week-nofix.json")) }

  /// The recorded week with the first finding's fixKind replaced (to test both paths whether or not s22 is merged).
  static func week(fixKind: String) throws -> TimeBreakdown {
    guard var obj = try JSONSerialization.jsonObject(with: data("time-week.json")) as? [String: Any],
          var findings = obj["findings"] as? [[String: Any]], !findings.isEmpty else { throw S23FixtureError.noFindings }
    findings[0]["fixKind"] = fixKind
    obj["fixKinds"] = "s22"
    obj["findings"] = findings
    return try TimeBreakdown.decode(JSONSerialization.data(withJSONObject: obj))
  }

  static let outreach = try! NSRegularExpression(pattern: "outreach|investor|cold e-?mail|prospect|fundrais|seed round", options: [.caseInsensitive])
  static func outreachFree(_ s: String) -> Bool { outreach.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) == nil }
}

private let base = URL(string: "http://127.0.0.1:51123/")!
private let token = "tok_0123456789abcdef0123456789abcdef0123456789"
private func client(_ t: StubTransport) -> HTTPBrainClient {
  HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: base, token: token)), transport: t, permissions: { [] })
}

// MARK: WIRE

@Suite("S23 wire")
struct S23WireTests {
  @Test("the recorded fixtures exist and are real weeks (not empty)")
  func fixtures() throws {
    for name in ["time-week.json", "time-day.json", "time-week-nofix.json"] { #expect(S23Fixture.data(name).count > 2_000, "\(name)") }
    let w = try S23Fixture.week()
    #expect(w.total.value > 600)
    #expect(w.byTask.count >= 5 && w.byApp.count >= 5 && w.byKind.count >= 6)
    #expect(w.findings.count >= 2)
    #expect(w.window.kind == .week && w.window.days.count == 7)
  }

  @Test("GET /time through the HTTP client, week and day")
  func http() async throws {
    let t = StubTransport(["GET /time": (200, S23Fixture.data("time-week.json"))])
    let w = try await client(t).timeBreakdown(day: nil)
    #expect(w == (try S23Fixture.week()))
    #expect(t.seen.last?.url?.absoluteString == "http://127.0.0.1:51123/time")
    t.set("GET /time", 200, S23Fixture.data("time-day.json"))
    let d = try await client(t).timeBreakdown(day: "2026-10-14")
    #expect(d.window.kind == .day)
    #expect(t.seen.last?.url?.query == "day=2026-10-14")
  }

  @Test("rows add up to the window total in each dimension, as the brain sent them")
  func sums() throws {
    for b in [try S23Fixture.week(), try S23Fixture.day()] {
      for rows in [b.byTask, b.byApp, b.byKind] {
        #expect(abs(rows.map(\.minutes.value).reduce(0, +) - b.total.value) < 1e-6)
        #expect(rows.allSatisfy { !$0.minutes.eventIds.isEmpty || $0.minutes.value == 0 })
      }
    }
  }

  @Test("an unknown fix kind on the wire decodes to none, never a guessed kind")
  func unknownKind() throws {
    let b = try S23Fixture.week(fixKind: "automate_everything")
    #expect(b.findings[0].fixKind == nil)
  }
}

// MARK: ROUND

@Suite("S23 rounding")
struct S23RoundingTests {
  let table: [(Double, String)] = [
    (0, "0.0 h"), (2.9 / 60, "0.0 h"), (3.0 / 60, "0.1 h"), (1479.0 / 60, "24.7 h"), (1482.3 / 60, "24.7 h"),
    (24.75, "24.8 h"), (1485.0 / 60, "24.8 h"), (59.99 / 60, "1.0 h"), (2292.0 / 60, "38.2 h"), (0.05, "0.1 h"),
    (0.15, "0.2 h"), (1.25, "1.3 h"), (2.45, "2.5 h"),
  ]

  @Test("HoursFormat is the brain's one rule: tenths, half up (known answers)")
  func rule() {
    for (h, want) in table {
      #expect(HoursFormat.display(hours: h) == want, "\(h)")
      #expect(HoursFormat.tenths(hours: h) == Int((h * 10 + 0.5 + 1e-9).rounded(.down)))
    }
    #expect(HoursFormat.display(minutes: 1479) == "24.7 h")
    #expect(HoursFormat.display(minutes: 1485) == "24.8 h")
  }

  @Test("every hours figure on the app's other screens uses the same rule (no 24.6 / 24.7 / 24.8 drift)")
  func figuresAgree() {
    for (h, want) in table { #expect(Figures.hours(h) == want, "\(h)") }
  }

  @Test("the app prints exactly the brain's display for every row and finding")
  func sameAsBrain() throws {
    let b = try S23Fixture.week()
    for r in b.byTask + b.byApp + b.byKind { #expect(HoursFormat.display(minutes: r.minutes.value) == r.minutes.display, "\(r.id)") }
    #expect(HoursFormat.display(minutes: b.total.value) == b.total.display)
    for f in b.findings {
      #expect(HoursFormat.display(hours: f.hoursFreed.value) == f.hoursFreed.display)
      #expect(HoursFormat.display(hours: f.observedHoursPerWeek.value) == f.observedHoursPerWeek.display)
    }
  }

  @Test("a finding shows its task's time with the same digits as the task's row")
  func sameQuantitySameDigits() throws {
    let s = TimeScreen(try S23Fixture.week())
    let rows = Dictionary(uniqueKeysWithValues: s.rows(.task).map { ($0.id, $0.hours) })
    #expect(!s.findings.isEmpty)
    for f in s.findings { #expect(rows[f.taskId] == f.taskHours, "\(f.taskId)") }
  }
}

// MARK: ORDER

@Suite("S23 first screen order")
struct S23OrderTests {
  @Test("the screen leads with the breakdown, then findings; workflows come last")
  func sections() throws {
    let s = TimeScreen(try S23Fixture.week())
    #expect(s.sections.first == .breakdown)
    #expect(s.sections == [.breakdown, .findings, .workflows] || s.sections == [.breakdown, .findings])
    #expect(s.qaSections == s.sections.map(\.rawValue).joined(separator: ","))
  }

  @Test("the breakdown offers by task, by app and by kind of work, task first")
  func dimensions() throws {
    let s = TimeScreen(try S23Fixture.week())
    #expect(s.dimensions == [.task, .app, .kind])
    #expect(s.dimensions.map(\.title) == ["By task", "By app", "By kind of work"])
    #expect(s.rows(.kind).count >= 6)
    #expect(s.totalLine.contains(try S23Fixture.week().total.display))
  }

  @Test("each finding reads name, hours, then fix kind; with no fix kind the part is left out")
  func findingParts() throws {
    let with = TimeScreen(try S23Fixture.week(fixKind: "setup"))
    #expect(with.findings[0].parts == [.name, .hours, .fixKind])
    #expect(with.findings[0].fixLabel == "Setup change")
    let without = TimeScreen(try S23Fixture.nofix())
    #expect(!without.findings.isEmpty)
    for f in without.findings {
      #expect(f.parts == [.name, .hours])
      #expect(f.fixLabel == nil)
    }
  }

  @Test("findings keep the brain's order (most hours freed first) and say the hours")
  func findingHours() throws {
    let b = try S23Fixture.week()
    let s = TimeScreen(b)
    #expect(s.findings.map(\.id) == b.findings.map(\.id))
    for (f, wire) in zip(s.findings, b.findings) { #expect(f.hoursLine.contains(wire.hoursFreed.display)) }
  }

  @Test("a workflow appears only as the answer to a finding, after all findings")
  func workflowsLast() throws {
    let b = try S23Fixture.week()
    let s = TimeScreen(b)
    let answered = Set(b.findings.compactMap(\.workflowInsightId))
    #expect(Set(s.workflows.map(\.insightId)) == answered)
    for w in s.workflows { #expect(b.findings.contains { $0.id == w.findingId && $0.workflowInsightId == w.insightId }) }
    if !s.workflows.isEmpty { #expect(s.sections.last == .workflows) }
    // A finding whose best fix is not a workflow is never answered with one, whatever else the wire carries.
    let setup = TimeScreen(try S23Fixture.week(fixKind: "setup"))
    #expect(!setup.workflows.contains { $0.findingId == b.findings[0].id })
  }

  @Test("an empty week shows the breakdown only, with a plain empty line")
  func empty() {
    let s = TimeScreen(.empty)
    #expect(s.sections == [.breakdown])
    #expect(s.findings.isEmpty && s.workflows.isEmpty)
    #expect(!s.emptyLine.isEmpty)
  }
}

// MARK: FIXKIND

@Suite("S23 fix kind")
struct S23FixKindTests {
  @Test("the five kinds of fix, by their wire names, with plain labels")
  func labels() {
    #expect(FixKind.allCases.map(\.rawValue) == ["workflow", "tool", "setup", "remove_step", "leave_alone"])
    #expect(FixKind.allCases.map(\.label) == ["Workflow", "Custom tool", "Setup change", "Remove the step", "Leave it alone"])
  }

  @Test("with s22 absent the screen never shows a fix kind")
  func absent() throws {
    let b = try S23Fixture.nofix()
    #expect(!b.fixKindsAvailable)
    let s = TimeScreen(b)
    for label in FixKind.allCases.map(\.label) { #expect(!s.allStrings.contains { $0.contains(label) && label != "Workflow" }) }
    #expect(s.findings.allSatisfy { $0.fixLabel == nil })
  }

  @Test("each kind decodes from the wire and shows its label")
  func present() throws {
    for k in FixKind.allCases {
      let s = TimeScreen(try S23Fixture.week(fixKind: k.rawValue))
      #expect(s.findings[0].fixLabel == k.label)
    }
  }
}

// MARK: NOCLAIM

@Suite("S23 no inflated claims")
struct S23NoClaimTests {
  @Test("no finding line shows a percentage or a read-and-approve saving")
  func noPercent() throws {
    for b in [try S23Fixture.week(), try S23Fixture.nofix()] {
      let s = TimeScreen(b)
      for f in s.findings {
        for line in f.allStrings {
          #expect(!line.contains("%"), "\(line)")
          #expect(line.range(of: #"read\s*(\+|and|&)\s*approve"#, options: [.regularExpression, .caseInsensitive]) == nil)
        }
      }
      #expect(!s.allStrings.contains { $0.range(of: #"\b(8[5-9]|9\d|100)\s?%"#, options: .regularExpression) != nil })
    }
  }
}

// MARK: NEUTRAL

@Suite("S23 neutral demo")
struct S23NeutralTests {
  @Test("the mock client's time screen is the neutral week, not the outreach sample")
  func mockIsNeutral() async throws {
    let b = try await MockBrainClient().timeBreakdown(day: nil)
    #expect(b == NeutralWeek.breakdown)
    let s = TimeScreen(b)
    #expect(s.allStrings.allSatisfy(S23Fixture.outreachFree))
    #expect(!s.allStrings.contains { $0.contains(SampleWeek.outreach.taskPhrase) })
  }

  @Test("the neutral week is mixed work and email is a small part")
  func mixed() {
    let b = NeutralWeek.breakdown
    let share = Dictionary(uniqueKeysWithValues: b.byKind.map { ($0.id, $0.minutes.value / b.total.value) })
    for k in ["code", "docs", "meeting", "sheet", "browse", "email"] { #expect((share[k] ?? 0) > 0, "\(k)") }
    #expect((share["email"] ?? 1) <= 0.15)
    #expect(share.values.allSatisfy { $0 <= 0.4 })
    #expect(b.findings.count >= 2)
  }

  @Test("the neutral week obeys the brain's invariants: sums tie, one rounding rule, hours capped by the task")
  func invariants() {
    let b = NeutralWeek.breakdown
    for rows in [b.byTask, b.byApp, b.byKind] {
      #expect(abs(rows.map(\.minutes.value).reduce(0, +) - b.total.value) < 1e-6)
      for r in rows { #expect(r.minutes.display == HoursFormat.display(minutes: r.minutes.value)) }
    }
    for f in b.findings {
      #expect(f.hoursFreed.value <= f.observedHoursPerWeek.value + 1e-9)
      #expect(f.hoursFreed.value > 0)
      #expect(!f.taskMinutes.eventIds.isEmpty)
    }
  }
}

// MARK: HOME

@Suite("S23 home")
struct S23HomeTests {
  @Test("Your time is the dashboard's first place and its home, on ⌘1")
  func first() {
    #expect(DashboardSection.allCases.first == .time)
    #expect(DashboardSection.home == .time)
    #expect(DashboardSection.time.title == "Your time")
    #expect(DashboardSection.time.shortcut == "⌘1")
  }
}

// MARK: PR #13 follow-ups

@Suite("S23 PR13 follow-ups")
struct S23FollowUpTests {
  @Test("the dry-run header names the tools the run really used (runsWith), not the chosen ones")
  func runsWith() {
    let c = ReviewCopy(workflow: MockBrainClient.outreachToolsWorkflow, dryRun: MockBrainClient.outreachToolsDryRun)
    #expect(c.dryRunWith == "With Gmail and Google Sheets")
    #expect(!(c.dryRunWith ?? "").contains("Instantly"))
  }

  @Test("the Sheets chip says what the tool picker says")
  func sheetsChip() {
    for connected in [false, true] {
      var w = MockBrainClient.outreachToolsWorkflow
      w.connectors = w.connectors.map { c in var c = c; if c.id == "gsheets" { c.connected = connected }; return c }
      let c = ReviewCopy(workflow: w, dryRun: nil)
      let chip = c.chips.first { $0.name == "Google Sheets" }
      #expect(chip != nil)
      let option = c.tools["s7"]?.options.first { $0.name == "Google Sheets" }
      #expect(option != nil)
      #expect((chip?.role == .done) == (option?.connected == true), "connected=\(connected)")
      #expect((chip?.role == .done) == connected)
    }
  }

  @Test("after Turn on the footer offers Done, not Approve or Run with my voice")
  func footerAfterTurnOn() {
    var w = MockBrainClient.outreachWorkflow
    w.state = .active
    #expect(ReviewPrimary.forWorkflow(w, sample: true) == .done)
    #expect(ReviewPrimary.forWorkflow(w, sample: false) == .done)
    #expect(ReviewPrimary.done.title == "Done")
    for sample in [true, false] {
      let secondary = ReviewFooterButtons.secondary(w, sample: sample)
      #expect(!secondary.contains("Approve") && !secondary.contains("Run with my voice"))
    }
  }

  @Test("the Turned on line reads as a sentence: tomorrow in lower case")
  func turnedOnLine() {
    var w = MockBrainClient.outreachWorkflow
    w.needsYou = []
    w.schedule.nextRunAt = MockBrainClient.local(26, 9, 0)
    let line = ReviewMessages.approved(w, now: MockBrainClient.local(25, 15, 0))
    #expect(line.hasPrefix("Turned on."))
    #expect(line.contains("tomorrow"))
    #expect(!line.contains("Tomorrow") && !line.contains("Today"))
  }
}
