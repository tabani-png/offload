// s27 review round 20 (PR #35), I5b: an error signal ANYWHERE in the answer (any depth 0-4 of any envelope, any
// part) makes it unreadable, decided before empty or ok: the chain moves on, never "nothing new" from a failed call.
// Row data is data: a row's own "status: failed" field is a value, not an error signal.
import { describe, expect, test } from "bun:test";
import { readValueParts, readValues } from "../../src/plan/read-source.ts";

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const SIGNALS: Array<[string, Record<string, unknown>]> = [
  ["error text", { error: "permission denied" }],
  ["errors list", { errors: [{ message: "denied" }] }],
  ["ok false", { ok: false }],
  ["success false", { success: false }],
  ["successful false", { successful: false }],
  ["status failed", { status: "failed" }],
  ["status error", { status: "error" }],
  ["message with a code", { message: "Forbidden", code: 403 }],
];
const RESULTS: Array<[string, unknown]> = [
  ["an empty list", []],
  ["complete rows", [{ signups: 1, active_users: 2 }]],
  ["only skipped rows", [{ signups: null, active_users: 2 }]],
];
/** The signal at envelope depth d (0 = the top), the results at the top. */
function at(depth: number, signal: Record<string, unknown>, results: unknown): unknown {
  let env: Record<string, unknown> = { ...signal };
  for (let i = 0; i < depth; i++) env = { meta: env };
  return { ...env, results };
}

describe("s27 round 20: errors anywhere (I5b)", () => {
  test("FETCH: Codex repro: an error one level down next to empty results is unreadable, not empty", () => {
    expect(readValues('{"data":{"error":"permission denied","results":[]},"results":[]}', F).kind).toBe("unreadable");
  });
  for (const [sname, signal] of SIGNALS)
    for (const [rname, results] of RESULTS)
      for (let depth = 0; depth <= 4; depth++)
        test(`FETCH: I5b ${sname} at depth ${depth} next to ${rname} -> unreadable`, () => {
          const r = readValues(JSON.stringify(at(depth, signal, results)), F);
          expect(r.kind).toBe("unreadable");
        });
  test("FETCH: I5b an error in another part (text) next to JSON rows -> unreadable", () => {
    expect(readValueParts([{ kind: "text", text: "Error: rate limited" }, { kind: "json", value: { results: [{ signups: 1, active_users: 2 }] } }], F).kind).toBe("unreadable");
    expect(readValueParts([{ kind: "json", value: { results: [] } }, { kind: "json", value: { meta: { status: "failed" } } }], F).kind).toBe("unreadable");
  });
  test("FETCH: no error: a successful Composio envelope, a row whose own status is 'failed', and errors: 0 all read", () => {
    expect(readValues('{"successful":true,"error":null,"data":{"results":[{"signups":1,"active_users":2}]}}', F).kind).toBe("ok");
    expect(readValues('{"results":[{"signups":1,"active_users":2,"status":"failed"}]}', F).kind).toBe("ok");
    expect(readValues('{"errors":0,"ok":true,"status":"ok","results":[{"signups":1,"active_users":2}]}', F).kind).toBe("ok");
    expect(readValues('{"results":[]}', F).kind).toBe("empty");
    // A field the read asks for is data: an "Errors" metric is a value, not an error signal.
    expect(readValues("Errors: 12\nSignups: 3", [{ label: "Errors", sourceLabel: "Errors" }, { label: "Signups", sourceLabel: "Signups" }]).kind).toBe("ok");
  });
});
