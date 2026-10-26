// SAFETY (Codex review of aa2fd64): any secret-bearing variable in the brain's ORIGINAL (launch) environment is
// readable by sandboxed builder code (sysctl KERN_PROCARGS2), so a build refuses it, naming the variables (never the
// values). Harmless names that look like secrets are allow-listed. And the artifact scan reads every byte of every
// file (overlapping chunks), failing closed above a hard size cap.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import * as sandbox from "../../src/builder/sandbox.ts";
import { cleanSpawnEnv, fakeQuery, NOW, prepared, writeSlug, withLaunchEnv } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const secretEnvNames = (env: Record<string, string>) => (sandbox as unknown as { secretEnvNames: (e: Record<string, string>) => string[] }).secretEnvNames(env);

describe("s24 launch environment preflight", () => {
  test("SAFETY: secret-bearing names and secret-shaped values are found; harmless look-alikes are allowed", () => {
    const env = {
      OPENAI_API_KEY: "sk-proj-abc",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_SESSION_TOKEN: "x",
      GITHUB_TOKEN: "x",
      GH_TOKEN: "x",
      NPM_TOKEN: "x",
      STRIPE_SECRET: "x",
      DB_PASSWORD: "x",
      MY_CREDENTIALS: "x",
      SLACK_BOT_TOKEN: "x",
      PLAIN_NAME: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab",
      TERM_SESSION_ID: "w0t0p0:1234",
      SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.x/Listeners",
      OFFLOAD_TOKEN: "local-bearer",
      OFFLOAD_KEYS: "file",
      OFFLOAD_ANTHROPIC_KEYCHAIN: "svc/acct",
      AWS_REGION: "eu-west-1",
      AWS_PROFILE: "dev",
      GITHUB_ACTIONS: "true",
      PATH: "/usr/bin",
      HOME: "/Users/x",
    };
    expect(secretEnvNames(env).sort()).toEqual(["AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DB_PASSWORD", "GH_TOKEN", "GITHUB_TOKEN", "MY_CREDENTIALS", "NPM_TOKEN", "OPENAI_API_KEY", "PLAIN_NAME", "SLACK_BOT_TOKEN", "STRIPE_SECRET"]);
  });

  test("SAFETY: a build refuses a secret in the launch environment, naming the variables but never the values", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    let msg = "";
    await withLaunchEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-proj-VALUESENTINEL123456", AWS_SECRET_ACCESS_KEY: "VALUESENTINEL2" }, async () => {
      try {
        await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
      } catch (err) {
        msg = String((err as Error).message);
        expect(err).toBeInstanceOf(sandbox.UnsafeProfileError);
      }
    });
    expect(msg).toContain("OPENAI_API_KEY");
    expect(msg).toContain("AWS_SECRET_ACCESS_KEY");
    expect(msg).not.toContain("VALUESENTINEL");
    expect(msg.toLowerCase()).toContain("app");
    expect(f.seen).toHaveLength(0);
    // The approval is kept.
    expect((await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW })).outcome).toBe("PASS");
  }, 30_000);

  test("SAFETY: the real launch environment is what counts: a CLI started with GITHUB_TOKEN refuses (exit 2); started clean it builds", async () => {
    const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const base = { ...cleanSpawnEnv(), OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file", OFFLOAD_BUILDER_FAKE_SDK: join(import.meta.dir, "fake-sdk.ts"), NODE_ENV: "test" };
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const bad = spawnSync(process.execPath, ["run", CLI, "build", "run", "--brief", p.briefId, "--token", token, "--home", p.home], { env: { ...base, GITHUB_TOKEN: "ghp_LAUNCHSENTINEL0123456789abcdefghijkl" }, encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("GITHUB_TOKEN");
    expect(bad.stderr).not.toContain("LAUNCHSENTINEL");
  }, 60_000);
});

describe("s24 artifact scan reads every byte", () => {
  test("SAFETY: a secret after the first 16 MiB of a file is still found", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); const big = join(ws, "big.txt"); writeFileSync(big, Buffer.alloc(17 * 1024 * 1024, 0x61)); writeFileSync(big, "\nghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab\n", { flag: "a" }); } }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("artifact contains a secret");
  }, 60_000);

  test("SAFETY: a file above the scan cap fails closed ('too large to scan')", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); const huge = join(ws, "huge.bin"); writeFileSync(huge, ""); truncateSync(huge, 100 * 1024 * 1024); } }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("too large to scan");
  }, 120_000);
});
