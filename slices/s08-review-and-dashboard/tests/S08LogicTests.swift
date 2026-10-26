import Foundation
import Testing

// S08: the non-visual logic behind the workflow review window, the dashboard and the pointer.
// Diff-lite, evidence titles, connector state, the approval flow, dashboard order and honesty, the timeline
// layout, the pointer flight and the glass veil solver.

private let t0 = Date(timeIntervalSince1970: 1_792_000_000)
private var utc: Calendar {
  var c = Calendar(identifier: .gregorian)
  c.timeZone = TimeZone(identifier: "UTC")!
  return c
}

// MARK: diff-lite

@Suite("S08 diff-lite")
struct S08DiffTests {
  @Test("identical text has no changed words and similarity 1")
  func identical() {
    let r = DiffLite.diff(ours: "Hi Priya,\n\nWorth 20 minutes?", theirs: "Hi Priya,\n\nWorth 20 minutes?")
    #expect(r.changedWordsOurs == 0 && r.changedWordsTheirs == 0)
    #expect(r.similarity == 1)
    #expect(r.ours.map(\.text).joined() == "Hi Priya,\n\nWorth 20 minutes?")
  }

  @Test("a swapped word is marked on both sides and nothing else is")
  func substitution() {
    let r = DiffLite.diff(ours: "Does Monday work?", theirs: "Does Tuesday work?")
    #expect(r.ours.filter(\.changed).map(\.text) == ["Monday"])
    #expect(r.theirs.filter(\.changed).map(\.text) == ["Tuesday"])
    #expect(r.ours.map(\.text).joined() == "Does Monday work?")
  }

  @Test("an inserted phrase is one highlight; the spaces inside it join, the spaces around it do not")
  func insertion() {
    let r = DiffLite.diff(ours: "Raising a seed.", theirs: "We are raising a seed.")
    #expect(r.theirs.filter(\.changed).map(\.text) == ["We are raising"])
    #expect(r.ours.filter(\.changed).map(\.text) == ["Raising"])
  }

  @Test("whitespace is never marked, even when the wording differs a lot")
  func whitespace() {
    let r = DiffLite.diff(ours: "a b\n\nc", theirs: "x y\n\nz")
    for seg in r.ours + r.theirs where seg.changed {
      #expect(!seg.text.hasPrefix(" ") && !seg.text.hasSuffix(" ") && !seg.text.contains("\n"))
    }
    #expect(r.similarity == 0)
  }

  @Test("tokens keep punctuation on its word and round-trip the text exactly")
  func tokens() {
    let text = "Free for 20 minutes Tuesday or Wednesday?\n\nMuhammad"
    #expect(DiffLite.tokens(text).joined() == text)
    #expect(DiffLite.tokens("Wednesday? Yes").contains("Wednesday?"))
  }

  @Test("empty sides are safe")
  func empty() {
    #expect(DiffLite.diff(ours: "", theirs: "").similarity == 1)
    let r = DiffLite.diff(ours: "", theirs: "Hi Lena")
    #expect(r.changedWordsTheirs == 2 && r.ours.isEmpty)
  }

  @Test("every sample dry-run pair is mostly the same words, with a few marked")
  func sampleDrafts() {
    for item in MockBrainClient.outreachDryRun.items {
      let r = DiffLite.diff(ours: item.ourDraft, theirs: item.whatYouSent)
      #expect(r.similarity > 0.5 && r.similarity < 1, "\(item.id) similarity \(r.similarity)")
      #expect(r.changedWordsOurs > 0)
    }
  }
}

// MARK: evidence titles

@Suite("S08 evidence titles")
struct S08EvidenceTitleTests {
  @Test("a counterparty at the end of the title moves to the front, said once")
  func suffix() {
    let t = EvidenceTitle.make(title: "Deck and data room access, Pellow Partners", counterparty: "Pellow Partners")
    #expect(t.lead == "Pellow Partners")
    #expect(t.subject == "Deck and data room access")
    #expect(t.plain == "Pellow Partners · Deck and data room access")
  }

