// s27 (queued for PR #35): workflow runs get the person's Claude key the way the builder does. The app starts the
// brain with only OFFLOAD_ANTHROPIC_KEYCHAIN (the key's name, never the key); the Agent SDK child gets a 0700
// apiKeyHelper script (builder/runner.ts writeCredentialHelper, reused) and never the key in its env or argv.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { makeBatch } from "../../src/workflows/batch.ts";
import { executorCredential, sdkQueryOptions } from "../../src/workflows/executor.ts";
import { createGate } from "../../src/workflows/gate.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const job = () => {
  const batch = makeBatch("wf_k", "live", [], 1);
  return { batch, gate: createGate({ workflowId: "wf_k", mode: "live", batch, autoRun: false, runToken: null, approvals: () => undefined }) };
};

describe("s27 executor key", () => {
  test("LIVE: with only the Keychain reference, the query gets apiKeyHelper (a 0700 script that asks the Keychain) and the child env has no key", () => {
    const env = { PATH: "/usr/bin", HOME: "/Users/x", OFFLOAD_ANTHROPIC_KEYCHAIN: "offload-s27-test-service/none" };
    const cred = executorCredential(env)!;
    expect(cred).not.toBeNull();
    cleanups.push(cred.cleanup);
    const o = sdkQueryOptions(job(), env, cred);
    expect(o.options.settings).toEqual({ apiKeyHelper: cred.command });
    const script = readFileSync(cred.helper, "utf8");
    expect(script).toContain("/usr/bin/security find-generic-password -s 'offload-s27-test-service' -a 'none' -w");
    expect(statSync(cred.helper).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(cred.helper)).mode & 0o777).toBe(0o700);
    expect(Object.keys(o.options.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    cred.cleanup();
    expect(existsSync(dirname(cred.helper))).toBe(false);
  });

  test("LIVE: a key in the brain's own env reaches the child only through the helper, never its env or argv", () => {
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-s27-not-real", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27-not-real" };
    const cred = executorCredential(env)!;
    cleanups.push(cred.cleanup);
    const o = sdkQueryOptions(job(), env, cred);
    const shown = JSON.stringify({ env: o.options.env, settings: o.options.settings, args: o.options.extraArgs ?? null });
    expect(shown).not.toContain("sk-ant-s27-not-real");
    expect(shown).not.toContain("oat-s27-not-real");
    expect(o.options.settings?.apiKeyHelper).toBe(cred.command);
  });

  test("LIVE: no key configured: no helper, no key, the child relies on its own sign-in", () => {
    expect(executorCredential({ PATH: "/usr/bin" })).toBeNull();
    const o = sdkQueryOptions(job(), { PATH: "/usr/bin" }, null);
    expect(o.options.settings).toBeUndefined();
  });
});
