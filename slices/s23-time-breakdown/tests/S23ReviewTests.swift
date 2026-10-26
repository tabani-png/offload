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
    #expect(l.finish(t, breakdown: week, problem: nil))
    let d = l.start(day: "2026-10-14")
    #expect(l.finish(d, breakdown: day, problem: nil))
    #expect(l.day == "2026-10-14")
    #expect(l.reloadDay == "2026-10-14")
    #expect(l.weekDays == NeutralWeek.days)
  }

  @Test("a failed load clears the numbers and says why")
  func failureClears() {
    var l = TimeLoads()
    #expect(l.finish(l.start(day: nil), breakdown: week, problem: nil))
    #expect(l.finish(l.start(day: nil), breakdown: nil, problem: "The brain is not running."))
    #expect(l.time == nil)
    #expect(l.problem == "The brain is not running.")
  }

  @Test("an older answer that lands after a newer one is dropped")
  func outOfOrder() {
    var l = TimeLoads()
    let first = l.start(day: nil)
    let second = l.start(day: "2026-10-14")
    #expect(l.finish(second, breakdown: day, problem: nil))
    #expect(!l.finish(first, breakdown: week, problem: nil))
    #expect(l.time == day)
    #expect(l.day == "2026-10-14")
    // A stale failure is dropped too: it never clears the newer answer.
    let third = l.start(day: nil)
    let fourth = l.start(day: nil)
    #expect(l.finish(fourth, breakdown: week, problem: nil))
    #expect(!l.finish(third, breakdown: nil, problem: "late"))
    #expect(l.time == week && l.problem == nil)
  }
}
