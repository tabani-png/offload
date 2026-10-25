import CoreGraphics
import Foundation
import Testing

// S10D: UI round 3 after DESIGN-REVIEW-2. One mock week that ties every figure, a collision-free pointer label,
// rail identity, plain words, the brain's s10b additions (auto-send pin, kept files, log file), the dry run's
// fact check, and the live timeline's today row.

enum S10DFixture {
  static let s09a = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("s09a-wiring/tests/fixtures")
  static func data(_ name: String) -> Data { (try? Data(contentsOf: s09a.appendingPathComponent(name))) ?? Data() }
}

// MARK: one mock week

@Suite("S10D one mock week")
struct S10DMockWeekTests {
  private func minutes(_ task: String) -> Double {
    MockBrainClient.timelineDays.flatMap(\.bars).filter { $0.taskId == task }
      .reduce(0) { $0 + $1.end.timeIntervalSince($1.start) / 60 }
  }

  @Test("the card's share is the outreach bars over every bar, and rounds to the share it prints")
  func shareTies() {
    let i = SampleWeek.outreach
    let all = MockBrainClient.timelineDays.reduce(0.0) { $0 + $1.activeMinutes }
    #expect(abs(minutes("t_outreach") / 60 - i.taskHours) < 1e-9)
    #expect(abs(all / 60 - i.trackedHours) < 1e-9)
    let pct = i.taskHours / i.trackedHours * 100
    #expect(String(format: "%.1f%%", pct) == i.shareDisplay)
    #expect(i.shareDisplay == "64.4%")
    #expect(CardCopy(i).title == "Investor outreach emails take 64% of your week")
  }

  @Test("outreach bars add up to the hours in the card's receipt and its arithmetic")
  func outreachHours() {
    let i = SampleWeek.outreach
    #expect(Figures.hours(minutes("t_outreach") / 60) == "24.6 h")
    #expect(i.saving.arithmetic?.contains("= 24.6 h/wk") == true)
    // 492 emails × 3.0 min is the same 24.6 h.
    #expect(abs(Double(i.instanceCount) * i.medianMinutes / 60 - i.taskHours) < 0.05)
  }

  @Test("the dashboard's tracked total is the card's tracked hours")
  func trackedTies() {
    let d = DashboardCopy(SampleWeek.dashboard, now: MockBrainClient.reviewNow)
    #expect(d.tracked == "\(Figures.hours(SampleWeek.outreach.trackedHours)) tracked")
    #expect(d.tracked == "38.2 h tracked")
  }

  @Test("every insight's hours and share come from the same week")
  func everyInsight() {
    for (i, task) in [(SampleWeek.outreach, "t_outreach"), (SampleWeek.scheduling, "t_sched"), (SampleWeek.crm, "t_crm")] {
      #expect(abs(i.taskHours - minutes(task) / 60) < 1e-9)
      #expect(abs(i.timeShare - i.taskHours / i.trackedHours) < 1e-9)
      #expect(i.trackedHours == MockWeek.trackedHours)
    }
  }
}

// MARK: pointer label

@Suite("S10D pointer label placement")
struct S10DPointerTests {
  let bounds = CGRect(x: 0, y: 0, width: 800, height: 600)
  let label = CGSize(width: 180, height: 26)
  let arrow = CGSize(width: 18, height: 18)

  private func clear(_ p: PointerLabelPlacement.Placement, of rects: [CGRect]) -> Bool {
    rects.allSatisfy { p.rect.intersection($0).isNull || p.rect.intersection($0).isEmpty }
  }

