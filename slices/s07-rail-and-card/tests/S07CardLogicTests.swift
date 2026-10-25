import Foundation
import Testing

// S07: the non-visual logic behind the rail and the insight card.
// Keyboard state machine, 5-second undo window, insight paging, number formatting, rail mapping,
// mock brain data and the wire format.

private let t0 = Date(timeIntervalSince1970: 1_761_300_000)

private func sampleState() -> InboxState {
  InboxState(insights: MockBrainClient.sampleInsights)
}

// MARK: keyboard state machine

@Suite("S07 keyboard")
struct S07KeyboardTests {
  @Test("1 stages Build the workflow behind an undo window; nothing commits yet")
  func buildIsStaged() {
    var s = sampleState()
    let first = s.current!.id
    let effects = s.handle(.option(1), at: t0)
    #expect(effects == [.staged(.build(first))])
    #expect(s.pending?.action == .build(first))
    #expect(s.committed.isEmpty)
    #expect(s.insights.count == 3)
  }

  @Test("Esc inside the window undoes; the insight stays put")
  func escUndoes() {
    var s = sampleState()
    let first = s.current!.id
    _ = s.handle(.option(1), at: t0)
    let effects = s.handle(.escape, at: t0.addingTimeInterval(4.9))
    #expect(effects == [.undone(.build(first))])
    #expect(s.pending == nil)
    #expect(s.committed.isEmpty)
    #expect(s.current?.id == first)
  }

  @Test("after 5 s the staged action commits and the next insight slides in")
  func commitsAfterWindow() {
    var s = sampleState()
    let ids = s.insights.map(\.id)
    _ = s.handle(.option(1), at: t0)
    #expect(s.tick(at: t0.addingTimeInterval(4.99)).isEmpty)
    let effects = s.tick(at: t0.addingTimeInterval(5.0))
    #expect(effects == [.committed(.build(ids[0]))])
    #expect(s.committed == [.build(ids[0])])
    #expect(s.insights.map(\.id) == Array(ids.dropFirst()))
    #expect(s.current?.id == ids[1])
  }

  @Test("Esc after the window has closed cannot undo")
  func lateEscDoesNotUndo() {
    var s = sampleState()
    _ = s.handle(.option(3), at: t0)
    let effects = s.handle(.escape, at: t0.addingTimeInterval(6))
    // The late key first lets the expired action land, then Esc closes the card.
    #expect(effects.first == .committed(.notNow(MockBrainClient.sampleInsights[0].id)))
    #expect(effects.last == .close)
  }

  @Test("2 toggles the evidence and needs no undo")
  func evidenceToggle() {
    var s = sampleState()
    let id = s.current!.id
    #expect(s.handle(.option(2), at: t0) == [.showEvidence(id)])
    #expect(s.evidenceOpen)
    #expect(s.handle(.option(2), at: t0) == [.hideEvidence])
    #expect(!s.evidenceOpen)
    #expect(s.pending == nil)
  }

  @Test("Esc peels one layer at a time: undo, then evidence, then the card")
  func escLayers() {
    var s = sampleState()
    _ = s.handle(.option(2), at: t0)
    #expect(s.handle(.escape, at: t0) == [.hideEvidence])
    #expect(s.handle(.escape, at: t0) == [.close])
  }

  @Test("E dismisses behind the same undo window")
  func dismissIsStaged() {
    var s = sampleState()
    let id = s.current!.id
    #expect(s.handle(.dismiss, at: t0) == [.staged(.dismiss(id))])
    #expect(s.tick(at: t0.addingTimeInterval(5)) == [.committed(.dismiss(id))])
    #expect(!s.insights.contains { $0.id == id })
  }

  @Test("a new choice during the window lands the pending one first")
  func newKeyLandsPending() {
    var s = sampleState()
    let ids = s.insights.map(\.id)
    _ = s.handle(.option(3), at: t0)
    let effects = s.handle(.option(1), at: t0.addingTimeInterval(1))
    #expect(effects == [.committed(.notNow(ids[0])), .staged(.build(ids[1]))])
  }

