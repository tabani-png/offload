import Foundation
import Testing

// S10E: UI round 4 after DESIGN-REVIEW-3. Connect flow (M1), dry-run diff and voice facts (M2, M3), the timeline that
// proves the card (M6), one state-colour map (M7), one primary per view (M8), and the polish items.

enum S10EFixture {
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures")
  static func data(_ name: String) -> Data { (try? Data(contentsOf: dir.appendingPathComponent(name))) ?? Data() }
  static let banned = try! NSRegularExpression(pattern: "\\b(key|keys|token|MCP|SKILL|gate|json|env)\\b", options: [.caseInsensitive])
  static func plain(_ s: String) -> Bool {
    banned.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) == nil
  }
  static let t0 = Date(timeIntervalSince1970: 1_792_500_000)
}

// MARK: M1 connect

@Suite("S10E connect flow")
struct S10EConnectTests {
  let gmail = Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: false)
  let t0 = S10EFixture.t0

  private func link(_ state: ConnectLinkState, url: String? = nil, simulated: Bool = false, message: String = "") -> ConnectLink {
    ConnectLink(connectorId: "gmail", name: "Gmail", via: .composio, state: state, url: url.flatMap(URL.init(string:)),
                simulated: simulated, message: message, startedAt: t0, connectedAt: state == .connected ? t0 : nil)
  }

  @Test("intro → starting asks the brain once; a second press while starting does nothing")
  func start() {
    var f = ConnectFlow(connector: gmail)
    #expect(f.phase == .intro)
    #expect(f.connect(at: t0) == [.startLink])
    #expect(f.phase == .starting)
    #expect(f.connect(at: t0) == [])
  }

  @Test("waiting with a real URL opens the browser exactly once and keeps polling")
  func waitingOpensOnce() {
    var f = ConnectFlow(connector: gmail)
    _ = f.connect(at: t0)
    let w = link(.waiting, url: "https://connect.composio.dev/link/abc")
    #expect(f.receive(w, at: t0) == [.openURL(URL(string: "https://connect.composio.dev/link/abc")!), .poll])
    #expect(f.phase == .waiting)
    #expect(f.receive(w, at: t0.addingTimeInterval(1)) == [.poll])
  }

  @Test("a simulated link never opens a browser")
  func simulatedNoBrowser() {
    var f = ConnectFlow(connector: gmail)
    _ = f.connect(at: t0)
    #expect(f.receive(link(.waiting, url: "https://example.com/x", simulated: true), at: t0) == [.poll])
  }

  @Test("connected ends the flow and says so; it never approves or sends anything")
  func connected() {
    var f = ConnectFlow(connector: gmail)
    _ = f.connect(at: t0)
    _ = f.receive(link(.waiting, simulated: true), at: t0)
    #expect(f.receive(link(.connected, simulated: true), at: t0.addingTimeInterval(2)) == [.connected])
    #expect(f.phase == .connected)
    #expect(f.tick(at: t0.addingTimeInterval(3)) == [])
    // The only effects a connect flow can ever produce.
    for e in [ConnectFlow.Effect.startLink, .poll, .connected, .openURL(URL(string: "https://a.b")!)] {
      switch e { case .startLink, .poll, .connected, .openURL: break }
    }
  }

  @Test("a failed start shows the brain's words and Try again restarts")
  func failed() {
    var f = ConnectFlow(connector: gmail)
    _ = f.connect(at: t0)
    _ = f.receive(link(.failed, message: "The sign-in did not start."), at: t0)
    #expect(f.phase == .failed)
    #expect(f.failure == "The sign-in did not start.")
    #expect(f.connect(at: t0.addingTimeInterval(5)) == [.startLink])
  }

  @Test("waiting gives up after 5 minutes with a plain sentence")
  func giveUp() {
    var f = ConnectFlow(connector: gmail)
    _ = f.connect(at: t0)
    _ = f.receive(link(.waiting), at: t0)
    #expect(f.tick(at: t0.addingTimeInterval(60)) == [.poll])
    #expect(f.tick(at: t0.addingTimeInterval(ConnectFlow.giveUp + 1)) == [])
    #expect(f.phase == .failed)
    #expect(S10EFixture.plain(f.failure ?? ""))
  }

  @Test("an already connected connector starts connected")
  func alreadyConnected() {
    var c = gmail
    c.connected = true
    var f = ConnectFlow(connector: c)
    #expect(f.phase == .connected)
    #expect(f.connect(at: t0) == [.connected])
  }

  @Test("the sheet's copy: title, what Offload does with it, the route, one primary; plain words in every phase")
  func copy() {
    var f = ConnectFlow(connector: gmail)
    let intro = ConnectCopy(flow: f, returnsToConfirm: true)
    #expect(intro.title == "Connect Gmail")
    #expect(intro.primary == "Connect Gmail")
    #expect(intro.purpose.contains("sent mail") && intro.purpose.contains("approve"))
    #expect(intro.route == "Signs in with Google on this Mac" || intro.route == "Connects through Composio")
    _ = f.connect(at: t0)
    _ = f.receive(link(.waiting, url: "https://x.y/z"), at: t0)
    let waiting = ConnectCopy(flow: f, returnsToConfirm: true)
    #expect(waiting.primary == nil)
    #expect(waiting.status == "Finish in your browser.")
    _ = f.receive(link(.connected), at: t0)
    let done = ConnectCopy(flow: f, returnsToConfirm: true)
    #expect(done.status == "Gmail connected")
    #expect(done.primary == "Back to review")
    #expect(ConnectCopy(flow: f, returnsToConfirm: false).primary == "Done")
    for s in intro.allStrings + waiting.allStrings + done.allStrings { #expect(S10EFixture.plain(s), "\(s)") }
  }

  @Test("route follows how the connector is reached: Composio toolkits say Composio")
  func route() {
    let sheets = Connector(id: "google-sheets", name: "Google Sheets", kind: .composio, connected: false)
    #expect(ConnectCopy(flow: ConnectFlow(connector: sheets), returnsToConfirm: false).route == "Connects through Composio")
    let mcp = Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: false)
    #expect(ConnectCopy(flow: ConnectFlow(connector: mcp), returnsToConfirm: false).route == "Signs in with Google on this Mac")
  }

  @Test("a signed-out connector says Sign in")
  func signIn() {
    let h = Connector(id: "hubspot", name: "HubSpot", kind: .composio, connected: false, missingEnv: true)
    let c = ConnectCopy(flow: ConnectFlow(connector: h), returnsToConfirm: false)
    #expect(c.title == "Sign in to HubSpot" && c.primary == "Sign in to HubSpot")
  }

  @Test("the wire DTO decodes the brain's ConnectLinkDTO")
  func wire() throws {
    let json = """
    {"connectorId":"gmail","name":"Gmail","via":"composio","state":"waiting","url":"https://connect.composio.dev/link/abc",
     "simulated":false,"message":"Finish signing in to Gmail in your browser.","startedAt":1792500000000,"connectedAt":null,"model":"real"}
    """
    let l = try BrainJSON.decoder.decode(ConnectLinkDTO.self, from: Data(json.utf8)).toLink()
    #expect(l.state == .waiting && l.via == .composio && l.url?.host == "connect.composio.dev" && !l.simulated)
    #expect(l.startedAt == Date(timeIntervalSince1970: 1_792_500_000))
    let mcp = try BrainJSON.decoder.decode(ConnectLinkDTO.self, from: Data(#"{"connectorId":"gmail","name":"Gmail","via":"gmail-mcp","state":"connected","url":null,"simulated":true,"message":"Gmail is connected.","startedAt":null,"connectedAt":1792500002000}"#.utf8)).toLink()
    #expect(mcp.via == .gmailMCP && mcp.state == .connected && mcp.simulated)
  }

  @Test("the mock brain simulates the link deterministically and then reports the connector connected")
  func mockLink() async throws {
    let mock = MockBrainClient()
    MockLinks.reset()
    MockLinks.delay = 0
    let start = try await mock.startLink(connectorId: "gsheets")
    #expect(start.state == .waiting && start.simulated && start.url == nil)
    let after = try await mock.linkStatus(connectorId: "gsheets")
    #expect(after.state == .connected)
    #expect(try await mock.connectorStates()["gsheets"] == .connected)
    MockLinks.reset()
    #expect(try await mock.connectorStates()["gsheets"] == .missing)
  }

  @Test("connecting the confirm sheet's missing connector makes Turn on possible; the plan's gate is unchanged")
  func confirmUnblocks() {
    var w = MockBrainClient.outreachWorkflow
    let before = FirstRunPlan(workflow: w)
    #expect(!before.canTurnOn && before.missing.map(\.id) == ["gsheets"])
    w.connectors = w.connectors.map { $0.applying(["gsheets": .connected]) }
    let after = FirstRunPlan(workflow: w)
    #expect(after.canTurnOn && after.gated == before.gated && after.sendCount == before.sendCount)
  }
}

// MARK: M2 diff, M3 voice

@Suite("S10E dry run and voice")
struct S10EVoiceTests {
  @Test("changed phrases are counted per draft; identical text says Same")
  func changedPhrases() {
    let item = MockBrainClient.outreachDryRun.items[0]
    let n = DiffSummary.changedPhrases(ours: item.ourDraft, theirs: item.whatYouSent)
    #expect(n > 0)
    #expect(DiffSummary.label(n) == "Changed \(n) phrase\(n == 1 ? "" : "s")")
    #expect(DiffSummary.changedPhrases(ours: item.whatYouSent, theirs: item.whatYouSent) == 0)
    #expect(DiffSummary.label(0) == "Same as what you sent")
  }

  @Test("the diff note talks about a highlight, never an underline")
  func diffNote() {
    let c = ReviewCopy(workflow: MockBrainClient.outreachWorkflow, dryRun: MockBrainClient.outreachDryRun)
    #expect(c.diffNote.contains("Highlighted"))
    #expect(!c.diffNote.lowercased().contains("underline"))
  }

  @Test("the highlight is a tint: white 12% on dark, black 8% on light")
  func tint() {
    #expect(DiffTint.dark == 0.12 && DiffTint.light == 0.08)
  }

  let measured = ToneMeasured(emails: 40, medianWords: 62, p90Words: 80, medianSentences: 5,
                              greeting: .init(form: "Hi {first},", count: 40), sign: .init(form: "Muhammad", count: 40),
                              askShare: 0.95, exclamationShare: 0, sample: "Saw Halden led Tessellate's seed.",
                              source: "40 sent investor emails")

  @Test("voice facts: four measured rows, each sourced, and one quoted line")
  func voiceFacts() {
    let v = VoiceFacts(measured)
    #expect(v.rows.map(\.label) == ["Length", "Greeting", "Sign-off", "Ask"])
    #expect(v.rows.allSatisfy { $0.source == "from 40 sent emails" })
    #expect(v.rows[0].value.contains("62 words") && v.rows[0].value.contains("80"))
    #expect(v.rows[1].value.contains("Hi") && v.rows[1].value.contains("40 of 40"))
    #expect(v.rows[2].value.contains("Muhammad"))
    #expect(v.rows[3].value.contains("38 of 40") && v.rows[3].value.contains("no exclamation marks"))
    #expect(v.quote == "“Saw Halden led Tessellate's seed.”")
    #expect(v.header == "Measured from 40 sent investor emails")
    for s in v.allStrings { #expect(S10EFixture.plain(s), "\(s)") }
  }

  @Test("the tone wire carries measured, and an older brain without it still decodes")
  func toneWire() throws {
    let with = #"{"workflowId":"wf","bucket":"investor_outreach","text":"Short.","edited":false,"path":"/t","updatedAt":null,"maxBytes":16384,"measured":{"emails":40,"medianWords":62,"p90Words":80,"medianSentences":5,"greeting":{"form":"Hi {first},","count":40},"sign":{"form":"Muhammad","count":40},"askShare":0.95,"exclamationShare":0,"sample":"Saw Halden led Tessellate's seed.","source":"40 sent investor emails"}}"#
    let t = try BrainJSON.decoder.decode(ToneCard.self, from: Data(with.utf8))
    #expect(t.measured == measured)
    let old = #"{"workflowId":"wf","bucket":"investor_outreach","text":null,"edited":false,"path":"/t","updatedAt":null,"maxBytes":16384}"#
    #expect(try BrainJSON.decoder.decode(ToneCard.self, from: Data(old.utf8)).measured == nil)
  }

  @Test("the mock tone card is measured, so snapshots show the fact sheet")
  func mockTone() async throws {
    let t = try await MockBrainClient().toneCard(workflowId: "wf_outreach")
    #expect(t.measured?.emails == 40)
  }
}

// MARK: M6 timeline

@Suite("S10E timeline proves the card")
struct S10ETimelineTests {
  private let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()

  private func bar(_ id: String, _ task: String, _ h0: Int, _ m0: Int, _ h1: Int, _ m1: Int, auto: Bool = false,
                   active: Double? = nil) -> TimelineBar {
    let d = { (h: Int, m: Int) in self.cal.date(from: DateComponents(year: 2026, month: 10, day: 20, hour: h, minute: m))! }
    var b = TimelineBar(id: id, taskId: task, start: d(h0, m0), end: d(h1, m1), automated: auto, title: "", counterparty: nil)
    b.activeMinutes = active
    return b
  }

  private func minutes(_ bars: [TimelineBar]) -> [String: Double] { TimelinePack.minutesByClass(bars, focus: "t1") }

  @Test("packing preserves every class's minutes exactly")
  func preserves() {
    let bars = [bar("a", "t1", 9, 0, 9, 3), bar("b", "x", 9, 3, 9, 4), bar("c", "t1", 9, 4, 9, 7), bar("d", "y", 9, 7, 9, 9),
                bar("e", "t1", 9, 9, 9, 12), bar("f", "t1", 9, 30, 9, 33, auto: true), bar("g", "x", 11, 0, 11, 40)]
    let out = TimelinePack.display(bars, focus: "t1")
    let a = minutes(bars), b = minutes(out)
    for k in Set(a.keys).union(b.keys) { #expect(abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-9, "\(k)") }
    // The three outreach spans with slivers between them become one block; the slivers follow it.
    #expect(out.first?.taskId == "t1" && abs(out.first!.drawnMinutes - 9) < 1e-9)
    #expect(out.count < bars.count)
  }

  @Test("a bar's drawn length is its active minutes, not its wall-clock span")
  func activeMinutes() {
    let b = bar("a", "t1", 9, 0, 9, 10, active: 4)
    #expect(abs(TimelinePack.display([b], focus: "t1")[0].drawnMinutes - 4) < 1e-9)
  }

  @Test("Offload's runs never merge with by-hand work")
  func runsStay() {
    let out = TimelinePack.display([bar("a", "t1", 9, 0, 9, 20), bar("b", "t1", 9, 21, 9, 37, auto: true), bar("c", "t1", 9, 38, 10, 0)], focus: "t1")
    #expect(out.filter(\.automated).count == 1)
  }

  @Test("the card's week: by-hand outreach bars over tracked time is the card's share, within 2 points")
  func mockShare() {
    let i = SampleWeek.outreach
    let s = WeekShare(days: MockBrainClient.beforeDays, tasks: MockBrainClient.timelineTasks)
    #expect(abs(s.share - i.timeShare) * 100 <= 2)
    #expect(Figures.hours(s.byHandMinutes / 60) == "24.6 h")
    #expect(Figures.hours(s.trackedMinutes / 60) == "38.2 h")
    #expect(s.header == "Investor outreach by hand 24.6 h · 64%")
    #expect(CardCopy(i).title == "Investor outreach emails take 64% of your week")
    // Drawn (packed) bars carry the same minutes.
    let drawn = WeekShare(days: MockBrainClient.beforeDays.map { var d = $0; d.bars = TimelinePack.display(d.bars, focus: "t_outreach"); return d },
                          tasks: MockBrainClient.timelineTasks)
    #expect(abs(drawn.byHandMinutes - s.byHandMinutes) < 1e-9)
  }

  @Test("the card's week has no Offload runs, and nothing in it is automated")
  func beforeIsByHand() {
    let anyRun = MockBrainClient.beforeDays.flatMap(\.bars).contains { $0.automated }
    #expect(!anyRun)
    #expect(MockBrainClient.beforeDays.count == 7)
    #expect(MockBrainClient.sampleEvidence["ins_outreach"]!.allSatisfy { s in
      MockBrainClient.beforeDays.contains { Calendar.current.isDate($0.date, inSameDayAs: s.start) } })
  }

  @Test("this week: measured hours are the before rate minus the full days after turning it on, and tie the hero")
  func measuredTies() throws {
    let d = MockBrainClient.sampleDashboard
    let a = try #require(d.automations.first { $0.state == .active })
    let on = try #require(a.activatedAt)
    let proof = try #require(MeasuredProof(before: d.beforeDays, after: d.days, focus: a.taskId!, activatedAt: on,
                                            now: MockBrainClient.reviewNow))
    #expect(Figures.hours(proof.beforeHoursPerWeek) == "24.6 h")
    #expect(Figures.hours(proof.afterHoursPerWeek) == "7.8 h")
    #expect(Figures.hours(proof.savedHoursPerWeek) == Figures.hours(d.hours.measured!))
    #expect(Figures.hours(a.measuredHoursPerWeek!) == "16.8 h")
    #expect(proof.line.contains("16.8 h") && proof.line.contains("24.6 h"))
    #expect(S10EFixture.plain(proof.line))
  }

  @Test("no automation runs for an insight the inbox still offers")
  func noRunningForUnbuilt() {
    let built = Set(MockBrainClient.sampleDashboard.automations.filter { $0.state == .active }.map(\.insightId))
    // The card's world is the week before: in it no automation is on; in this week's world the outreach card is gone.
    #expect(SampleWeek.afterInsights.allSatisfy { !built.contains($0.id) })
    #expect(SampleWeek.insights.first?.id == "ins_outreach")
  }

  @Test("the live composer on the real brain's week: by-hand bars tie the brain's share within 2 points")
  func liveShare() throws {
    let ins = try BrainJSON.decoder.decode(InsightsResponse.self, from: S10EFixture.data("insights.json"))
    let top = try #require(ins.insights.first)
    let st = try BrainJSON.decoder.decode(StatusResponse.self, from: S10EFixture.data("status.json"))
    let dash = try BrainJSON.decoder.decode(DashboardResponse.self, from: S10EFixture.data("dashboard.json"))
    let days = DashboardComposer.timelineDays(st)
    let tls = try days.map { try BrainJSON.decoder.decode(TimelineResponse.self, from: S10EFixture.data("timeline-\($0).json")) }
    #expect(tls.count == 7)
    let d = DashboardComposer.compose(dashboard: dash, status: st, workflows: [], connectors: [:], timelines: tls, permissions: [])
    let s = WeekShare(days: d.days.map { var x = $0; x.bars = TimelinePack.display(x.bars, focus: d.tasks.first { $0.tint == 0 }?.id); return x },
                      tasks: d.tasks)
    #expect(abs(s.share - top.figures.share.value) * 100 <= 2, "bars \(s.share) vs brain \(top.figures.share.value)")
  }

  @Test("week switch: W toggles between the week before Offload and this week, only when both exist")
  func weekSwitch() {
    #expect(DashboardKey(characters: "w", keyCode: 13, command: false) == .week)
    #expect(TimelineWeek.available(MockBrainClient.sampleDashboard) == [.before, .this])
    var live = MockBrainClient.sampleDashboard
    live.beforeDays = []
    #expect(TimelineWeek.available(live) == [.this])
  }

  @Test("the evidence pointer lands on a drawn bar of the card's week")
  func evidence() throws {
    let d = MockBrainClient.sampleDashboard
    let b = try #require(d.evidenceBar)
    let drawn = d.beforeDays.flatMap { TimelinePack.display($0.bars, focus: "t_outreach") }
    #expect(drawn.contains { $0.id == b.id })
  }
}

