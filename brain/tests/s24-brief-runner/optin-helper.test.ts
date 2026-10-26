// SAFETY (Codex review of a43ff1b):
// 1. The builder is OFF unless OFFLOAD_BUILDER_ENABLED=1: sandbox-exec cannot stop builder code from reading other
//    same-user processes' argv and environment (sysctl KERN_PROCARGS2 is not mediated by the sandbox at all; verified
//    with sysctl-read fully denied). The refusal comes before the approval is used and says why.
// 2. The apiKeyHelper is a shell command: its path is shell-quoted (homes with spaces or quotes) and dry-run before
//    the approval is used.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { UnsafeProfileError } from "../../src/builder/sandbox.ts";
import { fakeQuery, NOW, prepared, releaseTemps, writeSlug } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const KEY = "sk-ant-api03-S24HELPERKEYs24helper0123456789abcdef";

describe("s24 builder opt-in", () => {
  test("SAFETY: without OFFLOAD_BUILDER_ENABLED=1 a build is refused with the reason, and the approval is kept", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const saved = process.env.OFFLOAD_BUILDER_ENABLED;
    delete process.env.OFFLOAD_BUILDER_ENABLED;
    let msg = "";
    try {
      await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeProfileError);
      msg = String((err as Error).message);
    } finally {
      process.env.OFFLOAD_BUILDER_ENABLED = saved;
    }
    expect(msg).toContain("OFFLOAD_BUILDER_ENABLED=1");
    expect(msg).toContain("KERN_PROCARGS2");
    expect(f.seen).toHaveLength(0);
    expect((await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW })).outcome).toBe("PASS");
  }, 30_000);
});

describe("s24 apiKeyHelper quoting", () => {
  test("SAFETY: a home with spaces and a single quote still gives Claude Code a working apiKeyHelper command", async () => {
    const p = await prepared("offload-s24-Application Support's Demo ");
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let helperOut = "";
    const f = fakeQuery([
      {
        act: (_ws, o) => {
          writeSlug("good")(_ws);
          // Claude Code runs apiKeyHelper through a shell.
          const cmd = (o.settings as { apiKeyHelper?: string }).apiKeyHelper ?? "";
          helperOut = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" }).stdout.trim();
        },
      },
    ]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: KEY } });
    expect(helperOut).toBe(KEY);
    expect(rec.outcome).toBe("PASS");
  }, 30_000);
});
