import Foundation
import Testing

// S10F: UI round 5 after DESIGN-REVIEW-4. Written before the code (slices/s10f-ui-round5/SPEC.md): the tool picker's
// states (M2), the sample dry run and its sentence diff (M3), the Connections center (M4), the confirm header (M5),
// the general dry run's unknown fields (M6), the compact primary (M8), the review-3 leftovers and the MCP run confirm.

enum S10FFixture {
  static let banned = try! NSRegularExpression(pattern: "\\b(key|keys|token|MCP|SKILL|gate|json|env)\\b", options: [.caseInsensitive])
  static func plain(_ s: String) -> Bool { banned.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) == nil }
}

// MARK: M1

@Suite("S10F onboarding privacy sentence")
struct S10FOnboardingTests {
  @Test("step 1's privacy sentence is the review's wording and parses")
  func sentence() {
    #expect(OnboardingFlow.localNote == "Everything stays on this Mac, encrypted. If you turn on Claude, only masked text and masked screenshots go to your Claude account, to read and draft. Nothing else leaves this Mac.")
    #expect(!OnboardingFlow.localNote.contains("With a Claude account set up"))
  }
}

// MARK: M2

@Suite("S10F tool picker states")
struct S10FToolTests {
  let send = MockBrainClient.outreachTools[0]
  let log = MockBrainClient.outreachTools[1]

  @Test("In use only on the tool that runs today; the chosen, unconnected tool says Chosen, connect to use")
  func sendStep() {
    let c = ToolsCopy(send, connectors: [MockBrainClient.gmail])
    let byName = Dictionary(uniqueKeysWithValues: c.options.map { ($0.name, $0.mark) })
    #expect(byName["Gmail"] == .inUse)
    #expect(byName["Instantly"] == .chosenNeedsConnect)
    #expect(c.options.filter { $0.mark == .inUse }.count == 1)
    #expect(ToolsCopy.chosenNeedsConnect == "Chosen, connect to use")
  }

  @Test("a chosen tool that runs but is not connected is not In use")
  func logStep() {
    let c = ToolsCopy(log)
    #expect(c.options.allSatisfy { $0.mark != .inUse })
    #expect(c.options.first { $0.name == "Google Sheets" }?.mark == .chosenNeedsConnect)
    #expect(c.options.first { $0.name == "Attio" }?.mark == ToolsCopy.Mark.none)
  }

  @Test("a chosen, connected tool that runs is In use, and nothing else is marked")
  func connectedChosen() {
    var t = send
    t.chosen = "gmail"
    let c = ToolsCopy(t)
    #expect(c.options.map(\.mark) == [ToolsCopy.Mark.none, .inUse])
    #expect(c.runsWithLine == nil)
  }

  @Test("the recommendation line is the reason only, never the card body or setup jargon")
  func recommended() {
    let c = ToolsCopy(send)
    #expect(c.recommended == "Recommended: built for sending 100+ a day")
    let instantly = c.options.first { $0.name == "Instantly" }!
    #expect(c.recommended != instantly.why && !instantly.why.hasPrefix(c.recommended))
    for s in [c.recommended, ToolsCopy(log).recommended] {
      #expect(!s.contains("MCP") && !s.contains("Composio") && !s.lowercased().contains(" via "))
    }
    #expect(ToolsCopy(log).recommended == "Recommended: your pipeline sheet as it is today")
  }

  @Test("keyboard focus is a white ring at 40%, 2 pt, not a state colour")
  func focusRing() {
    #expect(FocusRing.opacity == 0.4 && FocusRing.width == 2)
  }
}

// MARK: M3

@Suite("S10F sample dry run")
struct S10FSampleTests {
  var sampleRun: DryRun {
    var d = MockBrainClient.outreachDryRun
    d.model = "stub"
    return d
  }

  @Test("a sample run labels every card and makes Run with my voice the primary, before Connect")
  func primary() {
    let w = MockBrainClient.outreachWorkflow
    #expect(ReviewPrimary.forWorkflow(w, sample: true) == .runWithVoice)
    #expect(ReviewPrimary.runWithVoice.title == "Run with my voice")
    if case .connect = ReviewPrimary.forWorkflow(w) {} else { Issue.record("not sample: connect stays the primary") }
    let copy = ReviewCopy(workflow: w, dryRun: sampleRun)
    #expect(copy.sampleCardHeader == "Sample, not your voice")
    #expect(ReviewCopy(workflow: w, dryRun: MockBrainClient.outreachDryRun).sampleCardHeader == nil)
  }

