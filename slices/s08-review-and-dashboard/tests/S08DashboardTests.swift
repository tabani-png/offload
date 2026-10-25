import CoreGraphics
import Foundation
import Testing

// S08: dashboard order and honesty, the timeline layout, the pointer flight, the glass veil and the mock data.

private let t0 = Date(timeIntervalSince1970: 1_792_000_000)
private var utc: Calendar {
  var c = Calendar(identifier: .gregorian)
  c.timeZone = TimeZone(identifier: "UTC")!
  return c
}

private func auto(_ id: String, _ s: WorkflowState) -> DashboardAutomation {
  DashboardAutomation(id: id, workflowId: nil, insightId: "i", name: id, state: s, connectors: [], lastRunAt: nil,
                      nextRunAt: nil, estimatedHoursPerWeek: 1, measuredHoursPerWeek: nil, needsYouReason: nil, taskId: nil)
}

// MARK: dashboard

@Suite("S08 dashboard")
struct S08DashboardLogicTests {
  @Test("needs-you rows sort to the top, then ready for review, drafting, active, paused; ties keep order")
  func order() {
    let autos = [auto("a", .active), auto("p", .paused), auto("n1", .needsYou), auto("r", .readyForReview),
                 auto("d", .drafting), auto("n2", .needsYou)]
    #expect(DashboardOrder.sorted(autos).map(\.id) == ["n1", "n2", "r", "d", "a", "p"])
  }

  @Test("status colours: drafting blue, review and needs-you amber, active green, paused grey")
  func roles() {
    #expect(WorkflowState.allCases.map(StatusRole.forWorkflow) == [.working, .needsYou, .done, .neutral, .needsYou])
    #expect(WorkflowState(wire: "needs_you") == .needsYou)
    #expect(WorkflowState(wire: "something_new") == .drafting)
  }

  @Test("hero says measured only when measured exists, and keeps the estimate in view")
  func honestHero() {
    let m = HoursSaved(estimated: 21.9, measured: 16.8)
    #expect(m.heroValue == 16.8 && m.heroQualifier == "measured" && m.detail == "21.9 h estimated")
    let e = HoursSaved(estimated: 21.9, measured: nil)
    #expect(e.heroValue == 21.9 && e.heroQualifier == "estimated")
    #expect(e.detail.hasPrefix("Not measured yet"))
    #expect(e.accessibilityLabel.contains("estimated. Not measured yet"))
  }

  @Test("selection starts on the needs-you row and J/K stop at the ends")
  func selection() {
    var s = DashboardSelection(MockBrainClient.dashboardAutomations)
    #expect(s.selectedId == "auto_crm")
    s.move(.previous)
    #expect(s.selectedId == "auto_crm")
    s.move(.next); s.move(.next); s.move(.next)
    #expect(s.selectedId == "auto_outreach")
    s.select("auto_scheduling")
    #expect(s.selectedId == "auto_scheduling")
    #expect(DashboardSelection([]).selectedId == nil)
  }

  @Test("run times read Today, Yesterday, Tomorrow or the weekday; nil says Never or Not scheduled")
  func runTimes() {
    let cal = utc
    let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 23, hour: 11))!
    let at = { (d: Int, h: Int) in cal.date(from: DateComponents(year: 2026, month: 10, day: d, hour: h))! }
    #expect(Format.runTime(at(23, 9), now: now, past: true, calendar: cal) == "Today 09:00")
    #expect(Format.runTime(at(22, 17), now: now, past: true, calendar: cal) == "Yesterday 17:00")
    #expect(Format.runTime(at(24, 9), now: now, past: false, calendar: cal) == "Tomorrow 09:00")
    #expect(Format.runTime(at(26, 9), now: now, past: false, calendar: cal) == "Mon 09:00")
    #expect(Format.runTime(nil, now: now, past: true, calendar: cal) == "Never")
    #expect(Format.runTime(nil, now: now, past: false, calendar: cal) == "Not scheduled")
  }

  @Test("observing: days stored and when the oldest day is deleted")
  func observing() {
    let cal = utc
    let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 23, hour: 11))!
    var o = ObservingState(state: .watching, daysStored: 7, keepDays: 7, nextPurgeDay: "2026-10-17",
                           nextPurgeAt: cal.date(from: DateComponents(year: 2026, month: 10, day: 24))!, permissions: [])
    #expect(o.daysLabel == "7 of 7 days stored")
    #expect(o.purgeLabel(now: now, calendar: cal) == "Sat 17 Oct is deleted at midnight tonight")
    o.nextPurgeAt = cal.date(from: DateComponents(year: 2026, month: 10, day: 26, hour: 0))!
    #expect(o.purgeLabel(now: now, calendar: cal) == "Sat 17 Oct is deleted Mon 26 Oct at 00:00")
    o.nextPurgeDay = nil
    #expect(o.purgeLabel(now: now, calendar: cal) == "Nothing stored yet")
  }

  @Test("permission rows: allowed green, not allowed amber, not needed grey")
  func permissions() {
    let p = MockBrainClient.dashboardObserving.permissions
    #expect(p.map(\.role) == [.done, .neutral, .neutral])  // the mic is optional: off is not a problem
    #expect(p.map(\.label) == ["Allowed", "Not needed", "Off, optional"])
    #expect(PermissionState(name: "Accessibility", grant: .notGranted).role == .needsYou)
  }

  @Test("dry-run time per item reads hand time then review time")
  func reviewTime() {
    #expect(Format.reviewTime(observedMinutes: 3.2, reviewSeconds: 20) == "3.2 min by hand → 20 s to review")
    #expect(Format.perWeek(21.9) == "21.9 h a week")
  }
}

