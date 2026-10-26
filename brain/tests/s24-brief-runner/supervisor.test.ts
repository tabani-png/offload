// SAFETY / CHECKS (security review of 6f1527b):
// P2-1: a bun check must not discover workspace module resolution: a bare specifier served from ws/node_modules or a
//       ws/tsconfig.json `paths` remap loaded builder code in-process and passed. The check runs with its resolution
//       root outside the workspace and the guard refuses any RESOLVED path inside it; checks.ts refuses non-builtin
//       bare imports at authoring time.
// P2-2: run_in_background and Bash timeouts above the run's wall cap are denied; a builder command whose wrapper is
//       SIGKILLed must not leave a process that writes the workspace during the check or after the artifact hash.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { checksDir, checkSha, parseCheckReply, writeChecks } from "../../src/builder/checks.ts";
import { verifyArtifact } from "../../src/builder/record.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { builderPermissions, decideTool } from "../../src/builder/sandbox.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { briefHome, fakeQuery, fakeRouted, NOW, prepared, writeSlug, type FakeTry } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

/** Puts a check on disk WITHOUT the authoring filter (to prove the runtime defence on its own). */
async function rawCheck(file: "accept.py" | "accept.test.ts", content: string) {
  const b = briefHome();
  const { model } = fakeRouted(b.home);
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  const dir = checksDir(b.home, b.briefId);
  writeFileSync(join(dir, file), content);
  const set = { ...c.set, file, sha256: checkSha(content) };
  writeFileSync(join(dir, "checks.json"), JSON.stringify(set, null, 2) + "\n");
  return { ...b, checkHash: set.sha256 };
}

async function runRaw(file: "accept.py" | "accept.test.ts", content: string, tries: FakeTry[], limits = {}) {
  const p = await rawCheck(file, content);
  const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
  const f = fakeQuery(tries);
  return { p, rec: await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits }) };
}

describe("s24 bun check resolution", () => {
  test("SAFETY: a bare specifier served from ws/node_modules is not loaded into the check (no fake PASS)", async () => {
    const check = ['import { expect, test } from "bun:test";', 'import { ok } from "shadowpkg";', 'test("ok", () => { expect(ok).toBe(true); });', ""].join("\n");
    const { rec } = await runRaw("accept.test.ts", check, [
      {
        act: (ws) => {
          mkdirSync(join(ws, "node_modules", "shadowpkg"), { recursive: true });
          writeFileSync(join(ws, "node_modules", "shadowpkg", "package.json"), JSON.stringify({ name: "shadowpkg", main: "index.js" }));
          writeFileSync(join(ws, "node_modules", "shadowpkg", "index.js"), "exports.ok = true;\n");
        },
      },
    ], { maxTries: 1 });
    expect(rec.outcome).not.toBe("PASS");
  }, 30_000);

  test("SAFETY: a ws/tsconfig.json paths remap cannot point a check import at builder code", async () => {
    const check = ['import { expect, test } from "bun:test";', 'import { ok } from "fakemod";', 'test("ok", () => { expect(ok).toBe(true); });', ""].join("\n");
    const { rec } = await runRaw("accept.test.ts", check, [
      {
        act: (ws) => {
          writeFileSync(join(ws, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { fakemod: ["./evil.ts"] } } }));
          writeFileSync(join(ws, "evil.ts"), "export const ok = true;\n");
        },
      },
    ], { maxTries: 1 });
    expect(rec.outcome).not.toBe("PASS");
  }, 30_000);

  test("CHECKS: a bun check with a non-builtin bare import (or require) is refused at authoring time; builtins and relative imports are fine", () => {
    const reply = (content: string) => JSON.stringify({ file: "accept.test.ts", content });
    for (const bad of ['import { x } from "shadowpkg";\n', 'const x = require("lodash");\n', 'const m = await import("fakemod");\n', 'import x from "@scope/pkg";\n']) {
      const r = parseCheckReply(reply(bad));
      expect("reason" in r && r.reason).toContain("import");
    }
    for (const good of ['import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\nimport { join } from "path";\n', 'import { spawnSync } from "child_process";\n']) {
      expect("reason" in parseCheckReply(reply(good))).toBe(false);
    }
  });
});

describe("s24 builder commands", () => {
  test("SAFETY: Bash with run_in_background, or a timeout above the run's wall cap, is denied", async () => {
    const ws = "/tmp/ws-s24";
    expect(decideTool(ws, "Bash", { command: "python3 tool.py", run_in_background: true }).allow).toBe(false);
    const perms = (builderPermissions as unknown as (...a: unknown[]) => ReturnType<typeof builderPermissions>)(ws, undefined, { maxCommandMs: 60_000 });
    expect((await perms.canUseTool("Bash", { command: "python3 tool.py", timeout: 600_000 })).behavior).toBe("deny");
    expect((await perms.canUseTool("Bash", { command: "python3 tool.py", timeout: 30_000 })).behavior).toBe("allow");
  });

  test("SAFETY: a daemon from a builder command whose wrapper is SIGKILLed cannot write the workspace during the check or after the hash", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let wsSeen = "";
    // Detaches, closes stdio, then keeps writing into the workspace.
    const daemon = ["import os, sys, time", "if os.fork() == 0:", "    os.setsid()", "    if os.fork() == 0:", "        d = os.open(os.devnull, os.O_RDWR)", "        for fd in (0, 1, 2):", "            os.dup2(d, fd)", "        for i in range(40):", "            time.sleep(0.15)", "            open('late_%d.txt' % i, 'w').write('x')", "        os._exit(0)", "    os._exit(0)", "time.sleep(30)", ""].join("\n");
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          wsSeen = ws;
          writeSlug("good")(ws);
          writeFileSync(join(ws, "bg.py"), daemon);
          const r = await o.canUseTool!("Bash", { command: "python3 bg.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          const child = spawn("/bin/sh", ["-c", cmd], { cwd: ws, detached: true, stdio: "ignore" });
          await Bun.sleep(700);
          // Claude Code kills the command's process group hard (no SIGTERM first).
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
          await Bun.sleep(100);
        },
      },
    ]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(rec.outcome).toBe("PASS");
    const before = existsSync(join(wsSeen, "late_39.txt"));
    await Bun.sleep(2500);
    expect(verifyArtifact(p.home, rec.id)).toBe(true);
    expect(existsSync(join(wsSeen, "late_39.txt"))).toBe(before);
    expect(before).toBe(false);
  }, 30_000);
});
