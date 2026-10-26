// s10b N6 (REVIEW-2): observer children (status, pause/resume, wrap/unwrap-key, export-day, purge-now) get an explicit
// minimal environment: PATH, HOME, OFFLOAD_HOME, OFFLOAD_KEYS. SDK children (model and executor) get their own fixed
// allowlist. Neither ever sees OFFLOAD_TOKEN, any other OFFLOAD_* setting or a connector secret.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observerStatus } from "../../src/api/observer-route.ts";
import { modelQueryOptions } from "../../src/models/model.ts";
import { observerChildEnv, runObserverSync } from "../../src/store/observer.ts";
import { requestObserverPurge } from "../../src/store/reader.ts";
// s27 round 13 scope change: SDK children get their env only from agentSdkAuth (models/agent-auth.ts).
import { agentSdkAuth } from "../../src/models/agent-auth.ts";
import { tempHome } from "../helpers.ts";

const ALLOWED = ["HOME", "OFFLOAD_HOME", "OFFLOAD_KEYS", "PATH"];
// Set by bash itself in every child.
const BASH_OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const SECRETS = { OFFLOAD_TOKEN: "tok-" + "x".repeat(40), GMAIL_OAUTH_PATH: "/secret/creds.json", COMPOSIO_API_KEY: "ck_secret", OFFLOAD_MODEL_DRAFT: "x", ANTHROPIC_API_KEY: "sk-keep" };

let home = "";
let cleanup = () => {};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  ({ home, cleanup } = tempHome());
  for (const k of Object.keys(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = SECRETS[k as keyof typeof SECRETS];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanup();
});

/** An observer stand-in that writes its environment (one NAME per line) to `out` and prints a v1 status. */
function dumper(out: string): string {
  const p = join(home, "dump-observer.sh");
  writeFileSync(p, `#!/bin/bash\nenv | cut -d= -f1 >> '${out}'\necho '---' >> '${out}'\necho '{"schemaVersion":1,"running":true}'\n`);
  chmodSync(p, 0o755);
  return p;
}
const names = (out: string) => readFileSync(out, "utf8").split("\n").filter((l) => l !== "" && l !== "---" && !BASH_OWN.has(l));

describe("s10b N6: child environments", () => {
  test("N6: observerChildEnv holds only PATH, HOME, OFFLOAD_HOME and OFFLOAD_KEYS", () => {
    const env = observerChildEnv(home, { ...process.env, OFFLOAD_OBSERVER_BIN: "/x", OFFLOAD_KEYS: "file", FOO: "bar" });
    expect(Object.keys(env).sort()).toEqual(ALLOWED);
    expect(env.OFFLOAD_HOME).toBe(home);
  });

  test("N6: a spawned observer (status, wrap-key, purge-now) sees no token or connector secret", async () => {
    const out = join(home, "env.txt");
    const bin = dumper(out);
    const env = { ...process.env, OFFLOAD_OBSERVER_BIN: bin };
    expect((await observerStatus(home, env, Date.now())).available).toBe(true);
    runObserverSync(home, ["wrap-key", "--name", "2026-10-19"], env);
    requestObserverPurge(home, env);
    expect(existsSync(out)).toBe(true);
    const seen = names(out);
    expect(seen.length).toBeGreaterThan(0);
    for (const n of seen) expect(ALLOWED).toContain(n);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("OFFLOAD_TOKEN");
    expect(text).not.toContain("COMPOSIO_API_KEY");
    expect(text).not.toContain("GMAIL_OAUTH_PATH");
  });

  test("N6: the executor child gets no OFFLOAD_* setting and no connector secret", () => {
    const auth = agentSdkAuth(process.env, () => {});
    try {
      const env = auth.env;
      for (const k of Object.keys(env)) expect(k.startsWith("OFFLOAD_")).toBe(false);
      expect(env.GMAIL_OAUTH_PATH).toBeUndefined();
      expect(env.COMPOSIO_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH!);
    } finally {
      auth.cleanup();
    }
  });

  test("N6: the model child gets the same allowlist and no tools", () => {
    const auth = agentSdkAuth(process.env, () => {});
    try {
      const o = modelQueryOptions({ role: "draft", model: "claude-opus-5-5", system: "s", prompt: "p" }, auth);
      const env = o.options.env as Record<string, string>;
      expect(env.OFFLOAD_TOKEN).toBeUndefined();
      expect(env.COMPOSIO_API_KEY).toBeUndefined();
      expect(env).toEqual(auth.env);
      expect(o.options.tools).toEqual([]);
      expect(o.options.mcpServers).toEqual({});
    } finally {
      auth.cleanup();
    }
  });
});