  @Test("never covers the target, the arrow or any obstacle, and stays inside the window")
  func clearOfEverything() {
    let target = CGRect(x: 300, y: 220, width: 60, height: 20)
    let tip = CGPoint(x: 336, y: 240)
    let obstacles = [CGRect(x: 160, y: 250, width: 400, height: 20), CGRect(x: 160, y: 190, width: 400, height: 20),
                     CGRect(x: 370, y: 220, width: 70, height: 20)]
    let p = PointerLabelPlacement.place(label: label, tip: tip, arrow: arrow, target: target, obstacles: obstacles, bounds: bounds)
    #expect(!p.collides)
    #expect(clear(p, of: obstacles + [target, CGRect(origin: tip, size: arrow)]))
    #expect(bounds.insetBy(dx: PointerLabelPlacement.inset, dy: PointerLabelPlacement.inset).contains(p.rect))
  }

  @Test("prefers the target's own line when it is free")
  func sameLine() {
    let target = CGRect(x: 100, y: 300, width: 80, height: 20)
    let p = PointerLabelPlacement.place(label: label, tip: CGPoint(x: 136, y: 310), arrow: arrow, target: target,
                                        obstacles: [], bounds: bounds)
    #expect(p.side == .right && !p.collides)
    #expect(abs(p.rect.midY - target.midY) < 0.5)
  }

  @Test("flips to the left near the right edge")
  func flipsLeft() {
    let target = CGRect(x: 700, y: 300, width: 80, height: 20)
    let p = PointerLabelPlacement.place(label: label, tip: CGPoint(x: 736, y: 310), arrow: arrow, target: target,
                                        obstacles: [CGRect(x: 0, y: 330, width: 800, height: 300), CGRect(x: 0, y: 0, width: 800, height: 290)],
                                        bounds: bounds)
    #expect(p.side == .left && !p.collides)
    #expect(p.rect.maxX <= target.minX)
  }

  @Test("on a dense timeline row the label moves to the free row above, not over the bars")
  func timeline() {
    // Mon row full of bars; Sun row has one bar on the right; Tue row full.
    let rowH: CGFloat = 32
    let mon = CGRect(x: 100, y: 200, width: 160, height: 14)
    let monOthers = [CGRect(x: 262, y: 200, width: 400, height: 14)]
    let sun = [CGRect(x: 560, y: 200 - rowH, width: 120, height: 14)]
    let tue = [CGRect(x: 100, y: 200 + rowH, width: 560, height: 14)]
    let p = PointerLabelPlacement.place(label: CGSize(width: 300, height: 26), tip: CGPoint(x: 136, y: 207), arrow: arrow,
                                        target: mon, obstacles: monOthers + sun + tue, bounds: bounds)
    #expect(!p.collides)
    #expect(p.side == .above)
    #expect(clear(p, of: monOthers + sun + tue + [mon]))
  }

  @Test("a window with no free space still returns a placement, marked as colliding")
  func noRoom() {
    let small = CGRect(x: 0, y: 0, width: 220, height: 60)
    let target = CGRect(x: 20, y: 20, width: 100, height: 20)
    let p = PointerLabelPlacement.place(label: label, tip: CGPoint(x: 50, y: 30), arrow: arrow, target: target,
                                        obstacles: [small], bounds: small)
    #expect(p.collides)
  }

  @Test("the row pointer says Sign in, not key")
  func copy() {
    let crm = MockBrainClient.dashboardAutomations.first { $0.state == .needsYou }!
    #expect(DashboardPointer.target(for: crm).label == "Sign in to HubSpot here")
  }
}

// MARK: card

@Suite("S10D card")
struct S10DCardTests {
  @Test("headline share is a whole percent; the receipt keeps the decimals")
  func wholeShare() {
    #expect(Figures.wholeShare(display: "64.4%", value: 0) == "64%")
    #expect(Figures.wholeShare(display: "64.5%", value: 0) == "65%")
    #expect(Figures.wholeShare(display: nil, value: 0.142) == "14%")
    let c = CardCopy(SampleWeek.outreach)
    #expect(c.arithmetic.last?.result == "21.9 h (89%)")
  }

