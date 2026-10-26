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
