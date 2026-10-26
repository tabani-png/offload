// SAFETY (Codex review of 48ea0a2): a builder command that leaves a long-lived child holding its stdout open must
// still finish promptly once the command itself exits; the leftover is swept.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { fakeQuery, NOW, prepared, releaseTemps, shell, writeSlug } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const sleepers = () => spawnSync("/usr/bin/pgrep", ["-f", "sleep 600.4242"], { encoding: "utf8" }).stdout.trim();

describe("s24 lingering command output", () => {
  test("SAFETY: a command whose background child keeps stdout open returns promptly, and the child is swept", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let took = -1;
    let out = "";
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          writeSlug("good")(ws);
          writeFileSync(join(ws, "bg.py"), "import subprocess\nsubprocess.Popen(['/bin/sleep', '600.4242'])\nprint('started the sleeper')\n");
          const r = await o.canUseTool!("Bash", { command: "python3 bg.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          const t0 = Date.now();
          const res = await Promise.race([shell(cmd, ws), new Promise<null>((done) => setTimeout(() => done(null), 10_000))]);
          took = res === null ? -1 : Date.now() - t0;
          out = res?.stdout ?? "";
        },
      },
    ]);
    await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(out).toContain("started the sleeper");
    expect(took).toBeGreaterThanOrEqual(0);
    expect(took).toBeLessThan(5000);
    expect(sleepers()).toBe("");
  }, 40_000);
});
