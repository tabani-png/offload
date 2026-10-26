// s27 review round 18 (PR #35) and a hostile pass over read-source.ts: no single bad element may push the parser onto
// a looser path. Each case: what used to slip through, and the strict outcome now.
import { describe, expect, test } from "bun:test";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { readValueParts, readValues, rowsOf } from "../../src/plan/read-source.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const Q: ReadQueryDTO = { report: "Weekly metrics", fields: ["Signups", "Active users"], filters: [["period", "last 7 days"]] };
const rv = (t: string, q?: ReadQueryDTO): any => readValues(t, F, q);

describe("s27 round 18: tables by shape, and the hostile pass", () => {
  test("FETCH: Codex repro: a table with a null row is still a table; its rows are never read as a plain list", () => {
    const r = readValues('{"columns":["Other"],"rows":[{"Count":123},null]}', [{ label: "Count", sourceLabel: "Count" }]);
    expect(rowsOf(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('"123"');
  });
  test("FETCH: a null row inside a table is skipped and named; the other rows are read", () => {
    expect(rv('{"columns":["signups","active users"],"rows":[[1,2],null,[3,4]]}')).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Active", "2"]], [["Signups", "3"], ["Active", "4"]]], skipped: [{ missing: [], reason: "row 2 is not a row (null)" }] });
  });
  test("FETCH: a primitive row inside a table is skipped and named", () => {
    expect(rv('{"columns":["signups","active users"],"rows":[[1,2],"7"]}').skipped).toEqual([{ missing: [], reason: "row 2 is not a row (string)" }]);
  });
  test("FETCH: a column without a name: every row of that table is skipped and named, never read loosely", () => {
    const r = rv('{"columns":["signups",null],"rows":[[1,2]],"note":"x"}');
    expect(rowsOf(r)).toEqual([]);
    expect(r.kind === "ok" ? r.skipped : []).toEqual([{ missing: [], reason: "column 2 of the table has no name" }]);
  });
  test("FETCH: a table cell holding a nested value is skipped and named (never flattened into the row)", () => {
    expect(rv('{"columns":["signups","active_users"],"rows":[[{"signups":9},2],[3,4]]}')).toEqual({ kind: "ok", rows: [[["Signups", "3"], ["Active", "4"]]], skipped: [{ missing: [], reason: "row 1, column signups holds a nested value" }] });
  });
  test("FETCH: a plain list with null or primitive elements: those are skipped and named, never silently dropped", () => {
    expect(rv('[{"signups":1,"active_users":2},null,"x"]')).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Active", "2"]]], skipped: [{ missing: [], reason: "row 2 is not a row (null)" }, { missing: [], reason: "row 3 is not a row (string)" }] });
  });
  test("FETCH: an error next to an empty list is not an empty read ('nothing new'): it is unreadable", () => {
    expect(rv('{"error":"permission denied","results":[]}').kind).toBe("unreadable");
    expect(rv('{"error":null,"results":[]}').kind).toBe("empty");
    // In a split answer too: a text part reporting an error next to an empty structured part is not "nothing new".
    expect(readValueParts([{ kind: "text", text: "Error: permission denied" }, { kind: "json", value: { results: [] } }], F).kind).toBe("unreadable");
  });
  test("FETCH: a context nested deeper than can be checked refuses the answer", () => {
    let deep: unknown = { period: "last 30 days" };
    for (let i = 0; i < 80; i++) deep = { x: deep };
    expect(rv(JSON.stringify({ results: [{ signups: 1, active_users: 2 }], meta: deep }), Q).kind).toBe("wrong_context");
  });
  test("FETCH: JSON that is cut off or invalid is unreadable; it is never re-read as text lines", () => {
    expect(rv('{"results": [{"signups": 1, "active_users": 2}').kind).toBe("unreadable");
    expect(rv('[{"Signups": 1, "Active users": 2},').kind).toBe("unreadable");
  });
  test("FETCH: 'Label: value' pairs separated by | are read cell by cell, never one value swallowing the next", () => {
    expect(rv("Signups: 1 | Active users: 2")).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Active", "2"]]], skipped: [] });
  });
});
