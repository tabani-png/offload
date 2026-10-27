// s27 review round 14 (PR #35).
// I4 for split answers: an answer in several parts (MCP text blocks, resource text, structuredContent) is ONE answer:
// every part's context declarations are collected before rows are chosen; a conflict in any part refuses it.
// I3/I5 by presence: a collection is chosen by which fields are PRESENT (even null); validity is left to the row pass,
// so rows of nulls are skipped rows, not "unreadable".
import { describe, expect, test } from "bun:test";
import type { ReadQueryDTO } from "../../src/api/s14-types.ts";
import { readValueParts, readValues } from "../../src/plan/read-source.ts";
import { mcpAnswer } from "../../src/workflows/read-fetch.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const Q: ReadQueryDTO = { report: "Weekly metrics", fields: ["Signups", "Active users"], filters: [["period", "last 7 days"]] };
const ROWS = { results: [{ signups: 352, active_users: 2410 }] };

const viaMcp = (r: { content?: unknown; structuredContent?: unknown }) => {
  const a = mcpAnswer(r);
  return readValueParts(a.parts, F, Q);
};

describe("s27 round 14: split answers are one answer (I4)", () => {
  test("FETCH: MCP text declares another report, structuredContent holds the rows -> wrong_context (Codex repro)", () => {
    expect(viaMcp({ content: [{ type: "text", text: "Report: Monthly metrics\nPeriod: last 30 days" }], structuredContent: ROWS }).kind).toBe("wrong_context");
  });
  test("FETCH: MCP text declares another period only -> wrong_context", () => {
    expect(viaMcp({ content: [{ type: "text", text: "Period: last 30 days" }], structuredContent: ROWS }).kind).toBe("wrong_context");
  });
  test("FETCH: an embedded resource declares another report, the text holds the rows -> wrong_context", () => {
    expect(viaMcp({ content: [{ type: "text", text: "Signups: 1\nActive users: 2" }, { type: "resource", resource: { uri: "x://r", text: "Report: Other report" } }] }).kind).toBe("wrong_context");
  });
  test("FETCH: structuredContent declares another report, the text holds the rows -> wrong_context", () => {
    expect(viaMcp({ content: [{ type: "text", text: "Signups: 1\nActive users: 2" }], structuredContent: { report: "Other report" } }).kind).toBe("wrong_context");
  });
  test("FETCH: the learned context in the text, rows in structuredContent -> ok, rows from structuredContent", () => {
    const r = viaMcp({ content: [{ type: "text", text: "Report: Weekly metrics\nPeriod: last 7 days" }], structuredContent: ROWS });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.rows).toEqual([[["Signups", "352"], ["Active", "2410"]]]);
  });
  test("FETCH: rows in the text and in structuredContent: the exact text wins (25.50 kept)", () => {
    const r = viaMcp({ content: [{ type: "text", text: '{"results": [{"signups": 25.50, "active_users": 1}]}' }], structuredContent: { results: [{ signups: 25.5, active_users: 1 }] } });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.rows).toEqual([[["Signups", "25.50"], ["Active", "1"]]]);
  });
  test("FETCH: no context anywhere, rows in structuredContent -> ok", () => {
    expect(viaMcp({ content: [{ type: "text", text: "Here are your numbers." }], structuredContent: ROWS }).kind).toBe("ok");
  });
});

describe("s27 round 14: choose by presence, validate later (I3, I5)", () => {
  const cases: Array<[string, unknown, { kind: string; rows?: number; skipped?: number }]> = [
    ["Codex repro: one row, the only field null", [{ Signups: null }], { kind: "ok", rows: 0, skipped: 1 }],
    ["all rows null", [{ signups: null, active_users: null }, { signups: null, active_users: null }], { kind: "ok", rows: 0, skipped: 2 }],
    ["mixed null and empty", { results: [{ signups: null, active_users: "" }, { signups: "", active_users: null }] }, { kind: "ok", rows: 0, skipped: 2 }],
    ["mixed null, empty and one complete row", { results: [{ signups: null, active_users: "" }, { signups: 1, active_users: 2 }] }, { kind: "ok", rows: 1, skipped: 1 }],
    ["nulls with a conflicting context", { period: "last 30 days", results: [{ signups: null, active_users: null }] }, { kind: "wrong_context" }],
    ["nulls under a matching context", { report: "Weekly metrics", results: [{ signups: null, active_users: null }] }, { kind: "ok", rows: 0, skipped: 1 }],
  ];
  for (const [name, answer, want] of cases) {
    test(`FETCH: ${name} -> ${want.kind}`, () => {
      const r = readValues(JSON.stringify(answer), F, Q);
      expect(r.kind as string).toBe(want.kind);
      if (r.kind === "ok") {
        expect(r.rows).toHaveLength(want.rows!);
        expect(r.skipped).toHaveLength(want.skipped!);
      }
    });
  }
});