// MARK: M7 colour

@Suite("S10E one state colour map")
struct S10EColourTests {
  @Test("rail dots and dashboard rows give every workflow state the same colour")
  func sameEverywhere() {
    for s in WorkflowState.allCases {
      var a = MockBrainClient.dashboardAutomations[0]
      a.state = s
      #expect(StatusRole.forAutomation(a.railAutomation.status) == StatusRole.forWorkflow(s), "\(s)")
    }
  }

  @Test("on and healthy is green, paused grey, needs you amber, in flight blue")
  func meanings() {
    #expect(StatusRole.forWorkflow(.active) == .done)
    #expect(StatusRole.forWorkflow(.paused) == .neutral)
    #expect(StatusRole.forWorkflow(.needsYou) == .needsYou)
    #expect(StatusRole.forWorkflow(.drafting) == .working)
    #expect(StatusRole.forAutomation(.running) == .done)
    #expect(StatusRole.forObserver(.watching) == .working)
    #expect(StatusRole.forObserver(.paused) == .neutral)
  }

  @Test("paused shows ▶ and grey; not recording shows ↻ and amber; watching shows pause")
  func observerTools() {
    func rail(_ s: ObserverState) -> RailModel {
      RailModel(status: ObserverStatus(state: s, daysStored: 7, windowDays: 7, nextPurge: nil, insightsWaiting: 0), automations: [], micRecording: false)
    }
    #expect(rail(.paused).observerTool.symbol == "play.fill" && rail(.paused).dots[0].role == .neutral)
    #expect(rail(.stale).observerTool.symbol == "arrow.clockwise" && rail(.stale).dots[0].role == .needsYou)
    #expect(rail(.stale).observerTool.label == "Start watching again")
    #expect(rail(.watching).observerTool.symbol == "pause.fill")
  }

