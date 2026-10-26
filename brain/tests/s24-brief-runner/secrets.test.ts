// SAFETY (key exposure through KERN_PROCARGS2): sandboxed builder code can read the argv and environment of every
// same-user process, and the sandbox cannot stop it. So no process in a build may carry the key or token in its
// environment: the Claude Code child gets the key through apiKeyHelper (a script outside the sandbox's reach), a brain
// started with the key in its own environment refuses to build (that memory stays readable even after
// `delete process.env.X`), and an artifact that contains a secret is never a PASS.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { verifyArtifact } from "../../src/builder/record.ts";
import { runBuild, type BuilderQuery } from "../../src/builder/runner.ts";
import { UnsafeProfileError } from "../../src/builder/sandbox.ts";
import { cleanSpawnEnv, fakeQuery, NOW, prepared, shell, withLaunchEnv, writeSlug, releaseTemps } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const KEY = "sk-ant-api03-S24KEYSENTINELs24keysentinel0123456789abcdef";
const OAUTH = "sk-ant-oat01-S24OAUTHSENTINELs24oauth0123456789abcdef";
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH };

// Scans EVERY same-user process's argv + environment (KERN_PROCARGS2) for the sentinels.
const SCAN = String.raw`import ctypes, ctypes.util, os
libc = ctypes.CDLL(ctypes.util.find_library("c"))
hits = []
for pid in range(1, 100000):
    mib = (ctypes.c_int * 3)(1, 49, pid); sz = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(sz), None, 0) != 0 or sz.value == 0:
        continue
    buf = ctypes.create_string_buffer(sz.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(sz), None, 0) != 0:
        continue
    if b"S24KEYSENTINEL" in buf.raw or b"S24OAUTHSENTINEL" in buf.raw:
        hits.append(pid)
print("SCANNED hits=" + ",".join(map(str, hits)))
`;

describe("s24 no secret in any readable environment", () => {
  test("SAFETY: the Claude Code child gets no key or token in its env; the key comes from an apiKeyHelper outside the sandbox", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let blocked = "";
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          writeSlug("good")(ws);
          const helper = (o.settings as { apiKeyHelper?: string } | undefined)?.apiKeyHelper ?? "";
          writeFileSync(join(ws, "peek.py"), `import sys\nfor p in sys.argv[1:]:\n    try:\n        print('ESCAPED ' + open(p).read()[:200])\n    except Exception as e:\n        print('BLOCKED ' + p)\n`);
          const keyFile = readFileSync(helper, "utf8").match(/'([^']+)'/)?.[1] ?? helper;
          const r = await o.canUseTool!("Bash", { command: `python3 peek.py ${helper} ${keyFile}` }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          blocked = r?.behavior === "allow" ? (await shell(String((r as unknown as { updatedInput: { command: string } }).updatedInput.command), ws)).stdout : `DENIED ${(r as { message?: string } | null)?.message ?? ""}`;
        },
      },
    ]);
    await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, env: ENV });
    const o = f.seen[0]!.options;
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(o.env)).not.toContain("S24KEYSENTINEL");
    const helper = (o.settings as { apiKeyHelper?: string } | undefined)?.apiKeyHelper;
    expect(typeof helper).toBe("string");
    expect(JSON.stringify(o.settings)).not.toContain("S24KEYSENTINEL");
    expect(blocked).not.toContain("ESCAPED");
    expect(blocked).not.toContain("S24KEYSENTINEL");
  }, 30_000);

  test("SAFETY: no same-user process carries the key or token in its argv/environment while builder code runs (KERN_PROCARGS2 scan)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let scanned = "";
    // Like the real SDK: a separate "Claude Code" process started with options.env runs the builder's command.
    const query: BuilderQuery = (args) =>
      (async function* () {
        yield { type: "system", subtype: "init", claude_code_version: "2.1.310", model: "claude-sonnet-5-5" };
        const ws = args.options.cwd!;
        writeSlug("good")(ws);
        writeFileSync(join(ws, "scan.py"), SCAN);
        const r = await args.options.canUseTool!("Bash", { command: "python3 scan.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
        const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
        scanned = await new Promise<string>((res) => {
          let s = "";
          // A long-lived bun process holding options.env, like Claude Code (a non-platform binary, so its environment
          // is readable through KERN_PROCARGS2; /bin/sh's is hidden by macOS).
          const claude = spawn(process.execPath, ["-e", 'require("node:child_process").spawnSync("/bin/sh", ["-c", process.env.S24_CMD], { stdio: "inherit" })'], { cwd: ws, env: { ...(args.options.env as Record<string, string>), S24_CMD: cmd } });
          claude.stdout.on("data", (b) => (s += b));
          claude.on("close", () => res(s));
        });
        yield { type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, modelUsage: {} };
      })();
    await runBuild({ home: p.home, briefId: p.briefId, token, query, profile: ALLOW, env: ENV });
    expect(scanned).toContain("SCANNED hits=");
    expect(scanned).toContain("SCANNED hits=\n");
  }, 60_000);

  test("SAFETY: a brain started with the key or token in its own environment refuses to build (and keeps the approval)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    await withLaunchEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: KEY }, async () => {
      await expect(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW })).rejects.toBeInstanceOf(UnsafeProfileError);
    });
    expect(f.seen).toHaveLength(0);
    expect((await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW })).outcome).toBe("PASS");
    // The CLI too.
    const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const q = await prepared();
    const t2 = approveBuild(q.home, q.briefId, q.briefHash, q.checkHash, NOW).token;
    const r = spawnSync(process.execPath, ["run", CLI, "build", "run", "--brief", q.briefId, "--token", t2, "--home", q.home], { env: { ...cleanSpawnEnv(), OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file", OFFLOAD_BUILDER_FAKE_SDK: join(import.meta.dir, "fake-sdk.ts"), NODE_ENV: "test", CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  }, 60_000);
});

describe("s24 artifact secret scan", () => {
  test("SAFETY: an artifact holding a known secret value is not a PASS", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); writeFileSync(join(ws, "config.txt"), `key=${KEY.slice(0, 20)}${KEY.slice(20)}\n`); } }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, env: ENV, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("artifact contains a secret");
  }, 30_000);

  test("SAFETY: an artifact holding a secret-shaped string is not a PASS; a clean artifact verifies", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); writeFileSync(join(ws, "notes.md"), "use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab here\n"); } }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("artifact contains a secret");

    const q = await prepared();
    const t2 = approveBuild(q.home, q.briefId, q.briefHash, q.checkHash, NOW).token;
    const good = await runBuild({ home: q.home, briefId: q.briefId, token: t2, query: fakeQuery([{ act: writeSlug("good") }]).query, profile: ALLOW });
    expect(good.outcome).toBe("PASS");
    expect(verifyArtifact(q.home, good.id)).toBe(true);
    expect(existsSync(good.artifactPath)).toBe(true);
  }, 30_000);
});
