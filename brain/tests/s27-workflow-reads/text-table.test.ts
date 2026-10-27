// s27 review round 7 (PR #35): TEXT answers (screen text, plain-text connector answers) go through the SAME outcome
// pipeline and invariants as JSON, and every accepted value is exactly what the source shows. Invariants I1-I5 as in
// parser-table.test.ts, plus:
//   I8 (round 10) formatting is never data: delimiter and border lines are not rows, and a row whose every cell is
//      only punctuation, dashes or box characters is never a row;
//   I6 value fidelity: every accepted value equals the source text exactly, sign and formatting included
//      ("-25", "−25", "(25)", "+25", "1,234.50", "25.50", "1e3", "-0.0"); nothing is normalised or re-formatted.
import { describe, expect, test } from "bun:test";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { formatAxLine } from "../../src/connectors/computer/ax-text.ts";
import { readValues, type ReadOutcome } from "../../src/plan/read-source.ts";

const FIELDS = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Profit", sourceLabel: "Profit" },
];
const Q: ReadQueryDTO = { report: "Weekly metrics", fields: ["Signups", "Profit"], filters: [["period", "last 7 days"]] };

/** Values as the source shows them; each must come back exactly. */
const VALUES: Array<[string, string]> = [
  ["352", "-25"],
  ["361", "−25"],
  ["1,234.50", "(25)"],
  ["+7", "+25"],
  ["0", "25.50"],
];
type Ctx = Array<[string, string]>;
const GOOD: Ctx = [["Report", "Weekly metrics"], ["Period", "last 7 days"]];
const BAD_REPORT: Ctx = [["Report", "Monthly metrics"]];
const BAD_PERIOD: Ctx = [["Period", "last 30 days"]];
const BAD_RANGE: Ctx = [["Date range", "last 30 days"]];

/** Text renderers: context lines first ("Label: value"), then the rows. */
const RENDER: Record<string, (rows: Array<[string, string]>, ctx: Ctx) => string> = {
  "pipe table": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "Signups | Profit", ...rows.map(([a, b]) => `${a} | ${b}`)].join("\n"),
  "tab table": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "Signups\tProfit", ...rows.map(([a, b]) => `${a}\t${b}`)].join("\n"),
  "label: value lines": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), `Signups: ${rows[0]![0]}`, `Profit: ${rows[0]![1]}`].join("\n"),
  "label value lines": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), `Signups ${rows[0]![0]}`, `Profit ${rows[0]![1]}`].join("\n"),
  "label = value lines": (rows, ctx) => [...ctx.map(([k, v]) => `${k} = ${v}`), `Signups = ${rows[0]![0]}`, `Profit = ${rows[0]![1]}`].join("\n"),
  "screen outline": (rows, ctx) => ['AXStaticText "Weekly metrics"', ...ctx.map(([k, v]) => `AXStaticText "${k}: ${v}"`), `AXStaticText "Signups ${rows[0]![0]}"`, `AXStaticText "Profit ${rows[0]![1]}"`].join("\n"),
  // Round 8: the one accessibility-line format (ax-text.ts): fields with quoted values, context as label-only lines.
  "accessibility fields": (rows, ctx) => [formatAxLine("AXStaticText", "Weekly metrics"), ...ctx.map(([k, v]) => formatAxLine("AXStaticText", `${k}: ${v}`)), formatAxLine("AXTextField", "Signups", rows[0]![0]), formatAxLine("AXTextField", "Profit", rows[0]![1])].join("\n"),
  "accessibility fields, curly quotes": (rows, ctx) => ["AXStaticText “Weekly metrics”", ...ctx.map(([k, v]) => `AXStaticText “${k}: ${v}”`), `AXTextField “Signups” = “${rows[0]![0]}”`, `AXTextField “Profit” = “${rows[0]![1]}”`].join("\n"),
  // Round 10 (I8): formatting is never data: Markdown tables (outer pipes or not, alignment colons), ASCII boxes,
  // box-drawing tables, and tab tables with separator and blank lines.
  "markdown table": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "| Signups | Profit |", "|---|---:|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n"),
  "markdown, no outer pipes, aligned": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "Signups | Profit", ":--- | :---:", ...rows.map(([a, b]) => `${a} | ${b}`)].join("\n"),
  "ascii box": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "+---------+--------+", "| Signups | Profit |", "+=========+========+", ...rows.flatMap(([a, b]) => [`| ${a} | ${b} |`, "+---------+--------+"])].join("\n"),
  "box drawing": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "┌─────────┬────────┐", "│ Signups │ Profit │", "├─────────┼────────┤", ...rows.map(([a, b]) => `│ ${a} │ ${b} │`), "└─────────┴────────┘"].join("\n"),
  "tab table with separators": (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "Signups\tProfit", "-------\t------", "", ...rows.flatMap(([a, b]) => [`${a}\t${b}`, ""])].join("\n"),
  mixed: (rows, ctx) => [...ctx.map(([k, v]) => `${k}: ${v}`), "Weekly metrics · updated hourly", "Signups | Profit", ...rows.map(([a, b]) => `${a} | ${b}`), "Notes: none"].join("\n"),
};
const TABLES = new Set(["pipe table", "tab table", "mixed", "markdown table", "markdown, no outer pipes, aligned", "ascii box", "box drawing", "tab table with separators"]);

