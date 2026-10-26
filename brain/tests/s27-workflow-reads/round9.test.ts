// s27 review round 9 (PR #35).
// 1. Claude sign-in for workflow runs (manager decision, BYOK API key first):
//    an API key (Keychain reference, or the brain's own env) -> apiKeyHelper, no key and no OAuth token in the env;
//    no API key but a Claude Code OAuth token -> the token in the child env exactly as before (never as an API key
//    through apiKeyHelper), with one warning line in the brain log; neither -> no helper, no env, a plain refusal.
// 2. Composio answers reach the exact parser as the raw text the CLI printed (no JSON.parse/stringify round trip).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { LinkRunner } from "../../src/connectors/link.ts";
import { readValues } from "../../src/plan/read-source.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import { AgentSdkExecutor, executorAuth, sdkQueryOptions } from "../../src/workflows/executor.ts";
import { createGate } from "../../src/workflows/gate.ts";
import { ComposioSourceReader } from "../../src/workflows/read-fetch.ts";

const job = () => {
  const batch = makeBatch("wf_k", "live", [], 1);
  return { batch, gate: createGate({ workflowId: "wf_k", mode: "live", batch, autoRun: false, runToken: null, approvals: () => undefined }) };
};

describe("s27 round 9: Claude sign-in for workflow runs", () => {
  test("LIVE: an API key (Keychain) with an OAuth token also set: the key through apiKeyHelper; neither the key nor the token in the env", () => {
    const env = { PATH: "/usr/bin", OFFLOAD_ANTHROPIC_KEYCHAIN: "offload-s27-test-service/none", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" };
    const logs: string[] = [];
    const a = executorAuth(env, (l) => logs.push(l));
    expect(a.kind).toBe("api_key");
    if (a.kind !== "api_key") return;
    try {
      const o = sdkQueryOptions(job(), env, a.credential, false);
      expect((o.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBe(a.credential.command);
      expect(JSON.stringify(o.options.env)).not.toContain("oat-s27-not-real");
      expect(readFileSync(a.credential.helper, "utf8")).not.toContain("oat-s27-not-real");
      expect(logs).toEqual([]);
    } finally {
      a.credential.cleanup();
    }
  });

  test("LIVE: an API key in the brain's env with an OAuth token: the helper hands over the API key, never the token", () => {
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-s27-not-real", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" };
    const a = executorAuth(env, () => {});
    expect(a.kind).toBe("api_key");
    if (a.kind !== "api_key") return;
    try {
      const dir = a.credential.helper.replace(/key-helper\.sh$/, "");
      expect(readFileSync(`${dir}key`, "utf8")).toBe("sk-ant-s27-not-real");
    } finally {
      a.credential.cleanup();
    }
  });

  test("LIVE: only an OAuth token: no apiKeyHelper; the token reaches the child env exactly as before; one warning line", () => {
    const env = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" };
    const logs: string[] = [];
    const a = executorAuth(env, (l) => logs.push(l));
    expect(a.kind).toBe("oauth");
    const o = sdkQueryOptions(job(), env, null, true);
    expect(o.options.settings).toBeUndefined();
    expect(o.options.env).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/OAuth/);
    expect(logs[0]).not.toContain("oat-s27-not-real");
  });

  test("LIVE: neither an API key nor a token: no helper, no env key, and the run is refused in plain words before anything starts", async () => {
    expect(executorAuth({ PATH: "/usr/bin" }, () => {}).kind).toBe("none");
    await expect(new AgentSdkExecutor({ env: { PATH: "/usr/bin" } }).execute(job())).rejects.toThrow(/add a key in Settings/);
  });
});

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
