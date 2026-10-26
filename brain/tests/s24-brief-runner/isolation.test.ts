// SAFETY / TAMPER / CAPS (Codex review of 72cd137): builder-controlled code (the builder's Bash commands AND the frozen
// acceptance check) runs inside a real OS sandbox (macOS sandbox-exec, deny-default) with an explicit allow-list env;
// no sandbox = refuse to run; secrets never reach the record or a retry prompt; malformed limits are refused before
// the single-use approval is spent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { FALLBACK_CHECK, writeChecks } from "../../src/builder/checks.ts";
import { runBuild } from "../../src/builder/runner.ts";
import * as sandbox from "../../src/builder/sandbox.ts";
import { decideTool, UnsafeProfileError } from "../../src/builder/sandbox.ts";

const checkEnv = (...a: unknown[]) => (sandbox as any).checkEnv(...a) as Record<string, string>;
const redactSecrets = (...a: unknown[]) => (sandbox as any).redactSecrets(...a) as string;
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { briefHome, fakeQuery, fakeRouted, NOW, prepared, tmp, writeSlug, shell, cleanSpawnEnv } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const SENTINEL_KEY = "sk-ant-api03-SENTINELsentinelSENTINEL0123456789abcdef";
const SENTINEL_OAUTH = "sk-ant-oat01-OAUTHSENTINELoauthsentinel0123456789";
const PARENT_ENV = { ...process.env, ANTHROPIC_API_KEY: SENTINEL_KEY, CLAUDE_CODE_OAUTH_TOKEN: SENTINEL_OAUTH, GITHUB_TOKEN: "ghp_PARENTSENTINEL0123456789abcdefghijklmn" };

let outside: string;
let server: { port: number; stop: (closeActive?: boolean) => void };
let connections = 0;

beforeAll(() => {
  outside = join(tmp("offload-s24-outside-"), "secret.txt");
  writeFileSync(outside, "OUTSIDE-SECRET-CONTENT\n");
  server = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { open() { connections++; }, data() {} } }) as unknown as typeof server;
});
afterAll(() => server.stop(true));

/** A check script that probes the sandbox: read outside, network, modify itself and the workspace copy, print env. */
const evilCheck = (port: number) =>
  [
    "import os, socket, sys",
    "def t(name, f):",
    "    try:",
    "        r = f()",
    "        print('ESCAPED ' + name + ' ' + repr(r)[:120])",
    "    except Exception as e:",
    "        print('BLOCKED ' + name + ' ' + type(e).__name__)",
    `t('read-outside', lambda: open(${JSON.stringify(outside)}).read())`,
    `t('net-local', lambda: socket.create_connection(('127.0.0.1', ${port}), 2).close())`,
    "t('net-dns', lambda: socket.getaddrinfo('example.com', 443))",
    "t('modify-frozen-check', lambda: open(os.path.abspath(sys.argv[0]), 'a').write('# tampered'))",
    "t('modify-workspace-check', lambda: open(os.path.join('accept', 'accept.py'), 'a').write('# tampered'))",
    "t('write-outside', lambda: open(" + JSON.stringify(outside + ".written") + ", 'w').write('x'))",
    "print('ENV ' + ' '.join(sorted(os.environ.keys())))",
    "print('ENVVALS ' + ' '.join(os.environ.values()))",
    "sys.exit(0)",
    "",
  ].join("\n");

async function preparedWith(content: string) {
  const b = briefHome();
  const { model } = fakeRouted(b.home, JSON.stringify({ file: "accept.py", content }));
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  return { ...b, checkHash: c.set.sha256 };
}

