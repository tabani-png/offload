// s27 review round 16 (PR #35): JSON `columns + rows` tables follow the SAME row rules as text tables (one shared
// function): a row with too many or too few cells is skipped and named and later rows continue; object rows inside a
// columns table may only use the declared columns; empty and formatting-only cells and repeated column names behave
// the same in both.
import { describe, expect, test } from "bun:test";
import { readValues } from "../../src/plan/read-source.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Profit", sourceLabel: "Profit" },
];
const rv = (t: string): any => readValues(t, F);
const ROWS = (...r: Array<[string, string]>) => r.map(([a, b]) => [["Signups", a], ["Profit", b]]);

describe("s27 round 16: JSON tables share the text tables' row rules", () => {
  test("FETCH: Codex repro: an extra cell is not dropped: the row is skipped and named", () => {
    expect(readValues('{"columns":["Count"],"rows":[["123","unexpected"]]}', [{ label: "Count", sourceLabel: "Count" }])).toEqual({ kind: "ok", rows: [], skipped: [{ missing: [], reason: "row 1 has 2 cells, the table has 1" }] });
  });
  test("FETCH: too few cells: skipped and named; later rows are read", () => {
    expect(rv('{"columns":["Signups","Profit"],"rows":[["1"],["3","4"]]}')).toEqual({ kind: "ok", rows: ROWS(["3", "4"]), skipped: [{ missing: [], reason: "row 1 has 1 cell, the table has 2" }] });
  });
  test("FETCH: object rows inside a columns table may only use the declared columns", () => {
    expect(rv('{"columns":["signups","profit"],"rows":[{"signups":1,"profit":2},{"signups":3,"profit":4,"extra":5}]}')).toEqual({ kind: "ok", rows: ROWS(["1", "2"]), skipped: [{ missing: [], reason: "row 2 has keys outside the columns: extra" }] });
  });

  const PARITY: Array<[string, string, string]> = [
    ["too many cells", "Signups\tProfit\n1\t2\t9\n3\t4", '{"columns":["Signups","Profit"],"rows":[["1","2","9"],["3","4"]]}'],
    ["too few cells", "Signups | Profit\n1\n3 | 4", '{"columns":["Signups","Profit"],"rows":[["1"],["3","4"]]}'],
    ["an empty cell", "Signups\tProfit\n\t2\n3\t4", '{"columns":["Signups","Profit"],"rows":[["","2"],["3","4"]]}'],
    ["a formatting-only cell", "Signups | Profit\n— | 2\n3 | 4", '{"columns":["Signups","Profit"],"rows":[["—","2"],["3","4"]]}'],
    ["a column named twice", "Signups | Signups | Profit\n1 | 9 | 2\n3 | 3 | 4", '{"columns":["Signups","Signups","Profit"],"rows":[["1","9","2"],["3","3","4"]]}'],
  ];
  for (const [name, text, json] of PARITY) {
    test(`FETCH: parity, ${name}: the text table and the JSON table give the same outcome`, () => {
      expect(rv(json)).toEqual(rv(text));
    });
  }
});
