// s23 ROUND: one rounding rule everywhere. The same quantity is never 24.7 h on one line and 24.8 h on another.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { formatHours, hoursTenths } from "../../src/time/format.ts";
import { brainOn, call, metrics, neutralHome, outreachHome, refHours, refTenths } from "./setup.ts";

const neutral = neutralHome();
const outreach = outreachHome();
let nWeek: any;
let oWeek: any;

beforeAll(async () => {
  nWeek = (await call(brainOn(neutral.home), "/time")).body;
  oWeek = (await call(brainOn(outreach.home), "/time")).body;
});
afterAll(() => {
  neutral.cleanup();
  outreach.cleanup();
});

/** hours → expected display, SPEC "Rounding" known answers. */
const TABLE: Array<[number, string]> = [
  [0, "0.0 h"],
  [2.9 / 60, "0.0 h"],
  [3 / 60, "0.1 h"],
  [1479 / 60, "24.7 h"], // 24.65 is 24.6499… in binary: printf-style %.1f says 24.6, the rule says 24.7
  [1482.3 / 60, "24.7 h"],
  [24.75, "24.8 h"],
  [1485 / 60, "24.8 h"],
  [59.99 / 60, "1.0 h"],
  [2292 / 60, "38.2 h"],
  [0.05, "0.1 h"],
  [0.15, "0.2 h"],
  [1.25, "1.3 h"],
  [2.45, "2.5 h"],
];

describe("s23 rounding", () => {
  test("ROUND: formatHours follows the one rule on the known-answer table (half up at the tenth)", () => {
    for (const [h, want] of TABLE) {
      expect({ h, got: formatHours(h) }).toEqual({ h, got: want });
      expect(hoursTenths(h)).toBe(refTenths(h));
      expect(refHours(h)).toBe(want); // the table itself agrees with the written rule
    }
  });

  test("ROUND: every display in the response is formatHours of its own value (minutes shown as hours)", () => {
    for (const week of [nWeek, oWeek]) {
      const all = metrics(week).filter((x) => typeof x.m.display === "string");
      expect(all.length).toBeGreaterThan(20);
      for (const { path, m } of all) {
        const hours = m.unit === "minutes" ? m.value / 60 : m.value;
        expect({ path, display: m.display }).toEqual({ path, display: formatHours(hours) });
        expect(m.display).toMatch(/^\d+\.\d h$/);
      }
    }
  });

  test("ROUND: a finding's task time is the same number, and the same display, as its task row", () => {
    for (const week of [nWeek, oWeek]) {
      const rows = new Map((week.byTask as any[]).map((r) => [r.id, r]));
      expect(week.findings.length).toBeGreaterThan(0);
      for (const f of week.findings as any[]) {
        const row = rows.get(f.taskId);
        expect(row).toBeDefined();
        expect(f.taskMinutes.value).toBe(row.minutes.value);
        expect(f.taskMinutes.display).toBe(row.minutes.display);
      }
    }
  });

  test("ROUND: the outreach week's biggest task shows one figure for its time, never 24.7 h next to 24.8 h", () => {
    const top = (oWeek.byTask as any[])[0];
    const f = (oWeek.findings as any[]).find((x) => x.taskId === top.id);
    expect(f).toBeDefined();
    // Observed hours a week come from the same minutes (x 7 / window days), not from instances x median.
    const expected = (top.minutes.value / 60) * (7 / oWeek.window.days.length);
    expect(Math.abs(f.observedHoursPerWeek.value - expected)).toBeLessThan(1e-9);
    expect(f.observedHoursPerWeek.display).toBe(formatHours(expected));
    // No second "hours now" figure for the same task travels with the finding.
    for (const k of ["weeklyHoursNow", "hoursNow", "weeklyHoursAfter"]) expect(k in f).toBe(false);
    expect(JSON.stringify(f)).not.toMatch(/\bh\/wk\b.*\bh\/wk\b.*\bh\/wk\b/); // not the s04 three-step chain
  });

  test("ROUND: the response names its rule", () => {
    expect(nWeek.rounding).toBe("tenths-half-up");
  });
});