describe("s24 OS sandbox", () => {
  test("SAFETY: a hostile check cannot read outside the workspace, reach the network, change the frozen check or see secrets", async () => {
    const p = await preparedWith(evilCheck(server.port));
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, env: PARENT_ENV });
    const out = rec.tries[0]!.checkOutput;
    expect(out).not.toContain("ESCAPED");
    for (const probe of ["read-outside", "net-local", "net-dns", "modify-frozen-check", "modify-workspace-check", "write-outside"]) expect(out).toContain(`BLOCKED ${probe}`);
    expect(out).not.toContain("OUTSIDE-SECRET-CONTENT");
    expect(connections).toBe(0);
    expect(existsSync(outside + ".written")).toBe(false);
    const envLine = out.split("\n").find((l) => l.startsWith("ENV "))!;
    // __CF_USER_TEXT_ENCODING is set by macOS CoreFoundation in every process, not passed by us.
    expect(envLine.split(" ").slice(1).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    expect(out).not.toContain("SENTINEL");
    expect(out).not.toContain(SENTINEL_KEY);
    expect(rec.tries[0]!.checkHashOk).toBe(true);
    expect(rec.outcome).toBe("PASS");
    expect(JSON.stringify(rec)).not.toContain("SENTINEL");
  }, 30_000);

  test("SAFETY: a bun test check runs in the same sandbox (outside read and env blocked, workspace readable)", async () => {
    const content = [
      'import { expect, test } from "bun:test";',
      'import { existsSync, readFileSync } from "node:fs";',
      `test("outside is blocked", () => { expect(() => readFileSync(${JSON.stringify(outside)}, "utf8")).toThrow(); });`,
      'test("no secrets in env", () => { expect(JSON.stringify(process.env)).not.toContain("SENTINEL"); });',
      'test("built", () => { expect(existsSync("slug.py")).toBe(true); });',
      "",
    ].join("\n");
    const b = briefHome();
    const { model } = fakeRouted(b.home, JSON.stringify({ file: "accept.test.ts", content }));
    const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
    const { token } = approveBuild(b.home, b.briefId, b.briefHash, c.set.sha256, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const rec = await runBuild({ home: b.home, briefId: b.briefId, token, query: f.query, profile: ALLOW, env: PARENT_ENV });
    expect(rec.tries[0]!.checkOutput).toContain("3 pass");
    expect(rec.outcome).toBe("PASS");
  }, 30_000);

  test("SAFETY: the builder's Bash commands are rewritten to run inside the OS sandbox with a clean env (canUseTool and the PreToolUse hook)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let ran = "";
    let hookCmd = "";
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          writeSlug("good")(ws);
          writeFileSync(join(ws, "evil.py"), `import os\ntry:\n    print('ESCAPED ' + open(${JSON.stringify(outside)}).read())\nexcept Exception as e:\n    print('BLOCKED read-outside')\nprint('ENVVALS ' + ' '.join(os.environ.values()))\n`);
          const opts = { signal: new AbortController().signal, toolUseID: "t1" } as never;
          const r = await o.canUseTool!("Bash", { command: "python3 evil.py" }, opts);
          expect(r?.behavior).toBe("allow");
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          expect(cmd).toMatch(/^\/usr\/bin\/sandbox-exec /);
          expect(cmd).toContain("/usr/bin/env -i");
          expect(cmd).not.toContain("SENTINEL");
          // Claude Code runs the command through the user's shell with ITS env (which has the SDK auth).
          const sh = await shell(cmd, ws, PARENT_ENV);
          ran = `${sh.stdout}${sh.stderr}`;
          const hook = o.hooks!.PreToolUse![0]!.hooks[0]!;
          const h = (await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "python3 evil.py" } } as never, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: { updatedInput?: { command?: string } } };
          hookCmd = String(h.hookSpecificOutput?.updatedInput?.command ?? "");
          // Re-checking an already wrapped command keeps one wrap (the hook runs before canUseTool).
          const again = await o.canUseTool!("Bash", { command: cmd }, opts);
          expect(again?.behavior).toBe("allow");
          expect((again as unknown as { updatedInput: { command: string } }).updatedInput.command).toBe(cmd);
        },
      },
    ]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, env: PARENT_ENV });
    expect(rec.outcome).toBe("PASS");
    expect(ran).toContain("BLOCKED read-outside");
    expect(ran).not.toContain("ESCAPED");
    expect(ran).not.toContain("SENTINEL");
    expect(hookCmd).toMatch(/^\/usr\/bin\/sandbox-exec /);
  }, 30_000);

  test("SAFETY: with no OS sandbox available the run is refused before anything executes and the approval is kept", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    await expect(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, sandboxExec: "/nonexistent/sandbox-exec" } as never)).rejects.toBeInstanceOf(UnsafeProfileError);
    expect(f.seen).toHaveLength(0);
    expect(existsSync(join(p.home, "builds"))).toBe(false);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(rec.outcome).toBe("PASS");
  }, 30_000);

  test("SAFETY: the check env is an explicit allow-list, never copied from the parent env", () => {
    const env = checkEnv("/w/ws", PARENT_ENV);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    expect(env.HOME).toBe("/w/ws");
    expect(env.TMPDIR).toBe("/w/ws/.tmp");
    expect(JSON.stringify(env)).not.toContain("SENTINEL");
  });

  test("SAFETY: Read or Write through a symlink that leaves the workspace is denied", () => {
    const ws = tmp("offload-s24-ws-");
    mkdirSync(join(ws, "accept"));
    symlinkSync(outside, join(ws, "link.txt"));
    symlinkSync(join(outside, ".."), join(ws, "linkdir"));
    expect(decideTool(ws, "Read", { file_path: "link.txt" }).allow).toBe(false);
    expect(decideTool(ws, "Write", { file_path: "linkdir/new.txt", content: "x" }).allow).toBe(false);
    expect(decideTool(ws, "Read", { file_path: join(ws, "linkdir", "secret.txt") }).allow).toBe(false);
    writeFileSync(join(ws, "ok.py"), "");
    expect(decideTool(ws, "Read", { file_path: "ok.py" }).allow).toBe(true);
    expect(decideTool(ws, "Write", { file_path: "new/deeper/file.py", content: "x" }).allow).toBe(true);
  });

  test("SAFETY: secret-shaped strings in check output are redacted in the record and in the retry prompt", async () => {
    const leaky = ["import os, sys", "print('leak sk-ant-api03-LEAKleakLEAKleak0123456789abcdef ghp_LEAKleakLEAKleak0123456789abcdefghij AKIAABCDEFGHIJKLMNOP')", "print('FAIL' if not os.path.exists('done.txt') else 'PASS')", "sys.exit(0 if os.path.exists('done.txt') else 1)", ""].join("\n");
    const p = await preparedWith(leaky);
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{}, { act: (ws) => writeFileSync(join(ws, "done.txt"), "1") }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(rec.outcome).toBe("PASS");
    const disk = readFileSync(join(p.home, "builds", `${rec.id}.json`), "utf8");
    for (const s of [disk, f.seen[1]!.prompt]) {
      expect(s).not.toContain("LEAKleak");
      expect(s).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(s).toContain("[REDACTED]");
    }
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")).not.toContain("abcdefghijklmnop");
    expect(redactSecrets(`x ${SENTINEL_OAUTH} y`, [])).toBe("x [REDACTED] y");
    expect(redactSecrets("token=plainvalue123456", ["plainvalue123456"])).not.toContain("plainvalue123456");
    expect(redactSecrets("PASS slug('Hello World') = 'hello-world'")).toBe("PASS slug('Hello World') = 'hello-world'");
  }, 30_000);
});