  @Test("a rerun that is still a sample says why")
  func stillSample() {
    #expect(ReviewCopy.stillSample.contains("sample model"))
    #expect(S10FFixture.plain(ReviewCopy.stillSample))
  }
}

@Suite("S10F sentence diff")
struct S10FSentenceDiffTests {
  let ours = "Hi Sven,\n\nI'm Muhammad, founder of Offload. Offload watches a week of your work and automates the parts that repeat. Bessemer backs tools teams use every day, so I'm writing to you first.\n\nWe are raising a $2.5M seed. Traction: 40 design partners, 3 paying.\n\nMuhammad"
  let theirs = "Hi Sven,\n\nI'm Muhammad, founder of Offload. Offload watches a week of your work and automates the parts that repeat. Your investment in Toast is why I'm writing.\n\nWe are raising a $2.5M seed. Traction: 40 design partners, 3 paying.\n\nBest,\nOffload | offload.so"

  @Test("one reworded sentence counts once; the sign-off is compared on its own")
  func counts() {
    let s = SentenceDiff.summary(ours: ours, theirs: theirs)
    #expect(s.changed == 1)
    #expect(s.total == 6)
    #expect(s.signOffDiffers)
    #expect(s.label == "Changed 1 of 6 sentences · sign-off differs")
  }

  @Test("identical text is the same; a sign-off-only change says only that")
  func same() {
    #expect(SentenceDiff.summary(ours: theirs, theirs: theirs).label == "Same as what you sent")
    let other = theirs.replacingOccurrences(of: "Best,\nOffload | offload.so", with: "Muhammad")
    let s = SentenceDiff.summary(ours: other, theirs: theirs)
    #expect(s.changed == 0 && s.signOffDiffers && s.label == "Sign-off differs")
  }

  @Test("the sign-off block is the trailing short lines, never a question or a sentence")
  func signOff() {
    #expect(SentenceDiff.signOff("Hi,\n\nWorth a call?\n\nBest,\nMuhammad") == ["Best,", "Muhammad"])
    #expect(SentenceDiff.signOff("Hi,\n\nSend any questions my way.") == [])
    #expect(SentenceDiff.signOff("Hi,\n\nWorth a call?\nMuhammad") == ["Muhammad"])
  }

  @Test("highlights are contiguous spans: one per changed sentence plus a differing sign-off")
  func spans() {
    let segs = SentenceDiff.spans(ours: ours, theirs: theirs)
    let changed = segs.filter(\.changed)
    #expect(changed.count == 2)
    #expect(changed[0].text.hasPrefix("Bessemer backs tools teams use every day"))
    #expect(changed[1].text == "Muhammad")
    #expect(segs.map(\.text).joined() == ours)
    // Same text: nothing is highlighted.
    #expect(SentenceDiff.spans(ours: theirs, theirs: theirs).allSatisfy { !$0.changed })
  }

  @Test("the outreach sample drafts each count a whole number of sentences")
  func samples() {
    for item in MockBrainClient.outreachDryRun.items {
      let s = SentenceDiff.summary(ours: item.ourDraft, theirs: item.whatYouSent)
      #expect(s.total >= s.changed && s.total > 0)
      #expect(s.label.hasPrefix("Changed ") || s.label == "Same as what you sent")
    }
  }
}

// MARK: M4

@Suite("S10F connections center")
struct S10FConnectionsTests {
  @Test("searching lin returns Linear only (no description substring matches)")
  func search() {
    #expect(MockConnections.page("lin").rows.map(\.id) == ["tk-linear"])
    #expect(MockConnections.page("").rows.count == MockConnections.rows.count)
  }

  @Test("a row found by one of its tools says which tool")
  func toolMatch() {
    let rows = MockConnections.page("invoice").rows
    #expect(rows.map(\.id) == ["tk-stripe"])
    #expect(ConnectionsMatch.line(rows[0], query: "invoice") == "Matches: Create invoice")
  }

