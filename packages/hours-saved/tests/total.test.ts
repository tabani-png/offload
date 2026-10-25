import { expect, test } from "bun:test";
import {
  baseline,
  buildRows,
  dayStartUtc,
  HoursSavedInputError,
  inPeriod,
  localDay,
  periodBoundsUtc,
  total,
  type RunInput,
  type RunOutcomeKind,
  type ReviewEvent,
} from "../src/index.ts";
import { attributed, DEPT, estimate, PERSON, prng, review, ROLE, run, sample, shuffle, WF } from "./helpers.ts";

const WA = WF(1); // observed, grade A, 300 s
const WC = WF(2); // user estimate, grade C, 600 s
const baselines = [
  { workflowId: WA, version: 1, baseline: baseline([sample(WA, 1, [300, 300, 300, 300, 300])]) },
  { workflowId: WC, version: 1, baseline: baseline([], estimate(WC, 1, 600)) },
];
const COMPANY = { type: "company", id: null } as const;
const OCT = { from: "2026-10-01", toExclusive: "2026-11-01" };

function oneRun(n: number, endedAt: number, extra: Partial<Parameters<typeof run>[0]> = {}, person = PERSON(1)): { input: RunInput; rev: ReviewEvent } {
  const r = run({ n, workflowId: WA, sent: 1, endedAt, ...extra });
  return { input: attributed(r, person, DEPT(1), ROLE(1)), rev: review(r, { review: 0 }) };
}

function rowsOf(list: { input: RunInput; rev: ReviewEvent }[]) {
  return buildRows(list.map((x) => x.input), list.map((x) => x.rev), baselines);
}

test("TOTAL: period is half-open in local days of the timezone", () => {
  const tz = "America/New_York";
  const rows = rowsOf([
    oneRun(1, Date.UTC(2026, 9, 1, 4, 0, 0)), // 2026-10-01 00:00 EDT, included
    oneRun(2, Date.UTC(2026, 9, 1, 3, 59, 59)), // 2026-09-30 23:59:59 EDT, excluded
    oneRun(3, Date.UTC(2026, 10, 1, 3, 59, 59)), // 2026-10-31 23:59:59 EDT, included
    oneRun(4, Date.UTC(2026, 10, 1, 4, 0, 0)), // 2026-11-01 00:00 EDT, excluded
  ]);
  const c = total(rows, COMPANY, OCT, tz);
  expect(c.runs.success).toBe(2);
  expect(c.seconds).toBe(600);
});

test("TOTAL: the same instants fall in different periods in different timezones", () => {
  const rows = rowsOf([oneRun(1, Date.UTC(2026, 9, 31, 23, 30, 0))]); // Oct 31 23:30 UTC = Nov 1 00:30 Berlin
  expect(total(rows, COMPANY, OCT, "UTC").runs.success).toBe(1);
  expect(total(rows, COMPANY, OCT, "Europe/Berlin").runs.success).toBe(0);
});

test("TOTAL: DST change day (US fall back, 25 h) includes its last second and excludes next midnight", () => {
  const tz = "America/Los_Angeles";
  const day = { from: "2026-11-01", toExclusive: "2026-11-02" };
  const rows = rowsOf([
    oneRun(1, Date.UTC(2026, 10, 1, 7, 0, 0)), // 00:00 PDT
    oneRun(2, Date.UTC(2026, 10, 1, 9, 30, 0)), // 01:30 PST (second 01:30)
    oneRun(3, Date.UTC(2026, 10, 2, 7, 59, 59)), // 23:59:59 PST
    oneRun(4, Date.UTC(2026, 10, 2, 8, 0, 0)), // 2026-11-02 00:00 PST
    oneRun(5, Date.UTC(2026, 10, 1, 6, 59, 59)), // 2026-10-31 23:59:59 PDT
  ]);
  expect(total(rows, COMPANY, day, tz).runs.success).toBe(3);
  const b = periodBoundsUtc(day, tz);
  expect(b.endMsExclusive - b.startMs).toBe(25 * 3600 * 1000);
});