describe("s24 frozen check outside the workspace", () => {
  test("TAMPER: the frozen master outside the workspace is verified before and after the run; the check executes from read-only accept/", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    let seenPath = "";
    let frozenDir = "";
    const rec = await runBuild({
      home: p.home,
      briefId: p.briefId,
      token,
      query: f.query,
      profile: ALLOW,
      runCheck: (a: { ws: string; checkPath: string; frozenDir: string }) => {
        seenPath = a.checkPath;
        frozenDir = a.frozenDir;
        // An escape that rewrites the frozen master while the check runs must still be caught.
        const { chmodSync } = require("node:fs");
        const master = join(a.frozenDir, "accept.py");
        chmodSync(master, 0o644);
        writeFileSync(master, "import sys\nsys.exit(0)\n");
        return { exit: 0, output: "PASS" };
      },
    } as never);
    expect(seenPath).toBe(join(rec.artifactPath, "accept", "accept.py"));
    expect(frozenDir.startsWith(rec.artifactPath)).toBe(false);
    expect(frozenDir.startsWith(join(p.home, "builds"))).toBe(true);
    expect(rec.outcome).toBe("TAMPER");
    expect(rec.tries[0]!.checkHashOk).toBe(false);
  }, 30_000);
});

describe("s24 limit validation", () => {
  test("CAPS: NaN, Infinity, negative, zero and fractional limits are refused before the approval is used", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const bad = [{ maxTries: Number.NaN }, { maxTries: Number.POSITIVE_INFINITY }, { maxTries: -1 }, { maxTries: 0 }, { maxTries: 1.5 }, { maxUsd: Number.NaN }, { maxUsd: Number.POSITIVE_INFINITY }, { maxUsd: -0.5 }, { maxUsd: 0 }, { maxTurns: 2.5 }, { maxTurns: Number.NaN }, { wallMs: Number.POSITIVE_INFINITY }, { wallMs: -5 }];
    for (const limits of bad) await expect(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits })).rejects.toThrow(/limit|must be/);
    expect(f.seen).toHaveLength(0);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 2, maxUsd: 0.5 } });
    expect(rec.outcome).toBe("PASS");
  }, 60_000);

  test("CLI: build run with a bad --max-tries or --max-usd is refused (exit 2) and the token stays usable", async () => {
    const p = await preparedWith(FALLBACK_CHECK);
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const env = { ...cleanSpawnEnv(), OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file", OFFLOAD_BUILDER_FAKE_SDK: join(import.meta.dir, "fake-sdk.ts"), NODE_ENV: "test" };
    for (const [k, v] of [["--max-tries", "abc"], ["--max-tries", "Infinity"], ["--max-usd", "-1"], ["--max-usd", "NaN"], ["--max-tries", "2.5"]] as const) {
      const r = Bun.spawnSync([process.execPath, "run", CLI, "build", "run", "--brief", p.briefId, "--token", token, "--home", p.home, k, v], { env, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toMatch(/max-(tries|usd)/);
    }
    const ok = Bun.spawnSync([process.execPath, "run", CLI, "build", "run", "--brief", p.briefId, "--token", token, "--home", p.home, "--max-tries", "2", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(ok.stderr.toString()).toBe("");
    expect(ok.exitCode).toBe(0);
  }, 60_000);
});