// MARK: timeline

@Suite("S08 timeline")
struct S08TimelineTests {
  private func bar(_ d: Int, _ h0: Int, _ m0: Int, _ h1: Int, _ m1: Int, cal: Calendar) -> TimelineBar {
    TimelineBar(id: "b", taskId: "t", start: cal.date(from: DateComponents(year: 2026, month: 10, day: d, hour: h0, minute: m0))!,
                end: cal.date(from: DateComponents(year: 2026, month: 10, day: d, hour: h1, minute: m1))!,
                automated: false, title: "", counterparty: nil)
  }

  @Test("the window fits the data in whole hours and is never narrower than 08:00-19:00")
  func fitting() {
    let cal = utc
    let day = { (bars: [TimelineBar]) in TimelineDay(day: "d", date: cal.startOfDay(for: bars[0].start), bars: bars) }
    #expect(TimelineLayout.fitting([day([bar(19, 10, 0, 11, 0, cal: cal)])], calendar: cal) == TimelineLayout(startHour: 8, endHour: 19))
    let wide = TimelineLayout.fitting([day([bar(19, 7, 30, 8, 0, cal: cal), bar(19, 19, 30, 20, 20, cal: cal)])], calendar: cal)
    #expect(wide == TimelineLayout(startHour: 7, endHour: 21))
  }

  @Test("x positions are fractions of the window, clamped to the row")
  func fraction() {
    let cal = utc
    let layout = TimelineLayout(startHour: 8, endHour: 20)
    let day = cal.date(from: DateComponents(year: 2026, month: 10, day: 19))!
    #expect(layout.fraction(day.addingTimeInterval(14 * 3600), dayStart: day) == 0.5)
    #expect(layout.fraction(day.addingTimeInterval(6 * 3600), dayStart: day) == 0)
    #expect(layout.fraction(day.addingTimeInterval(23 * 3600), dayStart: day) == 1)
  }

  @Test("a one-minute span still gets a visible width and stays inside the row")
  func minWidth() {
    let cal = utc
    let layout = TimelineLayout(startHour: 8, endHour: 20)
    let day = cal.date(from: DateComponents(year: 2026, month: 10, day: 19))!
    let e = layout.extent(bar(19, 19, 59, 20, 0, cal: cal), dayStart: day)
    #expect(e.width == TimelineLayout.minWidth)
    #expect(e.x + e.width <= 1)
  }