interface Case {
  name: string;
  text: string;
  kind: ReadOutcome["kind"];
  rows?: Array<[string, string]>;
  skipped?: number;
}
const cases: Case[] = [];
for (const [name, render] of Object.entries(RENDER)) {
  const rows = TABLES.has(name) ? VALUES : [VALUES[0]!];
  for (const [vi, v] of (TABLES.has(name) ? [[0, VALUES]] : VALUES.map((x, i) => [i, [x]])) as Array<[number, Array<[string, string]>]>) {
    cases.push({ name: `${name} #${vi}: no context`, text: render(v, []), kind: "ok", rows: v });
  }
  cases.push({ name: `${name}: the learned context`, text: render(rows, GOOD), kind: "ok", rows });
  cases.push({ name: `${name}: another report`, text: render(rows, BAD_REPORT), kind: "wrong_context" });
  cases.push({ name: `${name}: another period`, text: render(rows, BAD_PERIOD), kind: "wrong_context" });
  cases.push({ name: `${name}: another date range`, text: render(rows, BAD_RANGE), kind: "wrong_context" });
  cases.push({ name: `${name}: the learned report, another period`, text: render(rows, [GOOD[0]!, ...BAD_PERIOD]), kind: "wrong_context" });
}
cases.push({ name: "Codex repro P1: Report/Period lines of another report", text: "Report: Monthly metrics\nPeriod: last 30 days\nProfit: 25\nSignups: 1", kind: "wrong_context" });
cases.push({ name: "Codex repro P1: Profit -25 keeps its sign", text: "Signups 1\nProfit -25", kind: "ok", rows: [["1", "-25"]] });
cases.push({ name: "Profit: -25 keeps its sign", text: "Signups: 1\nProfit: -25", kind: "ok", rows: [["1", "-25"]] });
cases.push({ name: "a row missing a value in a table is skipped", text: "Signups | Profit\n1 | -2\n3 | ", kind: "ok", rows: [["1", "-2"]], skipped: 1 });
cases.push({ name: "a partial single answer is a skipped row", text: "Signups: 4", kind: "ok", rows: [], skipped: 1 });
cases.push({ name: "an accessibility field with an empty value is a skipped row", text: `${formatAxLine("AXTextField", "Signups", "")}\n${formatAxLine("AXTextField", "Profit", "-1")}`, kind: "ok", rows: [], skipped: 1 });
// I8: formatting is never data.
cases.push({ name: "I8 Codex repro: a Markdown delimiter row is not a row", text: "Signups | Profit\n--- | ---\n42 | 350", kind: "ok", rows: [["42", "350"]] });
cases.push({ name: "I8 a row of dashes and box characters inside the data is never a row", text: "| Signups | Profit |\n|---|---|\n| 1 | 2 |\n| — | — |\n|===|===|\n| 3 | 4 |", kind: "ok", rows: [["1", "2"], ["3", "4"]], skipped: 1 });
cases.push({ name: "text with none of the fields is unreadable", text: "Hello\nNothing to see", kind: "unreadable" });
cases.push({ name: "a period declared in a table column that differs", text: "Signups | Profit | Period\n1 | 2 | last 7 days\n3 | 4 | last 30 days", kind: "wrong_context" });

/** JSON keeps every number's own text too (no 25.50 -> 25.5, no 1e3 -> 1000). */
const JSON_CASES: Array<{ name: string; text: string; rows: Array<[string, string]> }> = [
  { name: "JSON negative numbers", text: '[{"signups": 1, "profit": -25}]', rows: [["1", "-25"]] },
  { name: "JSON decimals keep their zeros", text: '{"data": {"results": [{"signups": 25.50, "profit": -0.0}]}}', rows: [["25.50", "-0.0"]] },
  { name: "JSON exponent kept as written", text: '{"items": [{"signups": 1e3, "profit": "(25)"}]}', rows: [["1e3", "(25)"]] },
  { name: "JSON strings with signs and spacing", text: '[{"signups": "+7", "profit": "−25"}, {"signups": "1 234", "profit": "-1,234.50"}]', rows: [["+7", "−25"], ["1 234", "-1,234.50"]] },
  { name: "JSON table with negatives", text: '{"columns": ["Signups", "Profit"], "rows": [[3, -4.10], ["5", "(6)"]]}', rows: [["3", "-4.10"], ["5", "(6)"]] },
];

describe("s27 text answers: same pipeline, same invariants, exact values", () => {
  test("FETCH: the text table has 40 or more cases, every outcome kind but empty (text has no empty collection)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(["ok", "wrong_context", "unreadable"]));
  });

  for (const c of cases) {
    test(`FETCH: text ${c.name} -> ${c.kind}`, () => {
      const r = readValues(c.text, FIELDS, Q);
      expect(r.kind).toBe(c.kind);
      if (r.kind === "wrong_context") expect(r.reason).toMatch(/not the 'Weekly metrics' report for last 7 days/);
      if (r.kind !== "ok") return;
      // I2 + I6: exactly these rows, every value exactly as the source shows it.
      expect(r.rows).toEqual((c.rows ?? []).map(([a, b]) => [["Signups", a], ["Profit", b]]));
      expect(r.skipped).toHaveLength(c.skipped ?? 0);
    });
  }

  for (const c of JSON_CASES) {
    test(`FETCH: I6 ${c.name}: values exactly as written`, () => {
      const r = readValues(c.text, FIELDS, Q);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.rows).toEqual(c.rows.map(([a, b]) => [["Signups", a], ["Profit", b]]));
    });
  }
});
