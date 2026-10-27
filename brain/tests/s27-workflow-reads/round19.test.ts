// s27 review round 19 (PR #35).
// 1. `__proto__`, `constructor` and `prototype` in an answer are plain data: their context is checked like any other.
// 2. Object-shaped table rows follow the same scalar-cell rule as array rows: a nested value is skipped and named.
// 3. A table header is decided by structure (the first table line), never because later lines look "wordy": text-only
//    tables are read, learned from and matched.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixture, type FixtureDay } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { fillFromSource, findReadSource, parseCommitRows, parseCommitValues, readValues } from "../../src/plan/read-source.ts";
import { dashboardDays, SEED, sheetValues, WED_EVENING } from "./setup.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const Q: ReadQueryDTO = { report: "Weekly metrics", fields: ["Signups", "Active users"], filters: [["period", "last 7 days"]] };
const ROWS = '"results":[{"signups":1,"active_users":2}]';

describe("s27 round 19: prototype keys are plain data", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const at = [
      `{"${key}":{"report":"Wrong"},${ROWS}}`,
      `{"meta":{"${key}":{"period":"last 30 days"}},${ROWS}}`,
      `{"results":[{"signups":1,"active_users":2,"${key}":{"report":"Wrong"}}]}`,
      `{"a":{"b":{"c":{"${key}":{"report":"Wrong"}}}},${ROWS}}`,
    ];
    at.forEach((json, depth) => {
      test(`FETCH: a conflicting context under "${key}" (case ${depth}) refuses the answer`, () => {
        expect(readValues(json, F, Q).kind).toBe("wrong_context");
      });
    });
  }
  test("FETCH: a field under __proto__ is plain data, not a hidden value", () => {
    const r = readValues('{"__proto__":{"signups":9},"results":[{"signups":1,"active_users":2}]}', F, Q);
    expect(r.kind).toBe("ok");
  });
});

describe("s27 round 19: object table rows hold only values", () => {
  test("FETCH: Codex repro: an object row whose cell is an object is skipped and named, never flattened", () => {
    const r = readValues('{"columns":["Week","Signups"],"rows":[{"Week":{"Week":"42"},"Signups":"350"},{"Week":"43","Signups":"351"}]}', [{ label: "Week", sourceLabel: "Week" }, { label: "Signups", sourceLabel: "Signups" }]);
    expect(r).toEqual({ kind: "ok", rows: [[["Week", "43"], ["Signups", "351"]]], skipped: [{ missing: [], reason: "row 1, column Week holds a nested value" }] });
  });
  test("FETCH: a list in an object row cell is skipped too", () => {
    const r = readValues('{"columns":["signups","active users"],"rows":[{"signups":[1],"active users":2}]}', F) as any;
    expect(r.skipped).toEqual([{ missing: [], reason: "row 1, column signups holds a nested value" }]);
  });
});

describe("s27 round 19: headers by structure, text-only tables", () => {
  const NC = [
    { label: "Name", sourceLabel: "Name" },
    { label: "Country", sourceLabel: "Country" },
  ];
  test("FETCH: Name | Country with word rows is read (no delimiter line)", () => {
    expect(readValues("Name | Country\nAlice | Canada\nBob | Peru", NC)).toEqual({ kind: "ok", rows: [[["Name", "Alice"], ["Country", "Canada"]], [["Name", "Bob"], ["Country", "Peru"]]], skipped: [] });
  });
  test("FETCH: the same with a Markdown delimiter line and with tabs", () => {
    expect(readValues("| Name | Country |\n|---|---|\n| Alice | Canada |", NC)).toEqual({ kind: "ok", rows: [[["Name", "Alice"], ["Country", "Canada"]]], skipped: [] });
    expect(readValues("Name\tCountry\nAlice\tCanada", NC)).toEqual({ kind: "ok", rows: [[["Name", "Alice"], ["Country", "Canada"]]], skipped: [] });
  });
  test("FETCH: the commit-screen parse reads word rows as typed values (learning and matching)", () => {
    expect(parseCommitValues(["Name | Country\nAlice | Canada"])).toEqual([["Name", "Alice"], ["Country", "Canada"]]);
    // A word data row is never taken for a second header.
    expect(parseCommitValues(["Name | Country\nAlice | Canada\nBob | Peru"])).toEqual([["Name", "Alice"], ["Country", "Canada"]]);
    expect(parseCommitRows(["Name | Country\nAlice | Canada\nBob | Peru"]).map((m) => [...m.entries()])).toEqual([[["Name", "Alice"], ["Country", "Canada"]], [["Name", "Bob"], ["Country", "Peru"]]]);
  });
  test("DRYRUN: a past instance with word values is matched to its source row", () => {
    const src = { targetName: "CRM", fields: [{ label: "Name", sourceLabel: "Name", support: 3 }, { label: "Country", sourceLabel: "Country", support: 3 }] } as any;
    const b = fillFromSource(src, "Name | Country\nAlice | Canada\nBob | Peru", ["Name | Country\nBob | Peru"], { outputType: "rows", verb: "update", object: "row" });
    expect(b.ours.fields).toEqual([{ label: "Name", value: "Bob" }, { label: "Country", value: "Peru" }]);
  });

  let home = "";
  afterEach(() => {
    if (home !== "") rmSync(home, { recursive: true, force: true });
    home = "";
  });
  test("SOURCE: learning works with text-only values: the source is found and its fields are the word columns", async () => {
    const NAMES = ["Alice", "Bruno", "Chen", "Dana", "Emeka", "Farah", "Goran", "Hana", "Ivan", "Jules", "Kofi", "Lena"];
    const COUNTRIES = ["Canada", "Peru", "Kenya", "Japan", "Chile", "Norway", "Ghana", "Spain", "Egypt", "Nepal", "Italy", "Fiji"];
    let n = 0;
    const days: FixtureDay[] = dashboardDays()
      .slice(0, 3)
      .map((d) => {
        let lastValues: string[] | null = null;
        const out = d.events.map((e) => {
          if (e.kind !== "ocr") return e;
          if ((e.text ?? "").startsWith("Weekly metrics")) {
            n += 1;
            lastValues = [NAMES[n % NAMES.length]!, COUNTRIES[n % COUNTRIES.length]!];
            return { ...e, text: `Weekly metrics\nName ${lastValues[0]}\nCountry ${lastValues[1]}` };
          }
          if (sheetValues(e.text ?? "") !== null && lastValues !== null) return { ...e, text: `Name | Country\n${lastValues[0]} | ${lastValues[1]}` };
          return e;
        });
        return { day: d.day, events: out };
      });
    home = mkdtempSync(join(tmpdir(), "offload-s27-words-"));
    writeFixture(home, days, { encrypted: false, seed: SEED });
    const a = await analyzeHome(home, { now: () => WED_EVENING });
    const task = a.insights.find((i) => /Team metrics/.test(i.label.name))!;
    const s = findReadSource(a, task.taskId)!;
    expect(s).not.toBeNull();
    expect(s.fields.map((f) => [f.label, f.sourceLabel])).toEqual([["Name", "Name"], ["Country", "Country"]]);
  });
});