  @Test("a counterparty at the start is not repeated either, whatever the case")
  func prefix() {
    let t = EvidenceTitle.make(title: "halden ventures - Intro call", counterparty: "Halden Ventures")
    #expect(t.lead == "Halden Ventures" && t.subject == "Intro call")
  }

  @Test("with no counterparty the title is shown as it is, nothing guessed")
  func none() {
    let t = EvidenceTitle.make(title: "Investor pipeline.numbers", counterparty: nil)
    #expect(t.lead == nil && t.subject == "Investor pipeline.numbers")
    #expect(EvidenceTitle.make(title: "Re: Intro", counterparty: "  ").lead == nil)
  }

  @Test("a title that is only the counterparty leaves an empty subject")
  func onlyWho() {
    let t = EvidenceTitle.make(title: "Ashgrove Capital", counterparty: "Ashgrove Capital")
    #expect(t.lead == "Ashgrove Capital" && t.subject.isEmpty && t.plain == "Ashgrove Capital")
  }

  @Test("a counterparty the title does not name is still put first")
  func notInTitle() {
    let t = EvidenceTitle.make(title: "Quick question on your fund thesis", counterparty: "Northline Fund")
    #expect(t.lead == "Northline Fund" && t.subject == "Quick question on your fund thesis")
  }

  @Test("every sample outreach span has a counterparty")
  func sample() {
    let spans = MockBrainClient.sampleEvidence["ins_outreach"]!
    #expect(spans.filter { $0.app == "Chrome" }.allSatisfy { $0.counterparty != nil })
    #expect(spans.first { $0.app == "Numbers" }?.counterparty == nil)
  }
}

// MARK: connectors

@Suite("S08 connectors")
struct S08ConnectorTests {
  @Test("chips: connected is green with no action; missing env is amber Add key; missing is grey Connect")
  func chips() {
    let ok = ConnectorChipModel(MockBrainClient.gmail)
    #expect(ok.role == .done && ok.action == nil)
    let key = ConnectorChipModel(MockBrainClient.hubspot)
    #expect(key.role == .needsYou && key.action == "Sign in…")  // s10d: "Add key…" was jargon
    let no = ConnectorChipModel(MockBrainClient.sheets)
    #expect(no.role == .neutral && no.action == "Connect…")
    #expect(no.accessibilityLabel == "Google Sheets, not connected")
  }

  @Test("GET /connectors state replaces the card's placeholder; unknown ids keep theirs")
  func applying() {
    let i = MockBrainClient.scheduling.applying(connectorStates: ["gmail": .connected])
    #expect(i.connectors.map(\.state) == [.missing, .connected])  // gcal not in the map: unchanged
    let back = MockBrainClient.gmail.applying(["gmail": .missingEnv])
    #expect(back.state == .missingEnv && !back.connected)
  }

  @Test("wire statuses decode; anything new reads as missing")
  func wireStates() {
    #expect(ConnectorState(wire: "connected") == .connected)
    #expect(ConnectorState(wire: "missing_env") == .missingEnv)
    #expect(ConnectorState(wire: "rate_limited") == .missing)
  }
}

// MARK: review keys

@Suite("S08 review keys")
struct S08ReviewKeyTests {
  @Test("⌘↩ approves, ↩ confirms, Esc, E, R, S, ⌘⌫ discards")
  func mapping() {
    #expect(ReviewKey(characters: "\r", keyCode: 36, command: true) == .approve)
    #expect(ReviewKey(characters: "\r", keyCode: 76, command: false) == .confirm)
    #expect(ReviewKey(characters: "\u{1b}", keyCode: 53, command: false) == .escape)
    #expect(ReviewKey(characters: "e", keyCode: 14, command: false) == .edit)
    #expect(ReviewKey(characters: "R", keyCode: 15, command: false) == .rerun)
    #expect(ReviewKey(characters: "s", keyCode: 1, command: false) == .skill)
    #expect(ReviewKey(characters: "\u{7f}", keyCode: 51, command: true) == .discard)
  }

  @Test("other ⌘, ⌃ and ⌥ chords pass through to the system")
  func passThrough() {
    #expect(ReviewKey(characters: "w", keyCode: 13, command: true) == nil)
    #expect(ReviewKey(characters: "e", keyCode: 14, command: false, control: true) == nil)
    #expect(ReviewKey(characters: "r", keyCode: 15, command: false, option: true) == nil)
  }