  @Test("the match line: nothing for a name match; the tool; else what it does")
  func matchLine() {
    let linear = MockConnections.rows.first { $0.id == "tk-linear" }!
    #expect(ConnectionsMatch.line(linear, query: "lin") == nil)
    #expect(ConnectionsMatch.line(linear, query: "") == nil)
    #expect(ConnectionsMatch.line(linear, query: "planning") == "Matches what it does: Issue tracking and project planning for teams.")
  }

  @Test("every row gets a monogram tile, never a third-party logo")
  func monogram() {
    #expect(AppMark.monogram("Google Sheets") == "GS")
    #expect(AppMark.monogram("HubSpot") == "H")
    #expect(AppMark.monogram("linear") == "L")
    #expect(AppMark.monogram("") == "?")
    #expect(AppMark.tile == 32 && AppMark.radius == 12)
  }

  @Test("the dashboard sidebar links to Connections with ⌘K")
  func sidebar() {
    #expect(DashboardSidebarLink.connections.title == "Connections")
    #expect(DashboardSidebarLink.connections.shortcut == "⌘K")
    #expect(!DashboardSidebarLink.connections.symbol.isEmpty)
  }
}

// MARK: M5

@Suite("S10F confirm header")
struct S10FConfirmTests {
  @Test("the recipient header says the batch is held, never Send")
  func header() {
    let p = FirstRunPlan(workflow: MockBrainClient.outreachWorkflow)
    #expect(p.headline == "First batch: \(p.sendCount) recipients (drafted, then held for you)")
    #expect(!p.headline.contains("Send"))
    var w = MockBrainClient.outreachWorkflow
    w.steps = w.steps.filter { !$0.isGate }
    let auto = FirstRunPlan(workflow: w)
    #expect(auto.headline == "First batch: \(auto.sendCount) recipients")
  }
}

// MARK: M6

@Suite("S10F general dry run fields")
struct S10FGeneralTests {
  let c = GeneralDryRunCopy(MockBrainClient.billGeneral, ranAt: MockBrainClient.reviewNow)

  @Test("an unreadable field is unknown, not a miss, and leaves the denominator")
  func unknown() {
    let harbor = c.items[1]
    #expect(harbor.matchChip == "4 of 4 readable fields match")
    #expect(harbor.matchRole == .done)
    let due = harbor.theirs.rows.first { $0.label == "Due date" }!
    #expect(due.state == .unknown && !due.differs)
    #expect(harbor.ours.rows.first { $0.label == "Due date" }?.state == .unknown)
  }

  @Test("a differing field is marked on both sides")
  func differsBothSides() {
    let lumen = c.items[2]
    #expect(lumen.ours.rows.first { $0.label == "Total" }?.state == .differs)
    #expect(lumen.theirs.rows.first { $0.label == "Total" }?.state == .differs)
    #expect(lumen.ours.rows.filter { $0.state == .differs }.count == 1)
    #expect(lumen.matchChip == "5 of 6 match" && lumen.matchRole == .needsYou)
  }

  @Test("the footer is recomputed over readable fields")
  func totals() {
    #expect(c.totals == "14 of 15 readable fields the same across 3 bills = 93%")
    #expect(c.items[0].matchChip == "5 of 5 match")
  }
}

// MARK: M8

@Suite("S10F compact primary")
struct S10FCompactTests {
  @Test("below 720 pt the primary says the short name and never truncates")
  func compact() {
    #expect(ReviewPrimary.compactBelow == 720)
    #expect(ReviewPrimary.connect(MockBrainClient.sheets).title(compact: true) == "Connect Sheets")
    #expect(ReviewPrimary.connect(MockBrainClient.sheets).title(compact: false) == "Connect Google Sheets")
    #expect(ReviewPrimary.connect(MockBrainClient.hubspot).title(compact: true) == "Sign in to HubSpot")
    #expect(ReviewPrimary.runWithVoice.title(compact: true) == "Run with my voice")
    #expect(ReviewPrimary.approve.title(compact: true) == "Approve")
    for p in [ReviewPrimary.connect(MockBrainClient.sheets), .runWithVoice, .approve] {
      #expect(p.title(compact: true).count <= 18)
    }
  }
}

// MARK: P9