  @Test("the By hand line counts whole emails when count × median gives the printed hours")
  func wholeCounts() {
    let c = CardCopy(SampleWeek.outreach)
    #expect(c.arithmetic.first?.formula == "492 emails × 3.0 min")
    #expect(c.arithmetic.first?.result == "24.6 h")
    #expect(!c.allStrings.contains { $0.contains("98.4/day") })
    // When it does not tie, the brain's own formula stays.
    var i = SampleWeek.outreach
    i.instanceCount = 300
    #expect(CardCopy(i).arithmetic.first?.formula == "98.4/day × 5 days × 3.0 min")
  }

  @Test("live brain insight: the By hand line uses the brain's printed median, so 495 emails tie to 24.8 h")
  func liveWholeCounts() throws {
    let ins = try JSONDecoder().decode(InsightsResponse.self, from: S10DFixture.data("insights.json")).toInsights()
    let c = CardCopy(ins[0])
    #expect(c.arithmetic.first?.formula == "495 emails × 3.0 min")
    #expect(c.title == "Outreach emails take 65% of your week")
  }

  @Test("balanced wrap never leaves a short last line, and keeps one line when it fits")
  func balanced() {
    let m: (String) -> Double = { Double($0.count) * 10 }
    #expect(BalancedWrap.lines("Short title", width: 360, measure: m) == ["Short title"])
    let l = BalancedWrap.lines("Investor outreach emails take 64% of your week", width: 360, measure: m)
    #expect(l.count == 2)
    #expect(l.joined(separator: " ") == "Investor outreach emails take 64% of your week")
    #expect(abs(l[0].count - l[1].count) <= 8)
    #expect(l[1] != "your week")
  }
}

// MARK: review and dry run

@Suite("S10D review")
struct S10DReviewTests {
  private var copy: ReviewCopy { ReviewCopy(workflow: SampleWeek.workflow, dryRun: SampleWeek.dryRun) }

  @Test("a step that runs on this Mac does not say so twice")
  func noDuplicatePlace() {
    let s2 = copy.steps[1]
    #expect(s2.place == "On this Mac")
    #expect(!s2.detail.contains("on this Mac"))
    #expect(s2.detail == "Skips anyone you emailed in the last 30 days.")
  }

  @Test("the subject drops the fund the header already names")
  func subject() {
    #expect(ReviewCopy.subject("Offload seed round: Bessemer Venture Partners", org: "Bessemer Venture Partners") == "Offload seed round")
    #expect(ReviewCopy.subject("Following up on our call", org: "Ashgrove Capital") == "Following up on our call")
  }

  @Test("a date the draft added is flagged; numbers you wrote are not")
  func factCheck() {
    let items = copy.items
    #expect(items[0].unsupported == ["March"])
    #expect(items[0].check == "Check “March”: not in what you sent or in your facts.")
    #expect(items[1].unsupported.isEmpty && items[2].unsupported.isEmpty)
    #expect(FactCheck.unsupported(draft: "We grew 40% and raised $3M", source: "We grew 40%", facts: "raise: $3M") == [])
    #expect(FactCheck.unsupported(draft: "Free on Friday?", source: "Free Tuesday?", facts: "") == ["Friday"])
    #expect(FactCheck.unsupported(draft: "May I send the deck?", source: "", facts: "") == [])
  }

  @Test("underlines skip function words and words your email also used")
  func emphasis() {
    let other = DiffEmphasis.words("Saw Halden led Tessellate's seed. We're raising")
    #expect(!DiffEmphasis.marks("the"))
    #expect(!DiffEmphasis.marks("our"))
    #expect(!DiffEmphasis.marks("seed", other: other))
    #expect(!DiffEmphasis.marks("Raising", other: other))
    #expect(DiffEmphasis.marks("March.", other: other))
    #expect(!DiffEmphasis.marks("  "))
  }

