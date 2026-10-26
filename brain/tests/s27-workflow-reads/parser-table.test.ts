// s27 review round 5 (PR #35): the answer parser as ONE normalizer, tested over generated shapes. Every case says
// accept (rows), skip (incomplete rows, named) or refuse (a context that is not the learned one). Invariants:
//   I1 a wrong context NEVER becomes a row (refuse => no rows at all, for that method);
//   I2 a valid row is NEVER lost silently (every complete row in the answer is in `rows`, unless the answer is refused);
//   I3 an incomplete row is never a row: it is in `skipped` with the fields it lacks (when other rows are complete) or
//      the answer reads as missing those fields (when none is).
import { describe, expect, test } from "bun:test";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { readValues } from "../../src/plan/read-source.ts";

const FIELDS = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const Q: ReadQueryDTO = { report: "Weekly metrics", fields: ["Signups", "Active users"], filters: [["period", "last 7 days"]] };

type Row = Record<string, unknown>;
const R1: Row = { signups: 352, active_users: 2410 };
const R2: Row = { signups: "361", activeUsers: "2455" };
const NULLROW: Row = { signups: null, active_users: 2500 };
const EMPTY: Row = {};
const GOOD_CTX = { report: "Weekly metrics", period: "last 7 days" };
const BAD_REPORT = { report: "Monthly metrics" };
const BAD_PERIOD = { period: "last 30 days" };
const BAD_RANGE = { date_range: "last 30 days" };

type Shape = (rows: Row[], envelope: Row) => unknown;
/** Where the rows sit; `envelope` is merged into the object right around them (context at the envelope level). */
const SHAPES: Record<string, Shape> = {
  array: (rows) => rows,
  data: (rows, env) => ({ ...env, data: rows }),
  "data.results": (rows, env) => ({ data: { ...env, results: rows } }),
  items: (rows, env) => ({ ...env, items: rows, total: rows.length }),
  "data.rows": (rows, env) => ({ data: { ...env, rows } }),
  "a.b.c.d": (rows, env) => ({ a: { b: { c: { ...env, d: rows } } } }),
  "columns+rows": (rows, env) => {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { ...env, columns: cols, rows: rows.map((r) => cols.map((c) => (c in r ? r[c] : null))) };
  },
};

interface Case {
  name: string;
  answer: unknown;
  expect: { refuse: boolean; rows: number; skipped: number };
}

const vals = (rows: Row[]) => rows;
const cases: Case[] = [];
for (const [shape, make] of Object.entries(SHAPES)) {
  // Accept: two complete rows (numbers and strings, snake and camel keys), one null row and one empty row skipped.
  cases.push({ name: `${shape}: no context`, answer: make(vals([EMPTY, R1, NULLROW, R2]), {}), expect: { refuse: false, rows: 2, skipped: 2 } });
  if (shape !== "array") {
    cases.push({ name: `${shape}: the learned context at the envelope`, answer: make([R1, R2], GOOD_CTX), expect: { refuse: false, rows: 2, skipped: 0 } });
    cases.push({ name: `${shape}: another report at the envelope`, answer: make([R1, R2], BAD_REPORT), expect: { refuse: true, rows: 0, skipped: 0 } });
    cases.push({ name: `${shape}: another period at the envelope`, answer: make([R1, R2], BAD_PERIOD), expect: { refuse: true, rows: 0, skipped: 0 } });
  }
  cases.push({ name: `${shape}: the learned context on every row`, answer: make([{ ...R1, ...GOOD_CTX }, { ...R2, ...GOOD_CTX }], {}), expect: { refuse: false, rows: 2, skipped: 0 } });
  cases.push({ name: `${shape}: one row of another report`, answer: make([R1, { ...R2, ...BAD_REPORT }], {}), expect: { refuse: true, rows: 0, skipped: 0 } });
  cases.push({ name: `${shape}: one row of another range`, answer: make([{ ...R1, ...BAD_RANGE }, R2], {}), expect: { refuse: true, rows: 0, skipped: 0 } });
}
// Top level context above a nested envelope, and the single-object answer.
cases.push({ name: "top-level wrong period above data.results", answer: { period: "last 30 days", data: { results: [R1] } }, expect: { refuse: true, rows: 0, skipped: 0 } });
cases.push({ name: "top-level right context above data.results", answer: { report: "Weekly metrics", period: "last 7 days", data: { results: [R1] } }, expect: { refuse: false, rows: 1, skipped: 0 } });
cases.push({ name: "single object", answer: { result: R1 }, expect: { refuse: false, rows: 1, skipped: 0 } });
cases.push({ name: "single object of another report", answer: { report: "Monthly metrics", ...R1 }, expect: { refuse: true, rows: 0, skipped: 0 } });
cases.push({ name: "Codex repro P1: row-level context in an array", answer: [{ report: "Monthly metrics", period: "last 30 days", signups: 352, active_users: 1 }], expect: { refuse: true, rows: 0, skipped: 0 } });
cases.push({ name: "Codex repro P2: an empty first row", answer: [{}, { signups: 352, users: 2410, active_users: 2410 }], expect: { refuse: false, rows: 1, skipped: 1 } });
cases.push({ name: "a list of tags beside the rows does not win", answer: { meta: { tags: [{ name: "x" }] }, data: { results: [R1, R2] } }, expect: { refuse: false, rows: 2, skipped: 0 } });

describe("s27 answer parser: generated shapes", () => {
  test("FETCH: the table has about 30 or more cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    test(`FETCH: ${c.name} -> ${c.expect.refuse ? "refuse" : `accept ${c.expect.rows}, skip ${c.expect.skipped}`}`, () => {
      const r = readValues(JSON.stringify(c.answer), FIELDS, Q);
      // I1: a wrong context never becomes a row.
      if (c.expect.refuse) {
        expect(r.conflict).toBeDefined();
        expect(r.rows).toEqual([]);
        return;
      }
      expect(r.conflict).toBeUndefined();
      expect(r.rows).toHaveLength(c.expect.rows);
      // I2: every value of every complete row is there, as text.
      for (const row of r.rows) {
        expect(row.map(([l]) => l)).toEqual(["Signups", "Active"]);
        for (const [, v] of row) expect(v).toMatch(/^\d+$/);
      }
      // I3: incomplete rows are skipped and named.
      expect(r.skipped ?? []).toHaveLength(c.expect.skipped);
      for (const s of r.skipped ?? []) expect(s.missing.length).toBeGreaterThan(0);
    });
  }

  test("FETCH: the parser is deterministic (same answer, same result)", () => {
    for (const c of cases) expect(readValues(JSON.stringify(c.answer), FIELDS, Q)).toEqual(readValues(JSON.stringify(c.answer), FIELDS, Q));
  });
});