  @Test("while typing in the tone card, letters and ↩ are text; ⌘↩ and Esc still work")
  func textEditing() {
    #expect(ReviewKey(characters: "e", keyCode: 14, command: false, textEditing: true) == nil)
    #expect(ReviewKey(characters: "\r", keyCode: 36, command: false, textEditing: true) == nil)
    #expect(ReviewKey(characters: "\u{7f}", keyCode: 51, command: true, textEditing: true) == nil)
    #expect(ReviewKey(characters: "\r", keyCode: 36, command: true, textEditing: true) == .approve)
    #expect(ReviewKey(characters: "", keyCode: 53, command: false, textEditing: true) == .escape)
  }

  @Test("dashboard keys: J K P 2 ↩ Esc; ⌘ chords pass")
  func dashboardKeys() {
    #expect(DashboardKey(characters: "j", keyCode: 38, command: false) == .next)
    #expect(DashboardKey(characters: "K", keyCode: 40, command: false) == .previous)
    #expect(DashboardKey(characters: "p", keyCode: 35, command: false) == .point)
    #expect(DashboardKey(characters: "2", keyCode: 19, command: false) == .evidence)
    #expect(DashboardKey(characters: "\r", keyCode: 36, command: false) == .open)
    #expect(DashboardKey(characters: "d", keyCode: 2, command: true) == nil)
  }
}

// MARK: approval flow

@Suite("S08 approval flow")
struct S08ApprovalTests {
  private func flow() -> ApprovalFlow { ApprovalFlow(workflow: MockBrainClient.outreachWorkflow) }

  @Test("⌘↩ opens the confirmation with the first-run plan; it never approves by itself")
  func opensConfirm() {
    var f = flow()
    let effects = f.handle(.approve, at: t0)
    #expect(effects == [.openConfirm(FirstRunPlan(workflow: MockBrainClient.outreachWorkflow))])
    #expect(f.isConfirmOpen)
    #expect(f.tick(at: t0.addingTimeInterval(60)).isEmpty)
    #expect(f.phase == .confirming(since: t0))
  }

  @Test("↩ in the first half second is ignored, so a double ⌘↩ cannot approve")
  func debounce() {
    var f = flow()
    _ = f.handle(.approve, at: t0)
    #expect(f.handle(.approve, at: t0.addingTimeInterval(0.2)).isEmpty)
    #expect(f.handle(.confirm, at: t0.addingTimeInterval(0.4)).isEmpty)
    #expect(f.handle(.confirm, at: t0.addingTimeInterval(0.6)) == [.armed])
  }

  @Test("after confirm, Esc within 5 s cancels and nothing reaches the brain")
  func escCancels() {
    var f = flow()
    _ = f.handle(.approve, at: t0)
    _ = f.handle(.confirm, at: t0.addingTimeInterval(1))
    #expect(f.countdown?.secondsLeftLabel(at: t0.addingTimeInterval(1.2)) == "5s")
    let effects = f.handle(.escape, at: t0.addingTimeInterval(5.9))
    #expect(effects == [.cancelled, .closeConfirm])
    #expect(f.phase == .reviewing)
    #expect(f.tick(at: t0.addingTimeInterval(30)).isEmpty)
  }

  @Test("the countdown runs out and the approval carries the exact batch hash")
  func lands() {
    var f = flow()
    _ = f.handle(.approve, at: t0)
    _ = f.handle(.confirm, at: t0.addingTimeInterval(1))
    #expect(f.tick(at: t0.addingTimeInterval(5.9)).isEmpty)
    let effects = f.tick(at: t0.addingTimeInterval(6))
    #expect(effects == [.approved(workflowId: "wf_outreach", batchHash: "b_7f3a91c2"), .closeConfirm])
    #expect(f.isFinal && f.workflow.state == .active)
    #expect(f.handle(.escape, at: t0.addingTimeInterval(6.1)).isEmpty)  // too late: it landed
  }

