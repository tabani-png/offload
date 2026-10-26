// s27 (queued for PR #35; round 13: through the one sign-in function): workflow runs get the person's Claude key the
// way the builder does. The app starts the brain with only OFFLOAD_ANTHROPIC_KEYCHAIN (the key's name, never the key);
// the Agent SDK child gets a 0700 apiKeyHelper script (builder/runner.ts writeCredentialHelper, reused) and never the
// key in its env or argv.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { agentSdkAuth } from "../../src/models/agent-auth.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import { sdkQueryOptions } from "../../src/workflows/executor.ts";
import { createGate } from "../../src/workflows/gate.ts";

const job = () => {
  const batch = makeBatch("wf_k", "live", [], 1);
  return { batch, gate: createGate({ workflowId: "wf_k", mode: "live", batch, autoRun: false, runToken: null, approvals: () => undefined }) };
};

describe("s27 executor key", () => {
  test("LIVE: with only the Keychain reference, the query gets apiKeyHelper (a 0700 script that asks the Keychain) and the child env has no key", () => {
    const a = agentSdkAuth({ PATH: "/usr/bin", HOME: "/Users/x", OFFLOAD_ANTHROPIC_KEYCHAIN: "offload-s27-test-service/none" }, () => {});
    const o = sdkQueryOptions(job(), a);
    expect(o.options.settings).toEqual({ apiKeyHelper: a.settings!.apiKeyHelper });
    const script = readFileSync(a.helper!, "utf8");
    expect(script).toContain("/usr/bin/security find-generic-password -s 'offload-s27-test-service' -a 'none' -w");
    expect(statSync(a.helper!).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(a.helper!))).mode & 0o777).toBe(0o700);
    expect(Object.keys(o.options.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    a.cleanup();
    expect(existsSync(dirname(a.helper!))).toBe(false);
  });

  test("LIVE: a key in the brain's own env reaches the child only through the helper, never its env or argv", () => {
    const a = agentSdkAuth({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-s27-not-real", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" }, () => {});
    try {
      const o = sdkQueryOptions(job(), a);
      const shown = JSON.stringify({ env: o.options.env, settings: o.options.settings, args: o.options.extraArgs ?? null });
      expect(shown).not.toContain("sk-ant-s27-not-real");
      expect(shown).not.toContain("oat-s27-not-real");
      expect(readFileSync(a.helper!.replace(/key-helper\.sh$/, "key"), "utf8")).toBe("sk-ant-s27-not-real");
    } finally {
      a.cleanup();
    }
  });
});