  @Test("blocked confirm: the primary is Connect, the reason is said once as the amber line")
  func blocked() {
    let c = ConfirmCopy(plan: FirstRunPlan(workflow: SampleWeek.workflow), now: MockBrainClient.reviewNow)
    #expect(!c.canTurnOn)
    #expect(c.connectTitle == "Connect Google Sheets")
    #expect(c.blockers.count == 1)
    var w = SampleWeek.workflow
    w.connectors = w.connectors.map { $0.id == "gsheets" ? Connector(id: "gsheets", name: "Google Sheets", kind: .composio, connected: false, missingEnv: true) : $0 }
    let p = FirstRunPlan(workflow: w)
    #expect(p.connectTitle == "Sign in to Google Sheets")
    #expect(p.blockers.first == "Google Sheets is signed out. Log each send to the pipeline waits until you sign in.")
  }

  @Test("the brain's tone card phrase reads as your voice")
  func voice() {
    #expect(PlainWords.clean("Uses your investor-outreach tone card and your 3 closest emails.") == "Uses your voice and your 3 closest emails.")
  }
}

// MARK: plain words

@Suite("S10D plain words")
struct S10DPlainWordsTests {
  static let jargon = try! NSRegularExpression(pattern: #"\b(key|keys|token|MCP|SKILL|gate|json|JSON|env|pin)\b"#,
                                               options: [.caseInsensitive])

  private func leaks(_ s: String) -> Bool {
    Self.jargon.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
  }

  @Test("no presenter string a person reads carries an internal word")
  func presenters() {
    var w = SampleWeek.workflow
    w.connectors.append(Connector(id: "hubspot", name: "HubSpot", kind: .composio, connected: false, missingEnv: true))
    let strings = CardCopy(SampleWeek.outreach).allStrings
      + ReviewCopy(workflow: w, dryRun: SampleWeek.dryRun).allStrings
      + ConfirmCopy(plan: FirstRunPlan(workflow: w), now: MockBrainClient.reviewNow).allStrings
      + DashboardCopy(SampleWeek.dashboard, now: MockBrainClient.reviewNow).allStrings
      + MockBrainClient.dashboardAutomations.map { DashboardPointer.target(for: $0).label }
      + [MockBrainClient.hubspot, MockBrainClient.sheets, MockBrainClient.gmail].map { ConnectorChipModel($0) }.flatMap { [$0.action ?? "", $0.accessibilityLabel] }
      + [AutoRunCopy.offer(workflowName: "Investor outreach emails")].flatMap { [$0.title, $0.summary, $0.detail ?? ""] }
      + [BrainError.unauthorized.userMessage]
    let bad = strings.filter(leaks)
    #expect(bad.isEmpty, "\(bad)")
  }

  @Test("the chip says Sign in…")
  func chip() {
    #expect(ConnectorChipModel(MockBrainClient.hubspot).action == "Sign in…")
    #expect(ConnectorChipModel(MockBrainClient.hubspot).accessibilityLabel == "HubSpot, signed out")
  }
}

// MARK: rail and observer

@Suite("S10D rail and observer")
struct S10DRailTests {
  @Test("not recording and paused both offer Resume; watching offers Pause")
  func resume() {
    func rail(_ s: ObserverState) -> RailModel {
      RailModel(status: ObserverStatus(state: s, daysStored: 7, windowDays: 7, nextPurge: nil, insightsWaiting: 0),
                automations: [], micRecording: false)
    }
    #expect(rail(.stale).observerResumable)
    #expect(rail(.paused).observerResumable)
    #expect(!rail(.watching).observerResumable)
  }

  @Test("every dot has a name in the hover lines, observer first")
  func names() {
    let r = SampleWeek.rail
    let lines = r.hoverLines
    #expect(lines.count == r.dots.count)
    #expect(lines.first?.id == "observer" && lines.first?.text == r.observerLabel)
    #expect(lines.dropFirst().allSatisfy { $0.text.contains(" · ") })
    #expect(lines.contains { $0.text == "Investor outreach emails · running" })
  }

  @Test("the dashboard's observer action: Pause, Resume, or Settings when Screen Recording is off")
  func observerAction() {
    let off = [PermissionState(.screenRecording, granted: false)]
    let on = [PermissionState(.screenRecording, granted: true)]
    #expect(ObserverAction.forState(.watching, permissions: on) == .pause)
    #expect(ObserverAction.forState(.paused, permissions: on) == .resume)
    #expect(ObserverAction.forState(.stale, permissions: on) == .resume)
    #expect(ObserverAction.forState(.stale, permissions: off).title == "Open Settings")
    #expect(ObserverAction.forState(.stale, permissions: on).title == "Resume watching")
  }