  @Test("the inbox badge is amber and its count is the inbox's; the hover card names it")
  func badge() {
    let r = SampleWeek.rail
    #expect(r.inboxBadgeRole == .needsYou)
    #expect(r.inboxBadge == "\(SampleWeek.insights.count)")
    #expect(r.hoverLines.last?.text == "\(SampleWeek.insights.count) suggestions in your inbox")
    let one = RailModel(status: ObserverStatus(state: .watching, daysStored: 7, windowDays: 7, nextPurge: nil, insightsWaiting: 1),
                        automations: [], micRecording: false)
    #expect(one.hoverLines.last?.text == "1 suggestion in your inbox")
  }

  @Test("the hover card says an active automation is on, not running")
  func hoverOn() {
    #expect(SampleWeek.rail.hoverLines.contains { $0.text == "Investor outreach emails · on" })
  }
}

// MARK: M8 primary

@Suite("S10E one primary per view")
struct S10EPrimaryTests {
  @Test("review footer: a blocked step makes Connect the primary and Approve secondary")
  func reviewFooter() {
    let w = MockBrainClient.outreachWorkflow
    #expect(ReviewPrimary.forWorkflow(w) == .connect(MockBrainClient.sheets))
    #expect(ReviewPrimary.forWorkflow(w).title == "Connect Google Sheets")
    var ready = w
    ready.connectors = ready.connectors.map { $0.applying(["gsheets": .connected]) }
    #expect(ReviewPrimary.forWorkflow(ready) == .approve)
  }

