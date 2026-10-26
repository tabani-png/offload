// s27 review round 15 (PR #35): table rows are split into cells BEFORE anything is trimmed, so empty first, last and
// middle cells keep their place; a row with empty field cells is a skipped row; a row with the wrong number of cells is
// skipped and named and never ends the table: later valid rows are still read (I2: a valid row is never lost).
import { describe, expect, test } from "bun:test";
import { readValues } from "../../src/plan/read-source.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Profit", sourceLabel: "Profit" },
];
const rv = (t: string): any => readValues(t, F);
const ROWS = (...r: Array<[string, string]>) => r.map(([a, b]) => [["Signups", a], ["Profit", b]]);

describe("s27 round 15: empty edge cells and wrong cell counts", () => {
  const shapes: Array<[string, (rows: string[][]) => string]> = [
    ["tab", (rows) => ["Signups\tProfit", ...rows.map((r) => r.join("\t"))].join("\n")],
    ["pipe, no outer pipes", (rows) => ["Signups | Profit", ...rows.map((r) => r.join(" | "))].join("\n")],
    ["pipe, outer pipes", (rows) => ["| Signups | Profit |", ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n")],
  ];
  for (const [name, render] of shapes) {
    test(`FETCH: ${name}: an empty first cell, then valid rows -> skipped, the rest read`, () => {
      expect(rv(render([["1", "2"], ["", "3"], ["5", "6"]]))).toEqual({ kind: "ok", rows: ROWS(["1", "2"], ["5", "6"]), skipped: [{ missing: ["Signups"] }] });
    });
    test(`FETCH: ${name}: an empty last cell, then valid rows -> skipped, the rest read`, () => {
      expect(rv(render([["1", "2"], ["4", ""], ["5", "6"]]))).toEqual({ kind: "ok", rows: ROWS(["1", "2"], ["5", "6"]), skipped: [{ missing: ["Profit"] }] });
    });
    test(`FETCH: ${name}: a row with too many cells is skipped and named; later rows are read`, () => {
      expect(rv(render([["1", "2"], ["7", "8", "9"], ["5", "6"]]))).toEqual({ kind: "ok", rows: ROWS(["1", "2"], ["5", "6"]), skipped: [{ missing: [], reason: "row 2 has 3 cells, the table has 2" }] });
    });
  }
  test("FETCH: Codex repro: Week\\tSignups with an empty first cell keeps week 44", () => {
    const r = readValues("Week\tSignups\n42\t350\n\t351\n44\t352", [{ label: "Week", sourceLabel: "Week" }, { label: "Signups", sourceLabel: "Signups" }]) as any;
    expect(r).toEqual({ kind: "ok", rows: [[["Week", "42"], ["Signups", "350"]], [["Week", "44"], ["Signups", "352"]]], skipped: [{ missing: ["Week"] }] });
  });
  test("FETCH: an empty middle cell that is not a field leaves the row whole", () => {
    expect(rv("Signups\tNote\tProfit\n1\t\t2\n3\tok\t4")).toEqual({ kind: "ok", rows: ROWS(["1", "2"], ["3", "4"]), skipped: [] });
    expect(rv("Signups | Note | Profit\n1 |  | 2\n3 | ok | 4")).toEqual({ kind: "ok", rows: ROWS(["1", "2"], ["3", "4"]), skipped: [] });
  });
  test("FETCH: a header with an unnamed first column still makes a table", () => {
    expect(rv("\tSignups\tProfit\nMon\t1\t2\nTue\t3\t4")).toEqual({ kind: "ok", rows: ROWS(["1", "2"], ["3", "4"]), skipped: [] });
  });
});