  @Test("dashboard: the measured footnote only shows with a measured figure")
  func heroNote() {
    #expect(DashboardCopy(SampleWeek.dashboard, now: MockBrainClient.reviewNow).heroNote != nil)
    var before = SampleWeek.dashboard
    before.automations = before.automations.map { var a = $0; a.state = .readyForReview; a.measuredHoursPerWeek = nil; return a }
    before.hours = HoursSaved(estimated: 0, measured: nil)
    #expect(DashboardCopy(before, now: MockBrainClient.reviewNow).heroNote == nil)
  }

  @Test("sections: four places, ⌘1 to ⌘4")
  func sections() {
    #expect(DashboardSection.allCases.map(\.title) == ["Overview", "Automations", "This week", "Observing"])
    #expect(DashboardSection.forShortcut(3) == .week)
    #expect(DashboardSection.forShortcut(5) == nil)
    #expect(DashboardSection.observing.shortcut == "⌘4")
  }
}

// MARK: timeline

@Suite("S10D timeline")
struct S10DTimelineTests {
  private let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()

  private func bar(_ id: String, _ task: String, _ h0: Int, _ m0: Int, _ h1: Int, _ m1: Int, auto: Bool = false) -> TimelineBar {
    let d = { (h: Int, m: Int) in self.cal.date(from: DateComponents(year: 2026, month: 10, day: 20, hour: h, minute: m))! }
    return TimelineBar(id: id, taskId: task, start: d(h0, m0), end: d(h1, m1), automated: auto, title: "", counterparty: nil)
  }

  @Test("slivers under 10 minutes fold into the neighbour they touch; Offload's runs never do")
  func fold() {
    let bars = [bar("a", "other", 9, 0, 9, 6), bar("b", "t1", 9, 7, 10, 30), bar("c", "t1", 11, 0, 11, 8, auto: true),
                bar("d", "other", 11, 9, 12, 0)]
    let out = TimelineMerge.display(bars)
    #expect(out.map(\.id) == ["b", "c", "d"])
    #expect(out[0].start == bars[0].start)
    #expect(out.contains { $0.automated })
  }

  @Test("the layout covers now when today has a row")
  func now() {
    let today = cal.date(from: DateComponents(year: 2026, month: 10, day: 25))!
    let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 25, hour: 2, minute: 10))!
    let days = [TimelineDay(day: "2026-10-25", date: today, bars: [])]
    let l = TimelineLayout(startHour: 8, endHour: 20).including(now, days: days, calendar: cal)
    #expect(l.startHour == 2 && l.endHour == 20)
    let none = TimelineLayout(startHour: 8, endHour: 20).including(now, days: [], calendar: cal)
    #expect(none.startHour == 8)
  }

  @Test("the live composer adds an empty today row after the stored days")
  func todayRow() throws {
    let st = try BrainWire.decoder.decode(StatusResponse.self, from: S10DFixture.data("status.json"))
    let dash = try BrainWire.decoder.decode(DashboardResponse.self, from: S10DFixture.data("dashboard.json"))
    let tl = TimelineResponse(version: 1, day: "2026-10-21", activeMinutes: 0, spans: [], byTask: [])
    let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 25, hour: 1, minute: 51))!
    let d = DashboardComposer.compose(dashboard: dash, status: st, workflows: [], connectors: [:], timelines: [tl],
                                      permissions: [], calendar: cal, now: now)
    #expect(d.days.last?.day == "2026-10-25")
    #expect(d.days.last?.bars.isEmpty == true)
    let without = DashboardComposer.compose(dashboard: dash, status: st, workflows: [], connectors: [:], timelines: [tl],
                                            permissions: [], calendar: cal)
    #expect(without.days.count == d.days.count - 1)
  }
}

