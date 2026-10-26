// s27 review round 9 (PR #35).
// 1. Claude sign-in for workflow runs (manager decision, BYOK API key first):
//    an API key (Keychain reference, or the brain's own env) -> apiKeyHelper, no key and no OAuth token in the env;
//    no API key but a Claude Code OAuth token -> the token in the child env exactly as before (never as an API key
//    through apiKeyHelper), with one warning line in the brain log; neither -> no helper, no env, a plain refusal.
// 2. Composio answers reach the exact parser as the raw text the CLI printed (no JSON.parse/stringify round trip).
import { describe, expect, test } from "bun:test";
import type { LinkRunner } from "../../src/connectors/link.ts";
import { readValues } from "../../src/plan/read-source.ts";
import { ComposioSourceReader } from "../../src/workflows/read-fetch.ts";

// Round 13: the sign-in cases moved to round13.test.ts and executor-key.test.ts (the one sign-in function, every caller).

describe("s27 round 9: Composio answers are read exactly", () => {
  test("FETCH: the CLI's raw text reaches the exact parser: decimals, big integers and duplicate keys survive", async () => {
    const stdout = '{"successful": true, "data": {"results": [{"signups": 25.50, "active_users": 12345678901234567890}, {"signups": 1, "signups": 2, "active_users": 3}]}, "error": null}';
    const runner: LinkRunner = { run: async () => ({ code: 0, stdout, stderr: "", timedOut: false }) };
    const reader = new ComposioSourceReader({ runner, env: {} });
    const state = { method: "composio", health: "ok", code: "ok", reason: null, reads: ["composio.read"], writes: [], tools: { "composio.read": "mcp__composio_cli__POSTHOG_GET_INSIGHT" }, latencyMs: 0, info: { account: "acct_1" }, checkedAt: 0, lastError: null, failedAt: null } as any;
    const text = await reader.read({ target: { id: "web-us-posthog-com" } as any, state, source: {} as any, args: {}, call: async (_t, _i, run) => run() });
    const r = readValues(text, [{ label: "Signups", sourceLabel: "Signups" }, { label: "Active", sourceLabel: "Active users" }]);
    expect(r).toEqual({ kind: "ok", rows: [[["Signups", "25.50"], ["Active", "12345678901234567890"]]], skipped: [{ missing: [], ambiguous: ["Signups"] }] });
  });

  test("FETCH: a Composio answer that is not successful is a failed read, not data", async () => {
    const runner: LinkRunner = { run: async () => ({ code: 0, stdout: '{"successful": false, "data": {"signups": 1}, "error": "no access"}', stderr: "", timedOut: false }) };
    const reader = new ComposioSourceReader({ runner, env: {} });
    const state = { method: "composio", reads: ["composio.read"], tools: { "composio.read": "mcp__composio_cli__POSTHOG_GET_INSIGHT" }, info: { account: "acct_1" } } as any;
    await expect(reader.read({ target: { id: "web-us-posthog-com" } as any, state, source: {} as any, args: {}, call: async (_t, _i, run) => run() })).rejects.toThrow(/did not read/);
  });
});