  @Test("onboarding: while Screen Recording is missing, Open Settings is the primary")
  func onboarding() {
    var f = OnboardingFlow()
    f.next()
    _ = f.update(PermissionKind.allCases.map { PermissionState($0, granted: false) })
    _ = f.update(PermissionKind.allCases.map { PermissionState($0, granted: false) })
    #expect(f.primary == .openSettings(.screenRecording))
    #expect(f.permissionsNote.contains("until you turn them on"))
    _ = f.update([PermissionState(.screenRecording, granted: true), PermissionState(.accessibility, granted: false),
                  PermissionState(.inputMonitoring, granted: false)])
    #expect(f.primary == .next)
  }

  @Test("dashboard overview: the first needs-you action is the one primary")
  func overview() {
    let d = MockBrainClient.sampleDashboard
    #expect(DashboardPrimary.overview(d) == .needsYou("auto_crm"))
    var calm = d
    calm.automations = calm.automations.filter { $0.state == .active }
    calm.observing.permissions = [PermissionState(.screenRecording, granted: false)]
    #expect(DashboardPrimary.overview(calm) == .permission(.screenRecording))
    calm.observing.permissions = [PermissionState(.screenRecording, granted: true)]
    #expect(DashboardPrimary.overview(calm) == nil)
  }