  @Test("unknown option numbers are ignored")
  func unknownOption() {
    var s = sampleState()
    #expect(s.handle(.option(4), at: t0).isEmpty)
    #expect(s.handle(.option(0), at: t0).isEmpty)
    #expect(s.pending == nil)
  }

  @Test("the last insight going away ends in the calm empty state")
  func emptiesOut() {
    var s = InboxState(insights: [MockBrainClient.sampleInsights[0]])
    _ = s.handle(.dismiss, at: t0)
    let effects = s.tick(at: t0.addingTimeInterval(5))
    #expect(effects == [.committed(.dismiss(MockBrainClient.sampleInsights[0].id)), .becameEmpty])
    #expect(s.isEmpty)
    #expect(s.current == nil)
    #expect(s.handle(.option(1), at: t0).isEmpty)
  }

  @Test("key mapping: digits, J/K, E, Esc; modifiers fall through to the system")
  func keyMapping() {
    #expect(CardKey(characters: "1", keyCode: 18, hasCommandOrControl: false) == .option(1))
    #expect(CardKey(characters: "3", keyCode: 20, hasCommandOrControl: false) == .option(3))
    #expect(CardKey(characters: "j", keyCode: 38, hasCommandOrControl: false) == .next)
    #expect(CardKey(characters: "K", keyCode: 40, hasCommandOrControl: false) == .previous)
    #expect(CardKey(characters: "e", keyCode: 14, hasCommandOrControl: false) == .dismiss)
    #expect(CardKey(characters: "\u{1b}", keyCode: 53, hasCommandOrControl: false) == .escape)
    #expect(CardKey(characters: "j", keyCode: 38, hasCommandOrControl: true) == nil)
    #expect(CardKey(characters: "x", keyCode: 7, hasCommandOrControl: false) == nil)
  }
}

// MARK: undo timer

@Suite("S07 undo window")
struct S07UndoWindowTests {
  @Test("countdown fraction runs 1 to 0 over 5 s")
  func fraction() {
    let w = UndoWindow(action: .dismiss("x"), startedAt: t0)
    #expect(w.duration == 5)
    #expect(w.fractionRemaining(at: t0) == 1)
    #expect(abs(w.fractionRemaining(at: t0.addingTimeInterval(2.5)) - 0.5) < 1e-9)
    #expect(w.fractionRemaining(at: t0.addingTimeInterval(9)) == 0)
    #expect(!w.isExpired(at: t0.addingTimeInterval(4.999)))
    #expect(w.isExpired(at: t0.addingTimeInterval(5)))
  }

  @Test("a clock that steps backwards never grows the window past full")
  func backwardsClock() {
    let w = UndoWindow(action: .dismiss("x"), startedAt: t0)
    #expect(w.fractionRemaining(at: t0.addingTimeInterval(-3)) == 1)
    #expect(w.secondsLeftLabel(at: t0.addingTimeInterval(-3)) == "5s")
  }

  @Test("seconds label rounds up so it never shows 0s while still undoable")
  func label() {
    let w = UndoWindow(action: .dismiss("x"), startedAt: t0)
    #expect(w.secondsLeftLabel(at: t0) == "5s")
    #expect(w.secondsLeftLabel(at: t0.addingTimeInterval(0.2)) == "5s")
    #expect(w.secondsLeftLabel(at: t0.addingTimeInterval(4.9)) == "1s")
  }
}

// MARK: paging

@Suite("S07 paging")
struct S07PagingTests {
  @Test("J and K move through insights and stop at the ends")
  func paging() {
    var s = sampleState()
    let ids = s.insights.map(\.id)
    #expect(s.handle(.previous, at: t0).isEmpty)  // already at the first
    #expect(s.handle(.next, at: t0) == [.moved(to: 1)])
    #expect(s.handle(.next, at: t0) == [.moved(to: 2)])
    #expect(s.handle(.next, at: t0).isEmpty)
    #expect(s.current?.id == ids[2])
    #expect(s.handle(.previous, at: t0) == [.moved(to: 1)])
    #expect(s.positionLabel == "2 of 3")
  }

