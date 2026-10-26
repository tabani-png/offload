// LOOP / SAFETY / CAPS (Codex review of b4e4311): the frozen check resolves the built artifact's imports from the
// workspace (Python module import, relative TS import) without letting builder files hook the check's start-up
// (sitecustomize, stdlib shadowing, bunfig preload, .env); the wall cap holds during the check run; the SDK budget is
// never rounded past the USD cap.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { writeChecks, type CheckFile } from "../../src/builder/checks.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { briefHome, fakeQuery, fakeRouted, NOW, type FakeTry } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

async function buildWith(file: CheckFile, content: string, tries: FakeTry[], limits = {}) {
  const b = briefHome();
  const { model } = fakeRouted(b.home, JSON.stringify({ file, content }));
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  const { token } = approveBuild(b.home, b.briefId, b.briefHash, c.set.sha256, NOW);
  const f = fakeQuery(tries);
  const t0 = Date.now();
  const rec = await runBuild({ home: b.home, briefId: b.briefId, token, query: f.query, profile: ALLOW, limits });
  return { rec, seen: f.seen, elapsed: Date.now() - t0 };
}

const PY_SLUG = "import re\ndef slug(s):\n    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')\n";

describe("s24 check import resolution", () => {
  // Builder code is never imported into the check process (it could forge the result); the check runs it as a
  // subprocess with cwd = workspace, and that resolves from the workspace.
  test("LOOP: a python check that runs the built module as a subprocess from the workspace passes", async () => {
    const check = ["import subprocess, sys", "r = subprocess.run([sys.executable, '-c', 'import slug_lib; print(slug_lib.slug(\"Hello World\"))'], capture_output=True, text=True)", "ok = r.stdout.strip() == 'hello-world'", "print(('PASS' if ok else 'FAIL') + ' slug_lib.slug ' + r.stdout.strip() + r.stderr.strip())", "sys.exit(0 if ok else 1)", ""].join("\n");
    const { rec } = await buildWith("accept.py", check, [{ act: (ws) => writeFileSync(join(ws, "slug_lib.py"), PY_SLUG) }]);
    expect(rec.tries[0]!.checkOutput).toContain("PASS slug_lib.slug");
    expect(rec.outcome).toBe("PASS");
  }, 30_000);

  test("LOOP: a bun check that runs the built TS file with bun from the workspace passes", async () => {
    const check = ['import { expect, test } from "bun:test";', 'test("slug", () => {', '  const r = Bun.spawnSync([process.execPath, "run", "slug.ts", "Hello World"]);', '  expect(r.stdout.toString().trim()).toBe("hello-world");', "});", ""].join("\n");
    const ts = 'const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\nconsole.log(slug(process.argv[2] ?? ""));\n';
    const { rec } = await buildWith("accept.test.ts", check, [{ act: (ws) => writeFileSync(join(ws, "slug.ts"), ts) }]);
    expect(rec.tries[0]!.checkOutput).toContain("1 pass");
    expect(rec.outcome).toBe("PASS");
  }, 30_000);

  test("SAFETY: builder files cannot hook the python check's start-up or shadow the stdlib", async () => {
    const check = ["import sys, json", "print('JSON ' + json.dumps({'a': 1}))", "sys.exit(0)", ""].join("\n");
    const { rec } = await buildWith("accept.py", check, [
      {
        act: (ws) => {
          writeFileSync(join(ws, "sitecustomize.py"), "print('HIJACK sitecustomize')\n");
          writeFileSync(join(ws, "usercustomize.py"), "print('HIJACK usercustomize')\n");
          writeFileSync(join(ws, "json.py"), "print('HIJACK json shadow')\ndef dumps(x):\n    return 'fake'\n");
        },
      },
    ]);
    const out = rec.tries[0]!.checkOutput;
    expect(out).toContain('JSON {"a": 1}');
    expect(out).not.toContain("HIJACK");
  }, 30_000);

  test("SAFETY: a builder bunfig.toml preload or .env file does not reach the bun check", async () => {
    const check = ['import { expect, test } from "bun:test";', 'test("clean", () => { console.log("SNEAKY=" + process.env.SNEAKY); expect(1).toBe(1); });', ""].join("\n");
    const { rec } = await buildWith("accept.test.ts", check, [
      {
        act: (ws) => {
          writeFileSync(join(ws, "bunfig.toml"), '[test]\npreload = ["./cheat.ts"]\n');
          writeFileSync(join(ws, "cheat.ts"), 'console.log("HIJACK preload");\n');
          writeFileSync(join(ws, ".env"), "SNEAKY=1\n");
        },
      },
    ]);
    const out = rec.tries[0]!.checkOutput;
    expect(out).toContain("SNEAKY=undefined");
    expect(out).not.toContain("HIJACK");
  }, 30_000);
});

describe("s24 caps hold during the check", () => {
  test("CAPS: a check that would finish after the wall cap is stopped and never recorded as PASS", async () => {
    const slow = ["import sys, time", "time.sleep(0.8)", "print('PASS slow')", "sys.exit(0)", ""].join("\n");
    // The try uses ~900 ms of a 1200 ms cap; the 800 ms check would end at ~1.7 s.
    const { rec, elapsed } = await buildWith("accept.py", slow, [{ act: async () => { await Bun.sleep(900); } }], { wallMs: 1200 });
    expect(rec.outcome).toBe("CAP");
    expect(rec.reason).toContain("wall time");
    expect(rec.tries.every((t) => t.checkExit !== 0)).toBe(true);
    // Stopped, not run to completion (which would print PASS slow at ~1.7 s); the run adds a bounded post-verdict
    // sweep and double artifact hash, so the elapsed bound is loose.
    expect(rec.tries.map((t) => t.checkOutput).join("\n")).not.toContain("PASS slow");
    expect(elapsed).toBeLessThan(2500);
  }, 30_000);

  test("CAPS: a check that hangs is killed at the wall cap, with its children", async () => {
    const hang = ["import subprocess, sys, time", "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])", "time.sleep(30)", ""].join("\n");
    const { rec, elapsed } = await buildWith("accept.py", hang, [{}], { wallMs: 1500 });
    expect(rec.outcome).toBe("CAP");
    expect(elapsed).toBeLessThan(3000);
  }, 30_000);

  test("CAPS: the SDK budget for the next try is never rounded up past the USD cap", async () => {
    const fail = "import sys\nprint('FAIL')\nsys.exit(1)\n";
    const { seen } = await buildWith("accept.py", fail, [{ costUsd: 0.1234564 }], { maxUsd: 1, maxTries: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.options.maxBudgetUsd!).toBeLessThanOrEqual(1 - 0.1234564);
  }, 30_000);
});