  @Test("observing: the first missing required permission is the primary; optional ones are quiet")
  func observing() {
    let rows = [PermissionState(.screenRecording, granted: false), PermissionState(.accessibility, granted: false),
                PermissionState(.inputMonitoring, granted: false)]
    #expect(DashboardPrimary.observing(rows) == .screenRecording)
    #expect(PermissionButtonStyle.forRow(rows[0], primary: .screenRecording) == .primary)
    #expect(PermissionButtonStyle.forRow(rows[1], primary: .screenRecording) == .secondary)
    #expect(PermissionButtonStyle.forRow(rows[2], primary: .screenRecording) == .quiet)
  }

  @Test("the observer row does not repeat a permission's Open Settings")
  func noDuplicate() {
    let rows = [PermissionState(.screenRecording, granted: false)]
    #expect(ObserverAction.forState(.stale, permissions: rows).duplicatesPermission)
    #expect(!ObserverAction.forState(.watching, permissions: rows).duplicatesPermission)
  }
}

// MARK: polish

@Suite("S10E polish")
struct S10EPolishTests {
  @Test("evidence rows show each email's measured time, and the footer says what the other session was")
  func evidence() {
    let e = EvidenceCopy(spans: MockBrainClient.sampleEvidence["ins_outreach"]!, insight: SampleWeek.outreach)
    #expect(Set(e.rows.map(\.duration)).count > 1)
    #expect(e.rows[0].duration == "3 min 12 s")
    #expect(e.elsewhere == "Plus 1 session in Numbers that was part of this task")
  }