@Suite("S10F pointer label below the row")
struct S10FPointerTests {
  @Test("a row target puts the label under the row, inside the bounds, off the row")
  func belowRow() {
    let bounds = CGRect(x: 0, y: 0, width: 900, height: 600)
    let row = CGRect(x: 40, y: 100, width: 820, height: 80)
    let target = CGRect(x: 60, y: 110, width: 200, height: 20)
    let p = PointerLabelPlacement.place(label: CGSize(width: 240, height: 28), tip: CGPoint(x: 70, y: 125),
                                        arrow: CGSize(width: 18, height: 18), target: target, obstacles: [],
                                        bounds: bounds, row: row)
    #expect(p.rect.minY >= row.maxY)
    #expect(bounds.insetBy(dx: PointerLabelPlacement.inset, dy: PointerLabelPlacement.inset).contains(p.rect))
    #expect(!p.rect.intersects(row))
    #expect(p.side == .below)
  }

  @Test("no room below: above the row, still off it")
  func aboveRow() {
    let bounds = CGRect(x: 0, y: 0, width: 900, height: 200)
    let row = CGRect(x: 40, y: 110, width: 820, height: 80)
    let p = PointerLabelPlacement.place(label: CGSize(width: 240, height: 28), tip: CGPoint(x: 70, y: 125),
                                        arrow: CGSize(width: 18, height: 18), target: CGRect(x: 60, y: 120, width: 200, height: 20),
                                        obstacles: [], bounds: bounds, row: row)
    #expect(!p.rect.intersects(row) && p.side == .above)
  }
}

// MARK: MCP run confirm

@Suite("S10F connector server run confirm")
struct S10FServerConfirmTests {
  func linear() -> ConnectionSheetFlow {
    var f = ConnectionSheetFlow(detail: MockConnections.detail("tk-linear")!)
    f.chooseNumber(3)
    _ = f.primary()
    return f
  }

  @Test("a package runner downloads and runs code; the exact command is shown")
  func copy() {
    let c = ServerRunConfirm(command: "npx", args: ["-y", "@linear/mcp-server"])
    #expect(c.downloads)
    #expect(c.title == "This will download and run code on this Mac")
    #expect(c.commandLine == "npx -y @linear/mcp-server")
    #expect(c.runTitle == "Download and run")
    for cmd in ["uvx", "bunx", "docker", "pipx"] { #expect(ServerRunConfirm(command: cmd, args: []).downloads) }
    let local = ServerRunConfirm(command: "node", args: ["server.js"])
    #expect(!local.downloads && local.title == "This will run code on this Mac" && local.runTitle == "Run it")
    #expect(S10FFixture.plain(c.body) && S10FFixture.plain(local.body))
  }

  @Test("a command stops at the confirm; ↩ there cancels; only confirmRun starts the server")
  func flow() {
    var f = linear()
    f.serverText = "npx -y @linear/mcp-server"
    #expect(f.primary() == [])
    guard case .confirmRun(let c) = f.phase else { Issue.record("no confirm phase: \(f.phase)"); return }
    #expect(c.commandLine == "npx -y @linear/mcp-server")
    #expect(f.primaryTitle == "Cancel")
    #expect(f.primary() == [])
    #expect(f.phase == .enterServer)
    _ = f.primary()
    #expect(f.confirmRun() == [.addServer(.serverCommand("npx", args: ["-y", "@linear/mcp-server"]))])
    if case .working = f.phase {} else { Issue.record("not working after confirm") }
  }

  @Test("esc on the confirm goes back to the field, nothing runs")
  func escape() {
    var f = linear()
    f.serverText = "uvx mcp-server-linear"
    _ = f.primary()
    #expect(f.back() == [])
    #expect(f.phase == .enterServer)
  }

  @Test("an https server needs no confirm")
  func https() {
    var f = linear()
    f.serverText = "https://mcp.linear.app/mcp"
    #expect(f.primary() == [.addServer(.serverURL("https://mcp.linear.app/mcp"))])
  }

  @Test("confirmRun outside the confirm does nothing")
  func guarded() {
    var f = linear()
    #expect(f.confirmRun() == [])
  }
}

// MARK: PR #13 review fix round

@Suite("S10F review fixes")
struct S10FReviewFixTests {
  /// The live case: the brain's tool plan was made before Gmail was connected, so its option says connected: false.
  var stalePlan: StepTools {
    var t = MockBrainClient.outreachTools[0]
    t.options = t.options.map { var o = $0; if o.id == "gmail" { o.connected = false }; return o }
    return t
  }

