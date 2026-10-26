// s27 review round 21 (PR #35): an object that directly holds a wanted field is a ROW (its status / ok / error keys
// are data, like a list item's), at any depth; an object without a wanted field is an envelope (its error keys are
// signals). An envelope error ABOVE a row still makes the answer unreadable.
import { describe, expect, test } from "bun:test";
import { readValues } from "../../src/plan/read-source.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const KEYS: Array<[string, Record<string, unknown>]> = [
  ["status failed", { status: "failed" }],
  ["ok false", { ok: false }],
  ["error x", { error: "x" }],
  ["errors list", { errors: ["x"] }],
];
const wrap = (depth: number, inner: unknown): unknown => {
  let v = inner;
  for (let i = 0; i < depth; i++) v = { data: v };
  return v;
};

describe("s27 round 21: rows vs envelopes (I5b)", () => {
  test("FETCH: Codex repro: a single-object answer with status failed is a row and reads", () => {
    expect(readValues('{"signups":1,"active_users":2,"status":"failed"}', F)).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Active", "2"]]], skipped: [] });
  });
  for (const [name, key] of KEYS)
    for (let depth = 0; depth <= 4; depth++) {
      test(`FETCH: I5b a single-object row with ${name} at depth ${depth} reads`, () => {
        const r = readValues(JSON.stringify(wrap(depth, { signups: 1, active_users: 2, ...key })), F);
        expect(r).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Active", "2"]]], skipped: [] });
      });
      if (depth >= 1)
        test(`FETCH: I5b ${name} on the envelope just above a row at depth ${depth} -> unreadable`, () => {
          let v: unknown = { signups: 1, active_users: 2 };
          v = { ...key, data: v };
          v = wrap(depth - 1, v);
          expect(readValues(JSON.stringify(v), F).kind).toBe("unreadable");
        });
    }
});
