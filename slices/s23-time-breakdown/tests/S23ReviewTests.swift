import Foundation
import Testing

// S23, PR #29 review (P3): the time page's loads. A reload keeps the selected day; a failed load never leaves old
// numbers on screen; only the newest request's answer is shown (rapid Week / day clicks can answer out of order).

@Suite("S23 review: time loads")
struct S23TimeLoadsTests {
  let week = NeutralWeek.breakdown
  let day = NeutralWeek.day

  @Test("a reload asks for the day on screen, not the week")
  func reloadKeepsDay() {
    var l = TimeLoads()
    let t = l.start(day: nil)
    let r1 = l.finish(t, breakdown: week, problem: nil)
    #expect(r1)
    let d = l.start(day: "2026-10-14")
    let r2 = l.finish(d, breakdown: day, problem: nil)
    #expect(r2)
    #expect(l.day == "2026-10-14")
    #expect(l.reloadDay == "2026-10-14")
    #expect(l.weekDays == NeutralWeek.days)
  }

  @Test("a failed load clears the numbers and says why")
  func failureClears() {
    var l = TimeLoads()
    let t3 = l.start(day: nil)
    let r4 = l.finish(t3, breakdown: week, problem: nil)
    #expect(r4)
    let t5 = l.start(day: nil)
    let r6 = l.finish(t5, breakdown: nil, problem: "The brain is not running.")
    #expect(r6)
    #expect(l.time == nil)
    #expect(l.problem == "The brain is not running.")
  }

  @Test("an older answer that lands after a newer one is dropped")
  func outOfOrder() {
    var l = TimeLoads()
    let first = l.start(day: nil)
    let second = l.start(day: "2026-10-14")
    let r7 = l.finish(second, breakdown: day, problem: nil)
    #expect(r7)
    let r8 = l.finish(first, breakdown: week, problem: nil)
    #expect(!r8)
    #expect(l.time == day)
    #expect(l.day == "2026-10-14")
    // A stale failure is dropped too: it never clears the newer answer.
    let third = l.start(day: nil)
    let fourth = l.start(day: nil)
    let r9 = l.finish(fourth, breakdown: week, problem: nil)
    #expect(r9)
    let r10 = l.finish(third, breakdown: nil, problem: "late")
    #expect(!r10)
    #expect(l.time == week && l.problem == nil)
  }
}

// PR #29 delta review: a day that cannot be read (left the stored week, brain 404) never traps the page.
@Suite("S23 review: a failed day falls back to the week")
struct S23DayFallbackTests {
  @Test("a failed day load returns to Week, asks for one retry of the week, and keeps the picker")
  func failedDay() {
    var l = TimeLoads()
    let w = l.start(day: nil)
    let r1 = l.finish(w, breakdown: NeutralWeek.breakdown, problem: nil)
    #expect(r1)
    let d = l.start(day: "2026-10-01")
    let r2 = l.finish(d, breakdown: nil, problem: "No stored day 2026-10-01.")
    #expect(r2)
    #expect(l.day == nil)
    #expect(l.reloadDay == nil)
    #expect(l.retryWeek)
    #expect(l.showsPicker)
    // The retry is the week; once it answers there is nothing more to retry.
    let again = l.start(day: nil)
    let r3 = l.finish(again, breakdown: NeutralWeek.breakdown, problem: nil)
    #expect(r3)
    #expect(!l.retryWeek && l.time == NeutralWeek.breakdown)
  }

  @Test("a failed week load does not ask to retry (no loop), and the picker stays while the days are known")
  func failedWeek() {
    var l = TimeLoads()
    let w = l.start(day: nil)
    _ = l.finish(w, breakdown: NeutralWeek.breakdown, problem: nil)
    let w2 = l.start(day: nil)
    _ = l.finish(w2, breakdown: nil, problem: "The brain is not running.")
    #expect(!l.retryWeek)
    #expect(l.time == nil && l.showsPicker)
  }

  @Test("a Draft workflow notice clears when the person changes day or week")
  func noticeClears() {
    var l = TimeLoads()
    l.note("Could not draft the workflow.")
    #expect(l.notice == "Could not draft the workflow.")
    _ = l.start(day: "2026-10-14")
    #expect(l.notice == nil)
  }
}