  @Test("moving closes the evidence of the card you left")
  func movingClosesEvidence() {
    var s = sampleState()
    _ = s.handle(.option(2), at: t0)
    _ = s.handle(.next, at: t0)
    #expect(!s.evidenceOpen)
  }

  @Test("removing the last item in the list keeps the index in range")
  func clampOnRemove() {
    var s = sampleState()
    _ = s.handle(.next, at: t0)
    _ = s.handle(.next, at: t0)
    _ = s.handle(.dismiss, at: t0)
    _ = s.tick(at: t0.addingTimeInterval(5))
    #expect(s.index == 1)
    #expect(s.positionLabel == "2 of 2")
  }
}

// MARK: formatting

@Suite("S07 formatting")
struct S07FormatTests {
  @Test("hours: whole numbers drop the decimal, under an hour shows minutes")
  func hours() {
    #expect(Format.hours(25) == "25 h")
    #expect(Format.hours(18.44) == "18.4 h")
    #expect(Format.hours(0.5) == "30 min")
    #expect(Format.hours(0) == "0 min")
    #expect(Format.hours(1.96) == "2 h")
  }

  @Test("percent: rounded, never shows 0% for something real")
  func percent() {
    #expect(Format.percent(0.649) == "65%")
    #expect(Format.percent(0.004) == "<1%")
    #expect(Format.percent(0) == "0%")
    #expect(Format.percent(1) == "100%")
  }

  @Test("counts group thousands; minutes carry a tilde because they are medians")
  func countsAndMinutes() {
    #expect(Format.count(500) == "500")
    #expect(Format.count(1200) == "1,200")
    #expect(Format.approxMinutes(3) == "~3 min")
    #expect(Format.approxMinutes(1.7) == "~1.7 min")
  }

  @Test("the arithmetic line multiplies out and ties to the headline share")
  func arithmetic() {
    let i = MockBrainClient.outreach
    #expect(Format.arithmetic(i) == "500 emails × ~3 min = 25 h of 38.5 h tracked")
    #expect(Format.headline(i) == "You spent 65% of your week on investor outreach emails.")
    // The share in the headline is the share the arithmetic implies.
    #expect(Format.percent(i.taskHours / i.trackedHours) == Format.percent(i.timeShare))
  }

  @Test("saving is a range; its arithmetic is the brain's line, or the same formula when absent")
  func saving() {
    let i = MockBrainClient.outreach
    #expect(Format.savingRange(i.saving) == "20–24 h back a week")
    #expect(Format.savingArithmetic(i) == i.saving.arithmetic)
    let crm = MockBrainClient.crmUpdate  // no brain line: the app uses the brain's formula
    #expect(crm.saving.arithmetic == nil)
    #expect(Format.savingArithmetic(crm) == "3.4 h now − 24 min review = 3 h a week (88%)")
  }

  @Test("every sample range brackets the point estimate it came from")
  func rangesBracket() {
    for i in MockBrainClient.sampleInsights {
      let saved = i.taskHours - Double(i.instanceCount) * i.saving.reviewMinutesPerInstance / 60
      #expect(i.saving.hoursPerWeekLow <= saved && saved <= i.saving.hoursPerWeekHigh, "\(i.kind)")
      #expect(abs(saved / i.taskHours - i.saving.savingPct) < 0.02, "\(i.kind)")
      #expect(abs(i.taskHours / i.trackedHours - i.timeShare) < 0.01, "\(i.kind)")
    }
  }

  @Test("evidence rows read as weekday, clock time and duration")
  func evidenceRow() {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    // 2026-10-20 is a Tuesday.
    let start = cal.date(from: DateComponents(year: 2026, month: 10, day: 20, hour: 9, minute: 14))!
    let span = EvidenceSpan(id: "e1", start: start, end: start.addingTimeInterval(260), activeMinutes: 4.3,
                            app: "Mail", title: "Re: Seed round", urlHost: nil, eventIds: ["ev1"])
    #expect(Format.spanTime(span, calendar: cal) == "Tue 09:14")
    #expect(Format.spanDuration(span) == "4 min")
  }