test("TOTAL: DST change day (EU spring forward, 23 h) bounds", () => {
  const b = periodBoundsUtc({ from: "2026-03-29", toExclusive: "2026-03-30" }, "Europe/Berlin");
  expect(b.startMs).toBe(Date.UTC(2026, 2, 28, 23, 0, 0));
  expect(b.endMsExclusive - b.startMs).toBe(23 * 3600 * 1000);
});

test("TOTAL: day start in a zone whose DST gap swallows midnight (America/Santiago)", () => {
  // 2026-09-06 00:00 does not exist in Santiago (clocks jump 00:00 → 01:00); the day starts at 01:00 −03.
  const start = dayStartUtc("2026-09-06", "America/Santiago");
  expect(localDay(start, "America/Santiago")).toBe("2026-09-06");
  expect(localDay(start - 1, "America/Santiago")).toBe("2026-09-05");
});

test("TOTAL: periodBoundsUtc agrees with the local-day filter on random instants", () => {
  const rand = prng(11);
  for (const tz of ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Chatham"]) {
    const p = { from: "2026-03-01", toExclusive: "2026-11-15" };
    const b = periodBoundsUtc(p, tz);
    for (let k = 0; k < 60; k++) {
      const t = Date.UTC(2026, 0, 1) + Math.floor(rand() * 365 * 86_400_000);
      expect(inPeriod(t, p, tz)).toBe(t >= b.startMs && t < b.endMsExclusive);
    }
  }
});

test("TOTAL: unknown timezone and malformed periods are rejected", () => {
  const rows = rowsOf([oneRun(1, Date.UTC(2026, 9, 5))]);
  expect(() => total(rows, COMPANY, OCT, "Mars/Olympus")).toThrow(HoursSavedInputError);
  expect(() => total(rows, COMPANY, { from: "2026-10", toExclusive: "2026-11-01" }, "UTC")).toThrow(HoursSavedInputError);
  expect(() => total(rows, COMPANY, { from: "2026-11-01", toExclusive: "2026-10-01" }, "UTC")).toThrow(HoursSavedInputError);
});

test("TOTAL: empty period gives an all-zero cell", () => {
  const rows = rowsOf([oneRun(1, Date.UTC(2026, 9, 5))]);
  const c = total(rows, COMPANY, { from: "2026-10-05", toExclusive: "2026-10-05" }, "UTC");
  expect(c).toEqual({
    seconds: 0, hours: 0, byGrade: { A: 0, B: 0, C: 0 }, bySource: { observed: 0, user_estimate: 0 },
    byRuntime: { mac: 0, cloud: 0 }, overnightSeconds: 0, runs: { success: 0, failed: 0, cancelled: 0, rejected: 0, capped: 0 }, people: 0,
  });
});

function mixedRows() {
  const inputs: RunInput[] = [];
  const reviews: ReviewEvent[] = [];
  const outcomes: RunOutcomeKind[] = ["success", "success", "success", "failed", "cancelled", "rejected", "capped"];
  for (let i = 0; i < 70; i++) {
    const wf = i % 3 === 0 ? WC : WA;
    const r = run({
      n: i,
      workflowId: wf,
      sent: 1 + (i % 4),
      outcome: outcomes[i % outcomes.length]!,
      runtime: i % 5 === 0 ? "cloud" : "mac",
      overnight: i % 6 === 0,
      endedAt: Date.UTC(2026, 9, 1 + (i % 28), 12),
    });
    inputs.push(attributed(r, PERSON(i % 9), DEPT(i % 2), wf === WA ? ROLE(1) : ROLE(2)));
    if (i % 7 !== 1) reviews.push(review(r, { review: (i * 37) % 200 }));
  }
  return { inputs, reviews };
}