  @Test("a row that never ran says could save, not saved")
  func couldSave() {
    let c = DashboardCopy(MockBrainClient.sampleDashboard, now: MockBrainClient.reviewNow)
    #expect(c.rows.first { $0.id == "auto_scheduling" }?.savedQualifier == "could save")
    #expect(c.rows.first { $0.id == "auto_outreach" }?.savedQualifier == "measured")
  }

  @Test("an empty inbox on the last day of the week says the week is done")
  func emptyInbox() {
    #expect(InboxEmptyCopy.message(daysStored: 7, windowDays: 7) == "Week 1 done. Nothing repeated enough yet.\nStill watching.")
    #expect(InboxEmptyCopy.message(daysStored: 3, windowDays: 7).hasPrefix("Still watching."))
  }

  @Test("kept-files copy is under 60 characters")
  func keptCopy() {
    #expect(KeptFileCopy.footnote.count < 60)
  }

  @Test("light Recommended ink reaches 4.5:1 on its tint over the light option row")
  func recommendedContrast() {
    let row = RGB(hex: 0xF4F4F6).over(.white, alpha: 0.7)
    let tag = row.over(RGB(hex: 0xE29A00), alpha: 0.15)
    #expect(RGB.contrast(RGB(hex: 0x6E4500), tag) >= 4.5)
  }