  @Test("evidence span minutes never round down to zero")
  func spanMinimum() {
    let start = Date(timeIntervalSince1970: 0)
    let span = EvidenceSpan(id: "e", start: start, end: start.addingTimeInterval(20), activeMinutes: 0.2,
                            app: "Mail", title: "t", urlHost: nil, eventIds: [])
    #expect(Format.spanDuration(span) == "1 min")
  }
}

// MARK: rail

@Suite("S07 rail")
struct S07RailTests {
  @Test("inbox badge: hidden at zero, capped at 9+")
  func badge() {
    #expect(RailModel.badgeLabel(0) == nil)
    #expect(RailModel.badgeLabel(3) == "3")
    #expect(RailModel.badgeLabel(12) == "9+")
  }

  @Test("status capsule: observer dot first, then one per active automation")
  func dots() {
    let status = ObserverStatus(state: .watching, daysStored: 4, windowDays: 7, nextPurge: t0, insightsWaiting: 3)
    let rail = RailModel(status: status, automations: MockBrainClient.sampleAutomations, micRecording: false)
    #expect(rail.dots.first == RailDot(id: "observer", role: .working, pulses: true))
    #expect(rail.dots.count == 1 + MockBrainClient.sampleAutomations.filter(\.isActive).count)
    #expect(rail.inboxBadge == "3")
    #expect(rail.inboxNeedsYou)
    #expect(rail.observerLabel == "Watching · Day 4 of 7")
  }

  @Test("paused observer turns grey and stops pulsing")
  func paused() {
    let status = ObserverStatus(state: .paused, daysStored: 2, windowDays: 7, nextPurge: t0, insightsWaiting: 0)
    let rail = RailModel(status: status, automations: [], micRecording: false)
    #expect(rail.dots == [RailDot(id: "observer", role: .neutral, pulses: false)])
    #expect(rail.observerLabel == "Paused · Day 2 of 7")
    #expect(!rail.inboxNeedsYou)
  }

  @Test("more than five dots collapse into an overflow count")
  func overflow() {
    let many = (0..<8).map {
      Automation(id: "a\($0)", name: "A\($0)", status: .running, hoursSavedEstimated: 1, hoursSavedMeasured: nil)
    }
    let status = ObserverStatus(state: .watching, daysStored: 7, windowDays: 7, nextPurge: t0, insightsWaiting: 0)
    let rail = RailModel(status: status, automations: many, micRecording: false)
    #expect(rail.dots.count == RailModel.maxDots)
    #expect(rail.overflowCount == 9 - RailModel.maxDots)
  }
}

// MARK: data

@Suite("S07 brain client")
struct S07BrainClientTests {
  @Test("mock brain serves the three sample insights, ranked by share")
  func mockInsights() async throws {
    let client = MockBrainClient()
    let insights = try await client.insights()
    #expect(insights.map(\.kind) == ["outreach", "scheduling", "crm-update"])
    #expect(insights.map(\.timeShare) == insights.map(\.timeShare).sorted(by: >))
    #expect(insights[0].connectors.map(\.name) == ["Gmail"])
  }

  @Test("every sample insight's evidence ids resolve to spans")
  func evidenceResolves() async throws {
    let client = MockBrainClient()
    for insight in try await client.insights() {
      let spans = try await client.evidence(insightId: insight.id)
      #expect(!spans.isEmpty)
      #expect(Set(spans.map(\.id)).isSubset(of: Set(insight.evidenceIds)))
    }
    await #expect(throws: BrainError.self) { try await client.evidence(insightId: "missing") }
  }

  @Test("models round-trip through JSON with camelCase keys and ISO dates")
  func codable() throws {
    let data = try BrainJSON.encoder.encode(MockBrainClient.outreach)
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("\"timeShare\""))
    #expect(text.contains("\"evidenceIds\""))
    let back = try BrainJSON.decoder.decode(Insight.self, from: data)
    #expect(back == MockBrainClient.outreach)
  }
}
