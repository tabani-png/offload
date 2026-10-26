import { describe, expect, test } from "bun:test";
import { nextRun, parseCron, scheduleProblem } from "../../src/modules/workers/cron.ts";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

describe("SCHEDULE (pure)", () => {
  test("SCHEDULE: valid 5-field crons are accepted", () => {
    for (const c of ["0 22 * * 1-5", "30 6 * * *", "0 4 * * *", "59 0 * * *", "*/15 8-18 * * 1-5", "0 0,12 1 * *", "0 9 * * 0,7"]) {
      expect({ c, p: scheduleProblem(c, "America/Toronto") }).toEqual({ c, p: null });
    }
  });

  test("SCHEDULE: 02:30 local is rejected", () => {
    expect(scheduleProblem("30 2 * * *", "America/Toronto")).toMatch(/01:00 and 03:59/);
  });

  test("SCHEDULE: every hour form that reaches 01:00-03:59 is rejected (single, range, list, step, star)", () => {
    for (const c of ["0 1 * * *", "59 3 * * *", "0 0-4 * * *", "0 22,3 * * *", "0 */2 * * *", "0 * * * *", "15 1-1 * * 1"]) {
      expect({ c, bad: scheduleProblem(c, "Europe/London") !== null }).toEqual({ c, bad: true });
    }
  });

  test("SCHEDULE: malformed crons and unknown timezones are refused in plain words", () => {
    expect(scheduleProblem("0 22 * *", "UTC")).toMatch(/5 fields/);
    expect(scheduleProblem("61 22 * * *", "UTC")).toMatch(/minute/);
    expect(scheduleProblem("0 22 * * MON", "UTC")).toMatch(/day of week/);
    expect(scheduleProblem("@daily", "UTC")).not.toBeNull();
    expect(scheduleProblem("0 22 * * *", "Mars/Olympus")).toMatch(/IANA/);
  });

  test("SCHEDULE: next run is computed in the schedule's own timezone", () => {
    // 2026-10-26 09:00 UTC = 05:00 in Toronto (EDT, UTC-4); next 22:00 Toronto = 02:00 UTC next day.
    expect(iso(nextRun("0 22 * * *", "America/Toronto", Date.UTC(2026, 9, 26, 9, 0)))).toBe("2026-10-27T02:00:00.000Z");
    expect(iso(nextRun("0 22 * * *", "Asia/Kolkata", Date.UTC(2026, 9, 26, 9, 0)))).toBe("2026-10-26T16:30:00.000Z");
  });

  test("SCHEDULE: DST-safe next run across spring-forward keeps the local hour (Toronto, 2027-03-14)", () => {
    // 22:00 local on 13 March is EST (UTC-5) = 03:00 UTC; on 14 March it is EDT (UTC-4) = 02:00 UTC.
    const a = nextRun("0 22 * * *", "America/Toronto", Date.UTC(2027, 2, 13, 12));
    const b = nextRun("0 22 * * *", "America/Toronto", a!);
    expect([iso(a), iso(b)]).toEqual(["2027-03-14T03:00:00.000Z", "2027-03-15T02:00:00.000Z"]);
  });

  test("SCHEDULE: DST-safe next run across fall-back fires once per day (London, 2026-10-25)", () => {
    const a = nextRun("30 6 * * *", "Europe/London", Date.UTC(2026, 9, 24, 12));
    const b = nextRun("30 6 * * *", "Europe/London", a!);
    expect([iso(a), iso(b)]).toEqual(["2026-10-25T06:30:00.000Z", "2026-10-26T06:30:00.000Z"]);
  });

  test("SCHEDULE: a local time that does not exist is skipped, a repeated one fires once (Havana changes at 00:00)", () => {
    // Cuba: 2027-03-14 00:00 → 01:00 (no 00:30 that night); 2026-11-01 01:00 → 00:00 (00:30 happens twice).
    const spring = nextRun("30 0 * * *", "America/Havana", Date.UTC(2027, 2, 13, 12));
    expect(iso(spring)).toBe("2027-03-15T04:30:00.000Z");
    const fall = nextRun("30 0 * * *", "America/Havana", Date.UTC(2026, 9, 31, 12));
    const after = nextRun("30 0 * * *", "America/Havana", fall!);
    expect(iso(fall)).toBe("2026-11-01T04:30:00.000Z");
    expect(iso(after)).toBe("2026-11-02T05:30:00.000Z");
  });

  test("SCHEDULE: day-of-month and day-of-week follow POSIX (either matches when both are restricted)", () => {
    const c = parseCron("0 9 13 * 5");
    expect(c.domStar || c.dowStar).toBe(false);
    // From Mon 2026-11-09: Fri 13 Nov matches both; Fri 6 Nov... the first after the 9th is Fri the 13th.
    expect(iso(nextRun("0 9 13 * 5", "UTC", Date.UTC(2026, 10, 9)))).toBe("2026-11-13T09:00:00.000Z");
    // From Sat 2026-11-14: next Friday (20th) comes before the next 13th.
    expect(iso(nextRun("0 9 13 * 5", "UTC", Date.UTC(2026, 10, 14)))).toBe("2026-11-20T09:00:00.000Z");
    expect(iso(nextRun("0 9 * * 7", "UTC", Date.UTC(2026, 10, 9)))).toBe("2026-11-15T09:00:00.000Z");
  });

  test("SCHEDULE: an impossible date never fires", () => {
    expect(nextRun("0 9 31 2 *", "UTC", Date.UTC(2026, 0, 1))).toBeNull();
  });
});
