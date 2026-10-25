import { describe, expect, test } from "bun:test";
import { estimateSaving } from "../../src/insights/saving.ts";

const base = { instances: 500, daysActive: 5, windowDays: 7, medianMinutes: 3.0, eventIds: ["e1"] };

describe("saving estimator", () => {
  test("100/day for 5 days at 3 minutes with 20 s review saves 22.2 h/wk (89%)", () => {
    const s = estimateSaving(base);
    expect(s.weeklyHoursNow).toBeCloseTo(25, 10);
    expect(s.weeklyHoursAfter).toBeCloseTo(500 * 20 / 3600, 10);
    expect(s.weeklyHoursSaved).toBeCloseTo(25 - 500 * 20 / 3600, 10);
    expect(Math.round(s.savingPct * 100)).toBe(89);
  });

  test("the arithmetic is a human string the user can check by hand", () => {
    expect(estimateSaving(base).arithmetic).toBe("100/day × 5 days × 3.0 min = 25.0 h/wk → review 500 × 20 s = 2.8 h/wk → saves 22.2 h/wk (89%)");
  });

  test("review time per item is configurable", () => {
    const s = estimateSaving(base, { reviewSeconds: 30 });
    expect(s.reviewSecondsPerItem).toBe(30);
    expect(s.weeklyHoursAfter).toBeCloseTo(500 * 30 / 3600, 10);
    expect(s.arithmetic).toContain("500 × 30 s");
  });

  test("the range brackets the point estimate", () => {
    const s = estimateSaving(base);
    expect(s.range.low.hoursSaved).toBeLessThan(s.weeklyHoursSaved);
    expect(s.range.high.hoursSaved).toBeGreaterThan(s.weeklyHoursSaved);
    expect(s.range.low.pct).toBeLessThan(s.savingPct);
    expect(s.range.high.pct).toBeGreaterThan(s.savingPct);
  });

  test("a window shorter than 7 days is scaled to a week", () => {
    const s = estimateSaving({ instances: 300, daysActive: 3, windowDays: 3, medianMinutes: 2, eventIds: ["e"] });
    expect(s.weeklyItems).toBe(700);
    expect(s.arithmetic.startsWith("100/day × 7 days × 2.0 min")).toBe(true);
  });

  test("inputs are rounded before the maths so the printed arithmetic checks out", () => {
    const s = estimateSaving({ instances: 497, daysActive: 5, windowDays: 7, medianMinutes: 2.97, eventIds: ["e"] });
    expect(s.arithmetic.startsWith("99.4/day × 5 days × 3.0 min = 24.9 h/wk")).toBe(true);
    expect(s.weeklyHoursNow).toBeCloseTo((99.4 * 5 * 3.0) / 60, 10);
  });

  test("review longer than the task itself saves nothing rather than going negative", () => {
    const s = estimateSaving({ instances: 10, daysActive: 5, windowDays: 7, medianMinutes: 0.2, eventIds: ["e"] }, { reviewSeconds: 30 });
    expect(s.weeklyHoursSaved).toBe(0);
    expect(s.savingPct).toBe(0);
  });

  test("the estimate carries the event ids it was computed from", () => {
    expect(estimateSaving(base).eventIds).toEqual(["e1"]);
  });

  test("invalid review time is rejected", () => {
    expect(() => estimateSaving(base, { reviewSeconds: -1 })).toThrow(/reviewSeconds/);
  });
});