  @Test("sample week: 7 rows, hatched outreach only after it was turned on Wed 21 09:00")
  func sampleWeek() {
    let days = MockBrainClient.timelineDays
    #expect(days.count == 7)
    let on = MockBrainClient.local(21, 9, 0)
    for b in days.flatMap(\.bars) {
      if b.automated { #expect(b.taskId == "t_outreach" && b.start >= on) }
      if b.taskId == "t_outreach" && b.start >= on { #expect(b.automated) }
    }
    for d in days { #expect(d.bars.map(\.start) == d.bars.map(\.start).sorted()) }
    #expect(days.flatMap(\.bars).contains { $0.id == MockBrainClient.evidenceBarId && !$0.automated })
  }
}

// MARK: pointer

@Suite("S08 pointer")
struct S08PointerTests {
  private let bounds = CGRect(x: 0, y: 0, width: 800, height: 600)

  private func flight(reduce: Bool = false, from: CGPoint = CGPoint(x: 700, y: 500),
                      target: CGRect = CGRect(x: 100, y: 100, width: 300, height: 40)) -> PointerFlight {
    PointerFlight(origin: from, target: target, bounds: bounds, label: "Here", startedAt: t0, reduceMotion: reduce)
  }

  @Test("starts at the origin and lands 8 pt right, 12 pt below the target's leading third")
  func endpoints() {
    let f = flight()
    #expect(f.frame(at: t0).position == CGPoint(x: 700, y: 500))
    #expect(f.landing == CGPoint(x: 100 + 28 + 8, y: 120 + 12))
    let landed = f.frame(at: t0.addingTimeInterval(f.flightDuration + 0.01)).position
    #expect(abs(landed.x - f.landing.x) < 0.001 && abs(landed.y - f.landing.y) < 0.001)
  }

  @Test("the arc's control point is lifted by distance × 0.2, capped at 80 pt")
  func control() {
    let near = flight(from: CGPoint(x: 236, y: 132))  // 100 pt left of the landing
    let lift = min(near.landing.y, near.origin.y) - near.control.y
    #expect(abs(lift - near.distance * 0.2) < 0.001)
    let far = flight()
    #expect(min(far.landing.y, far.origin.y) - far.control.y == 80)
  }

  @Test("flight time is distance / 800, clamped to 0.6...1.4 s")
  func durations() {
    #expect(flight(from: CGPoint(x: 150, y: 140)).flightDuration == 0.6)
    #expect(flight(from: CGPoint(x: 2000, y: 1800)).flightDuration == 1.4)
    let mid = flight()
    #expect(abs(mid.flightDuration - mid.distance / 800) < 0.0001)
  }

  @Test("holds 3 s with its label, flies back, ends at the origin and disappears")
  func phases() {
    let f = flight()
    let d = f.flightDuration
    #expect(f.frame(at: t0.addingTimeInterval(d / 2)).phase == .out)
    #expect(f.frame(at: t0.addingTimeInterval(d / 2)).scale > 1.2)
    let hold = f.frame(at: t0.addingTimeInterval(d + 1.5))
    #expect(hold.phase == .hold && hold.labelVisible && hold.position == f.landing)
    #expect(!f.frame(at: t0.addingTimeInterval(d + 3.1)).labelVisible)
    let end = f.frame(at: t0.addingTimeInterval(f.totalDuration - 0.001))
    #expect(abs(end.position.x - f.origin.x) < 1 && abs(end.position.y - f.origin.y) < 1)
    #expect(f.frame(at: t0.addingTimeInterval(f.totalDuration + 0.001)).phase == .done)
    #expect(f.frame(at: t0.addingTimeInterval(f.totalDuration + 0.001)).opacity == 0)
  }

  @Test("Reduce Motion: no flight, it fades in at the target, holds, fades out")
  func reduceMotion() {
    let f = flight(reduce: true)
    #expect(f.flightDuration == PointerFlight.fade)
    for s in stride(from: 0.0, to: f.totalDuration, by: 0.1) {
      #expect(f.frame(at: t0.addingTimeInterval(s)).position == f.landing)
    }
    #expect(f.frame(at: t0.addingTimeInterval(0.1)).opacity < 1)
    #expect(f.frame(at: t0.addingTimeInterval(1.5)).labelVisible)
  }

  @Test("on a short target the tip stays on the target's lower edge, not the row below")
  func shortTarget() {
    let bar = CGRect(x: 100, y: 200, width: 80, height: 14)
    let f = flight(target: bar)
    #expect(f.landing.y <= bar.maxY && f.landing.y > bar.midY)
    #expect(f.landing.x > bar.minX && f.landing.x < bar.maxX)
  }

  @Test("the landing stays 20 pt inside the window")
  func clamp() {
    let f = flight(target: CGRect(x: 790, y: 590, width: 40, height: 40))
    #expect(f.landing.x <= 780 && f.landing.y <= 580)
  }
}

// MARK: glass veil

@Suite("S08 glass veil")
struct S08GlassTests {
  @Test("contrast maths: white on black is 21:1, equal greys 1:1")
  func contrast() {
    #expect(abs(GlassVeil.contrast(1, 0) - 21) < 0.01)
    #expect(GlassVeil.contrast(0.4, 0.4) == 1)
  }

  @Test("the solved veil keeps tertiary ink at 4.5:1 over the worst backdrop, dark and light")
  func meetsTarget() {
    for p in [GlassVeil.Params.dark, .light] {
      let a = GlassVeil.opacity(p)
      #expect(GlassVeil.achieved(p, veilOpacity: a, backdrop: p.backdrop) >= p.target, "dark=\(p.dark) a=\(a)")
      #expect(p.target >= 4.5)
    }
  }

  @Test("it is the least veil that does it (or the floor), so the glass stays as clear as legibility allows")
  func least() {
    for p in [GlassVeil.Params.dark, .light] {
      let a = GlassVeil.opacity(p)
      #expect(a >= p.floor)
      if a > p.floor { #expect(GlassVeil.achieved(p, veilOpacity: a - 0.01, backdrop: p.backdrop) < p.target) }
    }
  }

  @Test("Increase Contrast raises the veil to reach 7:1; Reduce Transparency makes it opaque")
  func accessibility() {
    let p = GlassVeil.Params.dark
    let hi = GlassVeil.opacity(p, increaseContrast: true)
    #expect(hi >= GlassVeil.opacity(p))
    #expect(GlassVeil.achieved(p, veilOpacity: hi, backdrop: 1) >= 7 || hi == 1)
    #expect(GlassVeil.opacity(p, reduceTransparency: true) == 1)
  }
}

// MARK: mock data

@Suite("S08 mock brain")
struct S08MockTests {
  @Test("outreach workflow: 8 steps, exactly one gate, and every side effect after it")
  func gateOrder() {
    let w = MockBrainClient.outreachWorkflow
    #expect(w.steps.count == 8)
    #expect(w.steps.filter(\.isGate).count == 1)
    let gate = w.steps.firstIndex(where: \.isGate)!
    for (i, s) in w.steps.enumerated() where s.type.isSideEffect { #expect(i > gate, "\(s.id) before the gate") }
    #expect(w.state == .readyForReview && w.nextBatch.count == 8)
  }

  @Test("three dry-run drafts in a short direct voice, signed Muhammad, with code arithmetic")
  func dryRun() {
    let items = MockBrainClient.outreachDryRun.items
    #expect(items.count == 3)
    for i in items {
      #expect(i.ourDraft.hasSuffix("Muhammad") && i.whatYouSent.hasSuffix("Muhammad"))
      #expect(i.ourDraft.split(whereSeparator: \.isWhitespace).count <= 80)
      #expect(!i.ourDraft.contains("!") && !i.ourDraft.lowercased().contains("hope this finds"))
      #expect(abs(i.minutesSaved - (i.observedMinutes - i.reviewSeconds / 60)) < 0.06)
    }
  }

  @Test("dashboard: one active outreach at 21.9 h a week, one ready for review, one needs you")
  func dashboard() {
    let a = MockBrainClient.dashboardAutomations
    #expect(a.filter { $0.state == .active }.map(\.name) == ["Investor outreach emails"])
    #expect(a.first { $0.state == .active }?.estimatedHoursPerWeek == 21.9)
    #expect(a.filter { $0.state == .readyForReview }.count == 1)
    #expect(a.filter { $0.state == .needsYou }.count == 1)
    #expect(a.first { $0.state == .needsYou }?.needsYouReason != nil)
  }

  @Test("mock client: draft by insight, dry-run limit, approve needs the exact batch hash")
  func client() async throws {
    let c = MockBrainClient()
    let w = try await c.workflow(forInsight: "ins_outreach")
    #expect(w.id == "wf_outreach")
    #expect(try await c.dryRun(workflowId: w.id, limit: 2).items.count == 2)
    #expect(try await c.approve(workflowId: w.id, batchHash: w.batchHash).state == .active)
    await #expect(throws: BrainError.self) { try await c.approve(workflowId: w.id, batchHash: "stale") }
    await #expect(throws: BrainError.self) { try await c.workflow(forInsight: "ins_none") }
    #expect(try await c.connectorStates()["gsheets"] == .missing)
  }

  @Test("every step type has its own symbol; the gate is the lock")
  func symbols() {
    #expect(Set(StepType.allCases.map(\.symbol)).count == StepType.allCases.count)
    #expect(StepType.approvalGate.symbol == "lock.fill")
    #expect(StepType(rawValue: "approval_gate") == .approvalGate)
  }
}
