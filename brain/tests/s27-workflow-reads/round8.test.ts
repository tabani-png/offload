// s27 review round 8 (PR #35): repeated keys and accessibility lines.
//   I4 (extended) every context declaration counts, repeated or not: one conflicting repeat refuses the answer;
//   I7 a repeated key never silently picks one value: two different values for the same field in one row make that
//      row skipped as ambiguous (named), in text and JSON (literal duplicates, nested copies, snake/camel twins).
// Accessibility lines have ONE format, written and read in one place (connectors/computer/ax-text.ts): the stub
// driver and the real driver emit it, the parser reads it; quoted labels and values with escaped or curly quotes.
import { describe, expect, test } from "bun:test";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { formatAxLine, parseAxLine } from "../../src/connectors/computer/ax-text.ts";
import { StubDriver } from "../../src/connectors/computer/driver.ts";
import { readValues } from "../../src/plan/read-source.ts";

const FIELDS = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Profit", sourceLabel: "Profit" },
];
const Q: ReadQueryDTO = { report: "Weekly metrics", fields: ["Signups", "Profit"], filters: [["period", "last 7 days"]] };
const rv = (t: string): any => readValues(t, FIELDS, Q);

describe("s27 round 8: repeated keys (I4, I7)", () => {
  const body = ["Signups: 12", "Profit: -3"];
  const good = "Report: Weekly metrics";
  const bad = "Report: Other report";
  for (let pos = 0; pos <= body.length; pos++) {
    for (const order of [[good, bad], [bad, good]]) {
      const lines = [...body];
      lines.splice(pos, 0, ...order);
      test(`FETCH: I4 a repeated report, one conflicting, at position ${pos} (${order[0] === good ? "good first" : "bad first"}) -> wrong_context`, () => {
        expect(rv(lines.join("\n")).kind).toBe("wrong_context");
      });
    }
    const lines = [...body];
    lines.splice(pos, 0, "Period: last 7 days", "Period: last 30 days");
    test(`FETCH: I4 a repeated period, one conflicting, at position ${pos} -> wrong_context`, () => {
      expect(rv(lines.join("\n")).kind).toBe("wrong_context");
    });
  }
  test("FETCH: I4 a repeated matching context is fine", () => {
    expect(rv("Report: Weekly metrics\nReport: Weekly metrics\nSignups: 12\nProfit: -3")).toEqual({ kind: "ok", rows: [[["Signups", "12"], ["Profit", "-3"]]], skipped: [] });
  });

  const ambiguous = { kind: "ok", rows: [], skipped: [{ missing: [], ambiguous: ["Signups"] }] };
  const cases: Array<[string, string]> = [
    ["text: Label: value twice", "Signups: 12\nSignups: 13\nProfit: 1"],
    ["text: Label value twice", "Signups 12\nSignups 13\nProfit 1"],
    ["text: mixed forms", "Signups: 12\nProfit 1\nSignups = 13"],
    ["text: a table header naming a field twice", "Signups | Signups | Profit\n12 | 13 | 1"],
    ["text: accessibility lines", `${formatAxLine("AXTextField", "Signups", "12")}\n${formatAxLine("AXTextField", "Signups", "13")}\n${formatAxLine("AXTextField", "Profit", "1")}`],
    ["JSON: a literal duplicate key", '{"signups": 12, "signups": 13, "profit": 1}'],
    ["JSON: a nested copy with another value", '[{"signups": 12, "profit": 1, "meta": {"signups": 13}}]'],
    ["JSON: snake and camel twins", '[{"signups": 12, "Signups": 13, "profit": 1}]'],
  ];
  for (const [name, text] of cases) {
    test(`FETCH: I7 ${name} -> the row is skipped as ambiguous, never first-wins`, () => {
      expect(rv(text)).toEqual(ambiguous);
    });
  }
  test("FETCH: I7 the same value repeated is not ambiguous", () => {
    expect(rv("Signups: 12\nSignups: 12\nProfit: 1").rows).toEqual([[["Signups", "12"], ["Profit", "1"]]]);
    expect(rv('{"signups": 12, "signups": 12, "profit": 1}').rows).toEqual([[["Signups", "12"], ["Profit", "1"]]]);
  });
  test("FETCH: I7 in a list only the ambiguous row is skipped; the others are rows", () => {
    expect(rv('[{"signups": 1, "profit": 2}, {"signups": 3, "signups": 4, "profit": 5}]')).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Profit", "2"]]], skipped: [{ missing: [], ambiguous: ["Signups"] }] });
  });
});

describe("s27 round 8: accessibility lines, one format", () => {
  const samples: Array<[string, string, string | undefined]> = [
    ["AXTextField", "Signups", "352"],
    ["AXTextField", "Active users", "-2,410"],
    ["AXTextField", "Signups", ""],
    ["AXStaticText", 'Report: "Weekly" metrics', undefined],
    ["AXTextField", "Note", 'say "hi" \\ bye'],
    ["AXStaticText", "Ünïcode label · ok", undefined],
    ["AXTextField", "Profit", "(25)"],
  ];
  for (const [role, label, value] of samples) {
    test(`FETCH: ax-text round trip: ${role} ${JSON.stringify(label)}${value === undefined ? "" : ` = ${JSON.stringify(value)}`}`, () => {
      expect(parseAxLine(formatAxLine(role, label, value))).toEqual({ role, label, value: value ?? null });
    });
  }
  test("FETCH: curly quotes and straight quotes both read", () => {
    expect(parseAxLine("AXTextField “Signups” = “352”")).toEqual({ role: "AXTextField", label: "Signups", value: "352" });
    expect(parseAxLine('AXTextField "Signups" = "352"')).toEqual({ role: "AXTextField", label: "Signups", value: "352" });
    expect(parseAxLine("plain text")).toBeNull();
  });
  test("FETCH: the stub driver's readUi output reads back: values kept exactly, an empty value is a skipped row", async () => {
    const d = new StubDriver([
      { id: "a", role: "AXTextField", title: "Signups", editable: true, value: "352", x: 0, y: 0, w: 1, h: 1 },
      { id: "b", role: "AXTextField", title: "Profit", editable: true, value: "-25", x: 0, y: 0, w: 1, h: 1 },
      { id: "c", role: "AXStaticText", title: "Weekly metrics", editable: false, x: 0, y: 0, w: 1, h: 1 },
    ]);
    expect(rv(await d.readUi())).toEqual({ kind: "ok", rows: [[["Signups", "352"], ["Profit", "-25"]]], skipped: [] });
    d.elements[0]!.value = "";
    expect(rv(await d.readUi())).toEqual({ kind: "ok", rows: [], skipped: [{ missing: ["Signups"] }] });
  });
});