  @Test("sheet scrim leaves the window readable at about a quarter, and the sheet rises 7 pt in 200 ms")
  func scrim() {
    #expect(Tokens.Window.scrimDark >= 0.6 && Tokens.Window.scrimLight >= 0.35)
    #expect(MotionPlan.arrive(reduceMotion: false).offsetY == 7 && MotionPlan.arrive(reduceMotion: false).duration == 0.2)
  }

  @Test("Automations with no rows has its own empty state copy and one action")
  func automationsEmpty() {
    #expect(AutomationsEmptyCopy.title == "No automations yet.")
    #expect(AutomationsEmptyCopy.message.contains("Approve a workflow from the inbox"))
    #expect(AutomationsEmptyCopy.action == "Open the inbox")
  }
}

// MARK: generic connect (operator scope: any tool, any domain)

@Suite("S10E connect methods")
struct S10EConnectMethodTests {
  let t0 = S10EFixture.t0
  let tool = Connector(id: "notion", name: "Notion", kind: .composio, connected: false)

  private func link(_ state: ConnectLinkState, method: ConnectMethod, next: ConnectMethod?, detail: String = "") -> ConnectLink {
    ConnectLink(connectorId: "notion", name: "Notion", via: method == .mcp ? .gmailMCP : .composio, state: state, url: nil,
                simulated: true, message: "", startedAt: t0, connectedAt: nil, method: method, methods: [.mcp, .composio],
                next: next, detail: detail)
  }