  @Test("while armed, every key but Esc is ignored")
  func armedIgnores() {
    var f = flow()
    _ = f.handle(.approve, at: t0)
    _ = f.handle(.confirm, at: t0.addingTimeInterval(1))
    for k in [ReviewKey.approve, .confirm, .edit, .rerun, .skill, .discard] {
      #expect(f.handle(k, at: t0.addingTimeInterval(2)).isEmpty)
    }
    #expect(f.countdown != nil)
  }

  @Test("Esc in the confirmation closes it and returns to review")
  func escConfirm() {
    var f = flow()
    _ = f.handle(.approve, at: t0)
    #expect(f.handle(.escape, at: t0.addingTimeInterval(0.1)) == [.closeConfirm])
    #expect(f.phase == .reviewing && !f.isConfirmOpen)
  }

  @Test("discard waits 5 s too: Esc brings it back, otherwise it lands")
  func discard() {
    var f = flow()
    #expect(f.handle(.discard, at: t0) == [.discardStaged])
    #expect(f.handle(.escape, at: t0.addingTimeInterval(2)) == [.discardUndone])
    _ = f.handle(.discard, at: t0.addingTimeInterval(3))
    #expect(f.tick(at: t0.addingTimeInterval(8)) == [.discarded(workflowId: "wf_outreach")])
    #expect(f.isFinal)
  }

  @Test("E, R and S pass through as effects while reviewing")
  func passThroughEffects() {
    var f = flow()
    #expect(f.handle(.edit, at: t0) == [.edit])
    #expect(f.handle(.rerun, at: t0) == [.rerunDryRun])
    #expect(f.handle(.skill, at: t0) == [.showSkill])
    #expect(f.handle(.confirm, at: t0).isEmpty)
  }

  @Test("an active workflow cannot be approved again")
  func noReapprove() {
    var w = MockBrainClient.outreachWorkflow
    w.state = .active
    var f = ApprovalFlow(workflow: w)
    #expect(f.handle(.approve, at: t0).isEmpty)
  }

  @Test("a re-run replaces the workflow and closes an open confirmation")
  func replace() {
    var f = flow()
    _ = f.handle(.approve, at: t0)
    var w = MockBrainClient.outreachWorkflow
    w.batchHash = "b_new"
    f.replaceWorkflow(w)
    #expect(f.phase == .reviewing && f.workflow.batchHash == "b_new")
  }
}

// MARK: first-run plan

@Suite("S08 first-run plan")
struct S08PlanTests {
  @Test("says exactly how many emails go to whom, in order")
  func headline() {
    let p = FirstRunPlan(workflow: MockBrainClient.outreachWorkflow)
    #expect(p.headline == "First batch: 8 recipients (drafted, then held for you)")
    #expect(p.recipients.map(\.email) == MockBrainClient.nextBatch.map(\.email))
    #expect(p.sendVia == "Gmail" && p.sendFrom == "muhammad@offload.so")
  }

  @Test("the batch size caps the recipients")
  func cap() {
    var w = MockBrainClient.outreachWorkflow
    w.schedule.batchSize = 3
    let p = FirstRunPlan(workflow: w)
    #expect(p.sendCount == 3 && p.headline == "First batch: 3 recipients (drafted, then held for you)")
    #expect(FirstRunPlan.emails(1) == "1 email")
  }

  @Test("a connector the steps after the gate need, and that is not connected, is named up front")
  func blockers() {
    let p = FirstRunPlan(workflow: MockBrainClient.outreachWorkflow)
    #expect(p.blockers == ["Google Sheets is not connected. Log each send to the pipeline waits until you connect it."])
    var w = MockBrainClient.outreachWorkflow
    w.connectors = w.connectors.map { $0.applying(["gsheets": .connected]) }
    #expect(FirstRunPlan(workflow: w).blockers.isEmpty)
  }

  @Test("the steps say the gate holds everything before sending")
  func steps() {
    let p = FirstRunPlan(workflow: MockBrainClient.outreachWorkflow)
    #expect(p.steps.count == 4)
    #expect(p.steps[1].contains("Nothing sends before that"))
    #expect(p.steps[3] == "Log 8 rows to Investor pipeline.")
  }
}