  @Test("connected and In use come from the live connector state, not the stale plan")
  func liveConnectors() {
    let before = ToolsCopy(stalePlan, connectors: [Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: false)])
    #expect(before.options.allSatisfy { $0.mark != .inUse })
    let after = ToolsCopy(stalePlan, connectors: [MockBrainClient.gmail])
    #expect(after.options.filter { $0.mark == .inUse }.map(\.name) == ["Gmail"])
    #expect(after.options.first { $0.name == "Gmail" }?.connected == true)
  }

  @Test("Gmail connected mid-flow: the review shows exactly one In use on the send step")
  func midFlow() {
    var w = MockBrainClient.outreachToolsWorkflow
    w.tools[0] = stalePlan
    w.connectors = w.connectors.map { var c = $0; if c.id == "gmail" { c.connected = false }; return c }
    var flow = ApprovalFlow(workflow: w)
    #expect(ReviewCopy(workflow: flow.workflow, dryRun: nil).tools["s6"]!.options.filter { $0.mark == .inUse }.isEmpty)
    flow.updateConnectors([:], connected: MockBrainClient.gmail)
    let send = ReviewCopy(workflow: flow.workflow, dryRun: nil).tools["s6"]!
    #expect(send.options.filter { $0.mark == .inUse }.count == 1)
    #expect(send.options.first { $0.mark == .inUse }?.name == "Gmail")
  }

  @Test("a sentence you wrote that the draft dropped is counted as missing")
  func missingSentence() {
    let theirs = "Hi Sven,\n\nOffload watches a week of your work. Your investment in Toast is why I'm writing.\n\nWorth 20 minutes next week? Deck attached.\n\nMuhammad"
    let ours = "Hi Sven,\n\nOffload watches a week of your work. Bessemer backs tools teams use every day.\n\nWorth 20 minutes next week?\n\nMuhammad"
    let s = SentenceDiff.summary(ours: ours, theirs: theirs)
    #expect(s.changed == 1 && s.missing == 1)
    #expect(s.label == "Changed 1 of 4 sentences · 1 missing")
    let onlyDropped = SentenceDiff.summary(ours: theirs.replacingOccurrences(of: " Deck attached.", with: ""), theirs: theirs)
    #expect(onlyDropped.changed == 0 && onlyDropped.missing == 1 && onlyDropped.label == "1 sentence missing")
    #expect(SentenceDiff.summary(ours: theirs, theirs: theirs).missing == 0)
  }

  @Test("⌘K opens Connections; K alone or another letter does not")
  func commandK() {
    #expect(DashboardSidebarLink.forShortcut(character: "k", command: true) == .connections)
    #expect(DashboardSidebarLink.forShortcut(character: "K", command: true) == .connections)
    #expect(DashboardSidebarLink.forShortcut(character: "k", command: false) == nil)
    #expect(DashboardSidebarLink.forShortcut(character: "j", command: true) == nil)
  }
}

@Suite("S10F review fixes: runs-with line")
struct S10FRunsWithTests {
  @Test("no 'Sends through X until X is connected' when the runner is the chosen tool (by connector id) or it is connected")
  func noSelfReference() {
    let o = ToolOption(id: "gsheets", name: "Google Sheets", via: "composio", why: "A sheet.", setup: "minutes", cost: "free",
                       connected: false, connectorId: "google-sheets")
    let t = StepTools(stepId: "s6", capability: "crm.log", need: "Log", options: [o], chosen: "gsheets", chosenBy: "default",
                      runsWith: "google-sheets", suggestion: "")
    #expect(ToolsCopy(t).runsWithLine == nil)
    let live = ToolsCopy(t, connectors: [Connector(id: "google-sheets", name: "Google Sheets", kind: .composio, connected: true)])
    #expect(live.runsWithLine == nil && live.options[0].mark == .inUse)
    // A different runner still says so.
    #expect(ToolsCopy(MockBrainClient.outreachTools[0]).runsWithLine == "Sends through Gmail until Instantly is connected.")
  }
}
