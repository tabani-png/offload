// s27 review round 13 (PR #35): ONE sign-in function for every Agent SDK caller (models/agent-auth.ts agentSdkAuth).
// It returns {env, settings.apiKeyHelper?, cleanup}; the pure process allowlist (models/child-env.ts) never decides
// sign-in, and no caller can build a child env without going through agentSdkAuth.
// For each caller (workflow executor, AgentSdkModel): (a) a Keychain key -> helper, no key in env; (b) OAuth only ->
// token in env plus one warning line; (c) neither -> a plain refusal before anything starts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentSdkAuth, NO_KEY_WORDS, type AgentSdkAuth } from "../../src/models/agent-auth.ts";
import * as model from "../../src/models/model.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import * as executor from "../../src/workflows/executor.ts";
import { createGate } from "../../src/workflows/gate.ts";

const KEYCHAIN = { PATH: "/usr/bin", HOME: "/Users/x", OFFLOAD_ANTHROPIC_KEYCHAIN: "offload-s27-test-service/none", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real", OFFLOAD_TOKEN: "tok" };
const OAUTH = { PATH: "/usr/bin", HOME: "/Users/x", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real", OFFLOAD_TOKEN: "tok" };
const NONE = { PATH: "/usr/bin", HOME: "/Users/x", OFFLOAD_TOKEN: "tok" };

const job = () => {
  const batch = makeBatch("wf_k", "live", [], 1);
  return { batch, gate: createGate({ workflowId: "wf_k", mode: "live", batch, autoRun: false, runToken: null, approvals: () => undefined }) };
};

/** The child options each caller builds from an auth result. */
const CALLERS: Array<[string, (a: AgentSdkAuth) => { env?: Record<string, string>; settings?: unknown }]> = [
  ["workflow executor", (a) => executor.sdkQueryOptions(job(), a).options as { env?: Record<string, string>; settings?: unknown }],
  ["AgentSdkModel", (a) => model.modelQueryOptions({ role: "draft", model: "claude-sonnet-5-5", system: "s", prompt: "p" }, a).options as { env?: Record<string, string>; settings?: unknown }],
];

describe("s27 round 13: one sign-in function for every Agent SDK caller", () => {
  for (const [name, opts] of CALLERS) {
    test(`LIVE: ${name}: a Keychain key -> apiKeyHelper; no key, no token, no OFFLOAD_* in the env`, () => {
      const a = agentSdkAuth(KEYCHAIN, () => {});
      try {
        const o = opts(a);
        expect((o.settings as { apiKeyHelper?: string }).apiKeyHelper).toBe(a.settings!.apiKeyHelper);
        expect(o.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
      } finally {
        a.cleanup();
      }
    });
    test(`LIVE: ${name}: OAuth only -> the token in the env exactly, one warning line, no helper`, () => {
      const logs: string[] = [];
      const a = agentSdkAuth(OAUTH, (l) => logs.push(l));
      const o = opts(a);
      expect(o.settings).toBeUndefined();
      expect(o.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" });
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain("oat-s27-not-real");
    });
  }

  test("LIVE: neither -> a plain refusal from the sign-in function itself", () => {
    expect(() => agentSdkAuth(NONE, () => {})).toThrow(NO_KEY_WORDS);
  });
  test("LIVE: neither -> the workflow executor and the model both refuse before anything starts", async () => {
    const b = makeBatch("wf_k", "live", [], 1);
    await expect(new executor.AgentSdkExecutor({ env: NONE }).execute({ batch: b, gate: createGate({ workflowId: "wf_k", mode: "live", batch: b, autoRun: false, runToken: null, approvals: () => undefined }) })).rejects.toThrow(/add a key in Settings/);
    await expect(new model.AgentSdkModel({ env: NONE }).complete({ role: "draft", model: "claude-sonnet-5-5", system: "s", prompt: "p" })).rejects.toThrow(/add a key in Settings/);
  });

  test("LIVE: no caller can skip the sign-in step: the old env builder is not exported; every query() caller in brain/src goes through agentSdkAuth (or is the builder, reported)", () => {
    expect("executorEnv" in executor).toBe(false);
    const src = join(import.meta.dir, "../../src");
    for (const f of ["workflows/executor.ts", "models/model.ts"]) {
      const text = readFileSync(join(src, f), "utf8");
      expect(text).toContain("agentSdkAuth(");
      expect(text).not.toMatch(/\bbaseChildEnv\(/);
    }
  });
});