  @Test("a failed method offers the next one, and the primary tries it")
  func fallback() {
    var f = ConnectFlow(connector: tool)
    _ = f.connect(at: t0)
    _ = f.receive(link(.failed, method: .mcp, next: .composio, detail: "The connector on this Mac did not answer."), at: t0)
    let c = ConnectCopy(flow: f, returnsToConfirm: false)
    #expect(c.primary == "Use Composio instead")
    #expect(c.status == "The connector on this Mac did not answer.")
    #expect(f.tryNext(at: t0) == [.startLink])
    #expect(f.method == .composio)
    #expect(ConnectCopy(flow: f, returnsToConfirm: false).route == "Through Composio")
  }

  @Test("every method has a plain route line and a try title, with no internal words")
  func plain() {
    for m in ConnectMethod.allCases {
      #expect(S10EFixture.plain(m.route) && S10EFixture.plain(m.tryTitle), "\(m)")
    }
    #expect(ConnectMethod.allCases.map(\.rawValue) == ["mcp", "composio", "api", "computer"])
  }

  @Test("the wire carries method, methods, next and detail; an older brain without them still decodes")
  func wire() throws {
    let j = #"{"connectorId":"notion","name":"Notion","via":"composio","state":"failed","url":null,"simulated":true,"message":"","startedAt":null,"connectedAt":null,"method":"mcp","methods":["mcp","composio","api","computer"],"next":"composio","detail":"The connector on this Mac did not answer."}"#
    let l = try BrainJSON.decoder.decode(ConnectLinkDTO.self, from: Data(j.utf8)).toLink()
    #expect(l.method == .mcp && l.next == .composio && l.methods.count == 4)
    let old = #"{"connectorId":"gmail","name":"Gmail","via":"gmail-mcp","state":"waiting","url":null,"simulated":true,"message":"x","startedAt":null,"connectedAt":null}"#
    let o = try BrainJSON.decoder.decode(ConnectLinkDTO.self, from: Data(old.utf8)).toLink()
    #expect(o.method == .mcp && o.next == nil)
  }

  @Test("a connector for any tool gets a purpose line that is not about email")
  func anyTool() {
    let c = ConnectCopy(flow: ConnectFlow(connector: tool), returnsToConfirm: false)
    #expect(c.title == "Connect Notion")
    #expect(!c.purpose.lowercased().contains("mail"))
  }
}