// MARK: brain s10b additions

@Suite("S10D brain additions")
struct S10DBrainTests {
  @Test("auto-send summary names who it covers and says new people wait")
  func autoRun() throws {
    let json = """
    {"pinnedAt": 1, "recipients": 40, "pinnedRecipients": \(try String(data: JSONEncoder().encode(MockBrainClient.samplePinned), encoding: .utf8)!),
     "newRecipients": 2, "changedRecipients": 1, "removedRecipients": 0,
     "files": [{"file": "facts.md", "sha256": "x", "changed": false}, {"file": "SKILL.md", "sha256": "y", "changed": true}]}
    """
    let pin = try JSONDecoder().decode(AutoRunPinDTO.self, from: Data(json.utf8))
    let r = AutoRunResult(workflowId: "wf", enabled: true, pin: pin)
    #expect(r.pinnedRecipients.count == 37 && r.waiting == 3 && r.changedFiles == ["SKILL.md"])
    let c = AutoRunCopy(r)
    #expect(c.summary == "Auto-send covers these 37 people and your current facts and voice. Anyone new waits for you.")
    #expect(c.detail?.contains("3 people on your list already wait for you.") == true)
    #expect(!(c.detail ?? "").contains("SKILL"))
  }

  @Test("the workflow summary decodes autoRunPin; GET /observer decodes keptFiles")
  func wire() throws {
    var dto = try BrainWire.decoder.decode(WorkflowDTO.self, from: S10DFixture.data("workflow-draft.json"))
    #expect(dto.autoRunPin == nil)
    dto.autoRunPin = AutoRunPinDTO(pinnedAt: 1, recipients: 1, pinnedRecipients: ["a@b.c"], newRecipients: 0,
                                   changedRecipients: 0, removedRecipients: 0, files: [])
    let back = try BrainWire.decoder.decode(WorkflowDTO.self, from: try JSONEncoder().encode(dto))
    #expect(back.autoRunPin?.pinnedRecipients == ["a@b.c"])
    let obs = """
    {"version": 1, "available": false, "bin": "x", "checkedAt": 1, "error": "no observer", "permissions": null, "status": null,
     "keptFiles": [{"path": "/h/workflows/wf/recipients.csv", "kind": "recipients", "workflowId": "wf", "bytes": 2048,
                    "updatedAt": 1, "note": "Your recipient list (recipients.csv), kept until you delete it."}]}
    """
    let o = try JSONDecoder().decode(ObserverResponseDTO.self, from: Data(obs.utf8))
    let f = o.keptFiles!.map(KeptFile.init)
    #expect(f.first?.name == "Recipient list" && f.first?.size == "2 KB")
    #expect(PlainWords.leaks(f.first!.note) == nil)
  }

  @Test("serve gets --log-file in ~/Library/Logs/Offload, after the model flag")
  func logFile() {
    let log = URL(fileURLWithPath: "/Users/x/Library/Logs/Offload/brain.log")
    let s = BrainLaunch.spec(bun: URL(fileURLWithPath: "/b/bun"), repo: URL(fileURLWithPath: "/r"), home: URL(fileURLWithPath: "/h"),
                             token: "t", baseEnvironment: [:], model: "stub", logFile: log)
    #expect(s.arguments.suffix(4) == ["--model", "stub", "--log-file", log.path])
    let none = BrainLaunch.spec(bun: URL(fileURLWithPath: "/b/bun"), repo: URL(fileURLWithPath: "/r"), home: URL(fileURLWithPath: "/h"),
                                token: "t", baseEnvironment: [:])
    #expect(!none.arguments.contains("--log-file"))
  }

  @Test("purge runs at launch when the brain has the command")
  func purge() {
    let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let args = BrainLaunch.purgeArguments(repo: repo, home: URL(fileURLWithPath: "/h"))
    #expect(args?.suffix(3) == ["purge", "--home", "/h"])
  }
}
