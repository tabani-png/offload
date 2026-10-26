// SAFETY / GATE / RECORD (independent review of 3ec1d74, repros in /tmp/rv21.pnFK):
// - exit 0 alone is never PASS: builder code that exits 0 early (SystemExit, os._exit, process.exit) must not pass;
//   PASS needs a completion proof from the trusted harness, carrying the run's nonce, and the check process never
//   loads builder code (it runs the built tool as a subprocess);
// - nothing builder-controlled outlives a check or a builder command (fork + setsid daemons included);
// - the artifact is hashed at the verdict and can be verified later;
// - the approval is consumed last (after setup) and claimed atomically; /opt/homebrew config is unreadable; no FIFOs.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as approval from "../../src/builder/approval.ts";
import { approveBuild } from "../../src/builder/approval.ts";
import { writeChecks, type CheckFile } from "../../src/builder/checks.ts";
import * as record from "../../src/builder/record.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { briefHome, fakeQuery, fakeRouted, NOW, prepared, writeSlug, type FakeTry } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

async function buildWith(file: CheckFile, content: string, tries: FakeTry[], limits = {}) {
  const b = briefHome();
  const { model } = fakeRouted(b.home, JSON.stringify({ file, content }));
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  const { token } = approveBuild(b.home, b.briefId, b.briefHash, c.set.sha256, NOW);
  const f = fakeQuery(tries);
  const rec = await runBuild({ home: b.home, briefId: b.briefId, token, query: f.query, profile: ALLOW, limits });
  return { b, rec, seen: f.seen };
}

const IMPORTING_PY = ["import sys", "import tool", "assert tool.slug('A B') == 'a-b', 'wrong slug'", "print('PASS slug')", "sys.exit(0)", ""].join("\n");

describe("s24 completion proof", () => {
  for (const [name, body] of [
    ["SystemExit(0)", "raise SystemExit(0)\n"],
    ["os._exit(0)", "import os\nos._exit(0)\n"],
  ] as const) {
    test(`SAFETY: builder code doing ${name} at import cannot fake a PASS (python)`, async () => {
      const { rec } = await buildWith("accept.py", IMPORTING_PY, [{ act: (ws) => writeFileSync(join(ws, "tool.py"), body) }], { maxTries: 1 });
      expect(rec.outcome).not.toBe("PASS");
      expect(rec.tries[0]!.checkExit).not.toBe(0);
    }, 30_000);
  }

  test("SAFETY: bun builder code calling process.exit(0) at import cannot fake a PASS", async () => {
    const check = ['import { expect, test } from "bun:test";', 'import { slug } from "../tool.ts";', 'test("slug", () => { expect(slug("A B")).toBe("a-b"); });', ""].join("\n");
    const { rec } = await buildWith("accept.test.ts", check, [{ act: (ws) => writeFileSync(join(ws, "tool.ts"), "process.exit(0);\nexport const slug = (s: string) => s;\n") }], { maxTries: 1 });
    expect(rec.outcome).not.toBe("PASS");
  }, 30_000);

  test("SAFETY: a check process that exits 0 before its own code finishes has no completion proof and is not PASS", async () => {
    const { rec } = await buildWith("accept.py", "import os\nos._exit(0)\nprint('never')\n", [{ act: writeSlug("good") }], { maxTries: 1 });
    expect(rec.outcome).not.toBe("PASS");
  }, 30_000);

  test("SAFETY: importing builder code into the check is refused with a reason (run it as a subprocess instead)", async () => {
    const { rec } = await buildWith("accept.py", IMPORTING_PY, [{ act: (ws) => writeFileSync(join(ws, "tool.py"), "import re\ndef slug(s):\n    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')\n") }], { maxTries: 1 });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.tries[0]!.checkOutput).toContain("subprocess");
  }, 30_000);
});

const DAEMON = ["import os, sys, time", "if os.fork() == 0:", "    os.setsid()", "    if os.fork() == 0:", "        time.sleep(1.5)", "        open('mutated_after_pass.txt', 'w').write('x')", "        os._exit(0)", "    os._exit(0)", "print('tool done')", ""].join("\n");