test("TOTAL: scope filters by person, department (person's) and job role (workflow's)", () => {
  const { inputs, reviews } = mixedRows();
  const rows = buildRows(inputs, reviews, baselines);
  const all = total(rows, COMPANY, OCT, "UTC");
  const d0 = total(rows, { type: "department", id: DEPT(0) }, OCT, "UTC");
  const d1 = total(rows, { type: "department", id: DEPT(1) }, OCT, "UTC");
  expect(d0.seconds + d1.seconds).toBe(all.seconds);
  const r1 = total(rows, { type: "job_role", id: ROLE(1) }, OCT, "UTC");
  const r2 = total(rows, { type: "job_role", id: ROLE(2) }, OCT, "UTC");
  expect(r1.seconds + r2.seconds).toBe(all.seconds);
  expect(r2.byGrade.C).toBe(r2.seconds);
  expect(r1.byGrade.A).toBe(r1.seconds);
  let perPerson = 0;
  for (let p = 0; p < 9; p++) {
    const c = total(rows, { type: "person", id: PERSON(p) }, OCT, "UTC");
    expect(c.people).toBeLessThanOrEqual(1);
    perPerson += c.seconds;
  }
  expect(perPerson).toBe(all.seconds);
  expect(total(rows, { type: "department", id: DEPT(7) }, OCT, "UTC").seconds).toBe(0);
});

test("TOTAL: splits each sum to the total", () => {
  const { inputs, reviews } = mixedRows();
  const c = total(buildRows(inputs, reviews, baselines), COMPANY, OCT, "UTC");
  expect(c.seconds).toBeGreaterThan(0);
  expect(c.byGrade.A + c.byGrade.B + c.byGrade.C).toBe(c.seconds);
  expect(c.bySource.observed + c.bySource.user_estimate).toBe(c.seconds);
  expect(c.byRuntime.mac + c.byRuntime.cloud).toBe(c.seconds);
  expect(c.overnightSeconds).toBeLessThanOrEqual(c.seconds);
  expect(c.runs.success + c.runs.failed + c.runs.cancelled + c.runs.rejected + c.runs.capped).toBe(70);
  expect(c.people).toBe(9);
});

test("TOTAL: shuffle invariance of rows, runs and reviews", () => {
  const { inputs, reviews } = mixedRows();
  const want = total(buildRows(inputs, reviews, baselines), COMPANY, OCT, "UTC");
  const rand = prng(99);
  for (let k = 0; k < 25; k++) {
    const rows = buildRows(shuffle(inputs, rand), shuffle(reviews, rand), shuffle(baselines, rand));
    expect(total(shuffle(rows, rand), COMPANY, OCT, "UTC")).toEqual(want);
  }
});

test("TOTAL: people counts distinct people with runs of any outcome", () => {
  const a = oneRun(1, Date.UTC(2026, 9, 3), {}, PERSON(1));
  const b = oneRun(2, Date.UTC(2026, 9, 4), { outcome: "failed" }, PERSON(2));
  const c = oneRun(3, Date.UTC(2026, 9, 5), {}, PERSON(1));
  expect(total(rowsOf([a, b, c]), COMPANY, OCT, "UTC").people).toBe(2);
});

test("TOTAL: overnight seconds and runtime split come from the run", () => {
  const a = oneRun(1, Date.UTC(2026, 9, 3), { overnight: true, runtime: "cloud", sent: 2 });
  const b = oneRun(2, Date.UTC(2026, 9, 4), { sent: 1 });
  const c = total(rowsOf([a, b]), COMPANY, OCT, "UTC");
  expect([c.seconds, c.overnightSeconds, c.byRuntime.cloud, c.byRuntime.mac]).toEqual([900, 600, 600, 300]);
});

test("TOTAL: a run listed twice is an input error", () => {
  const a = oneRun(1, Date.UTC(2026, 9, 3));
  expect(() => buildRows([a.input, a.input], [], baselines)).toThrow(HoursSavedInputError);
});

test("TOTAL: runs of a workflow version with no baseline contribute 0", () => {
  const r = run({ n: 1, workflowId: WF(77), sent: 10, endedAt: Date.UTC(2026, 9, 3) });
  const rows = buildRows([attributed(r, PERSON(1), null, null)], [review(r, { review: 1 })], baselines);
  expect(rows[0]!.source).toBe("default");
  expect(total(rows, COMPANY, OCT, "UTC")).toMatchObject({ seconds: 0, runs: { success: 1 }, people: 1 });
});
