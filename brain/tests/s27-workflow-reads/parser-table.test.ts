// s27 review round 5 (PR #35): the answer parser as ONE normalizer, tested over generated shapes. Every case says
// accept (rows), skip (incomplete rows, named) or refuse (a context that is not the learned one). Invariants:
//   I1 a wrong context NEVER becomes a row (refuse => no rows at all, for that method);
//   I2 a valid row is NEVER lost silently (every complete row in the answer is in `rows`, unless the answer is refused);
//   I3 an incomplete row is never a row: it is in `skipped` with the fields it lacks, whatever the complete count;
//   I4 (round 6) a conflicting context ANYWHERE in the answer (any depth, any row, any alias) refuses it, even next to
//      a matching context at another depth;
//   I5 (round 6) a recognised empty collection is an `empty` read (nothing new), never a failure that falls back.
import { describe, expect, test } from "bun:test";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { readValues, type ReadOutcome } from "../../src/plan/read-source.ts";
import { chainStep, marksFailed } from "../../src/workflows/read-fetch.ts";

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
  expect: { refuse: boolean; rows: number; skipped: number; kind?: ReadOutcome["kind"] };
}

const cases: Case[] = [];
for (const [shape, make] of Object.entries(SHAPES)) {
  // Accept: two complete rows (numbers and strings, snake and camel keys), one null row and one empty row skipped.
  cases.push({ name: `${shape}: no context`, answer: make([EMPTY, R1, NULLROW, R2], {}), expect: { refuse: false, rows: 2, skipped: 2 } });
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
// Round 6, I4: a conflicting context at each depth 0-4 (4 = on the row), with the learned context at another depth.
const ctxAt = (d: number, ctx: Row, rows: Row[]): unknown => {
  const levels: Row[] = [{}, {}, {}, {}];
  if (d < 4) Object.assign(levels[d]!, ctx);
  const rs = d === 4 ? rows.map((r, i) => (i === rows.length - 1 ? { ...r, ...ctx } : r)) : rows;
  return { ...levels[0], a: { ...levels[1], b: { ...levels[2], c: { ...levels[3], d: rs } } } };
};
const merge = (x: unknown, d: number, ctx: Row): unknown => {
  // put `ctx` at depth d of an answer built by ctxAt (0 root, 1 a, 2 b, 3 c, 4 every row)
  const o = JSON.parse(JSON.stringify(x));
  const at = [o, o.a, o.a.b, o.a.b.c];
  if (d < 4) Object.assign(at[d], ctx);
  else for (const r of o.a.b.c.d) Object.assign(r, ctx);
  return o;
};
for (let bad = 0; bad <= 4; bad++) {
  for (let good = 0; good <= 4; good++) {
    if (good === bad) continue;
    const conflict = bad % 2 === 0 ? { report: "Other report" } : { period: "last 30 days" };
    cases.push({ name: `I4: conflict at depth ${bad}, the learned context at depth ${good}`, answer: merge(ctxAt(bad, conflict, [R1, R2]), good, GOOD_CTX), expect: { refuse: true, rows: 0, skipped: 0 } });
  }
}
cases.push({ name: "Codex repro round 6 P1: nested report under a matching top level", answer: { report: "Weekly metrics", data: { report: "Other report", Signups: 123, active_users: 1 } }, expect: { refuse: true, rows: 0, skipped: 0 } });
cases.push({ name: "a period column in a table that differs", answer: { columns: ["signups", "active_users", "period"], rows: [[1, 2, "last 7 days"], [3, 4, "last 30 days"]] }, expect: { refuse: true, rows: 0, skipped: 0 } });
// Round 6, I3: every row incomplete is still a read: 0 rows, all skipped.
cases.push({ name: "every row incomplete", answer: [{ signups: null, active_users: 1 }, {}], expect: { refuse: false, rows: 0, skipped: 2, kind: "ok" } });
// Round 6, I5: recognised empty collections.
for (const [n, a] of [["[]", []], ["{results: []}", { results: [] }], ["{data: {rows: []}}", { data: { rows: [] } }], ["empty table", { columns: ["signups"], rows: [] }], ["{items: [], next: null}", { items: [], next: null }]] as const)
  cases.push({ name: `empty: ${n}`, answer: a, expect: { refuse: false, rows: 0, skipped: 0, kind: "empty" } });
// No recognisable rows at all: unreadable (the only kind that falls back).
for (const [n, a] of [["{foo: bar}", { foo: "bar" }], ["rows without any field", { results: [{ name: "x" }] }], ["an error object", { error: "not found", status: 404 }]] as const)
  cases.push({ name: `unreadable: ${n}`, answer: a, expect: { refuse: false, rows: 0, skipped: 0, kind: "unreadable" } });

describe("s27 answer parser: generated shapes", () => {
  test("FETCH: the table has about 30 or more cases, with every outcome kind", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.expect.kind ?? (c.expect.refuse ? "wrong_context" : "ok")))).toEqual(new Set(["ok", "empty", "wrong_context", "unreadable"]));
  });

  for (const c of cases) {
    const kind: ReadOutcome["kind"] = c.expect.kind ?? (c.expect.refuse ? "wrong_context" : "ok");
    test(`FETCH: ${c.name} -> ${kind}${kind === "ok" ? ` (${c.expect.rows} rows, ${c.expect.skipped} skipped)` : ""}`, () => {
      const r = readValues(JSON.stringify(c.answer), FIELDS, Q);
      expect(r.kind).toBe(kind);
      // I1/I4: a wrong context never becomes a row (and says why).
      if (r.kind === "wrong_context") {
        expect(r.reason).toMatch(/not the 'Weekly metrics' report for last 7 days/);
        return;
      }
      if (r.kind !== "ok") return;
      // I2: exactly the complete rows, every value there.
      expect(r.rows).toHaveLength(c.expect.rows);
      for (const row of r.rows) {
        expect(row.map(([l]) => l)).toEqual(["Signups", "Active"]);
        for (const [, v] of row) expect(v).toMatch(/^\d+$/);
      }
      // I3: incomplete rows are skipped and named, whatever the complete count.
      expect(r.skipped).toHaveLength(c.expect.skipped);
      for (const sk of r.skipped) expect(sk.missing.length).toBeGreaterThan(0);
    });
  }

  test("FETCH: the outcome -> chain mapping: ok and empty stop the chain (never the list); wrong_context marks the method failed and tries the next; only unreadable falls through", () => {
    expect([chainStep("ok"), chainStep("empty"), chainStep("wrong_context"), chainStep("unreadable")]).toEqual(["stop", "stop", "next", "next"]);
    expect([marksFailed("ok"), marksFailed("empty"), marksFailed("wrong_context"), marksFailed("unreadable")]).toEqual([false, false, true, false]);
  });

  test("FETCH: the parser is deterministic (same answer, same result)", () => {
    for (const c of cases) expect(readValues(JSON.stringify(c.answer), FIELDS, Q)).toEqual(readValues(JSON.stringify(c.answer), FIELDS, Q));
  });
});