describe("s24 no survivors", () => {
  test("SAFETY: a fork+setsid daemon started during the check is killed before the verdict; the artifact does not change after PASS", async () => {
    const check = ["import subprocess, sys", "r = subprocess.run([sys.executable, 'tool.py'], capture_output=True, text=True)", "ok = 'tool done' in r.stdout", "print(('PASS' if ok else 'FAIL') + ' tool ran')", "sys.exit(0 if ok else 1)", ""].join("\n");
    const { b, rec } = await buildWith("accept.py", check, [{ act: (ws) => writeFileSync(join(ws, "tool.py"), DAEMON) }]);
    expect(rec.outcome).toBe("PASS");
    await Bun.sleep(2500);
    expect(existsSync(join(rec.artifactPath, "mutated_after_pass.txt"))).toBe(false);
    const r = record as unknown as { verifyArtifact: (home: string, id: string) => boolean };
    expect(typeof (rec as unknown as { artifactSha256?: string }).artifactSha256).toBe("string");
    expect(r.verifyArtifact(b.home, rec.id)).toBe(true);
  }, 30_000);

  test("SAFETY: a daemon left by a builder Bash command is killed when the command ends", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let wsSeen = "";
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          wsSeen = ws;
          writeSlug("good")(ws);
          writeFileSync(join(ws, "tool.py"), DAEMON);
          const r = await o.canUseTool!("Bash", { command: "python3 tool.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          spawnSync("/bin/sh", ["-c", cmd], { cwd: ws, encoding: "utf8" });
        },
      },
    ]);
    await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    await Bun.sleep(2500);
    expect(existsSync(join(wsSeen, "mutated_after_pass.txt"))).toBe(false);
  }, 30_000);

  test("RECORD: the artifact hash is recorded at the verdict and verifyArtifact refuses a changed artifact", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    const r = record as unknown as { verifyArtifact: (home: string, id: string) => boolean };
    expect((rec as unknown as { artifactSha256?: string }).artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.verifyArtifact(p.home, rec.id)).toBe(true);
    writeFileSync(join(rec.artifactPath, "slug.py"), "print('changed')\n");
    expect(r.verifyArtifact(p.home, rec.id)).toBe(false);
  }, 30_000);
});

describe("s24 approval claim and sandbox reads", () => {
  test("GATE: a run that fails during setup keeps the approval (consumed last)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    writeFileSync(join(p.home, "builds"), "not a folder");
    const f = fakeQuery([{ act: writeSlug("good") }]);
    await expect(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW })).rejects.toThrow();
    rmSync(join(p.home, "builds"));
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(rec.outcome).toBe("PASS");
  }, 30_000);

  test("GATE: the approval is claimed atomically: an existing claim file refuses the token even if the json says unused", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    // Another process won the claim between our read and write.
    mkdirSync(join(p.home, "solutions", p.briefId), { recursive: true });
    writeFileSync(join(p.home, "solutions", p.briefId, "build-approval.claim"), "other\n", { flag: "wx" });
    expect(() => approval.consumeBuildApproval(p.home, p.briefId, token, NOW)).toThrow(/already used/);
    // A fresh approval clears the old claim.
    const again = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    expect(() => approval.consumeBuildApproval(p.home, p.briefId, again.token, NOW)).not.toThrow();
    expect(() => approval.consumeBuildApproval(p.home, p.briefId, again.token, NOW)).toThrow(/already used/);
  });

  test("SAFETY: sandboxed code cannot read /opt/homebrew/etc or /usr/local/etc, nor create a FIFO", async () => {
    const check = [
      "import os, sys",
      "for n, f in [('brew-etc', lambda: os.listdir('/opt/homebrew/etc') if os.path.isdir('/opt/homebrew') else 1/0), ('local-etc', lambda: os.listdir('/usr/local/etc') if os.path.isdir('/usr/local/etc') else 1/0), ('mkfifo', lambda: os.mkfifo('ff'))]:",
      "    try:",
      "        f(); print('ESCAPED ' + n)",
      "    except Exception as e:",
      "        print('BLOCKED ' + n)",
      "sys.exit(0)",
      "",
    ].join("\n");
    const { rec } = await buildWith("accept.py", check, [{ act: writeSlug("good") }]);
    expect(rec.tries[0]!.checkOutput).not.toContain("ESCAPED");
    expect(rec.tries[0]!.checkOutput).toContain("BLOCKED mkfifo");
  }, 30_000);
});
