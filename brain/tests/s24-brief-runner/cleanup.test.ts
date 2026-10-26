// RECORD / SAFETY (Codex review of 070ff26): every resource a run creates is released on every exit path, and the
// run is always recorded. Resources: the supervisor process (and its sandbox instance), the runner's command socket
// server, the /tmp/ofl-* folder, builds/<run>/cred/ (apiKeyHelper + key file), the wall timer, check processes.
// Paths: PASS, FAIL, CAP, TAMPER, a thrown error, an unreadable artifact, SIGTERM to the runner.
// Also: a large JUnit report must not block bun (the harness reads it while bun runs, capped).
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { checksDir, checkSha, writeChecks } from "../../src/builder/checks.ts";
import { readRunRecord } from "../../src/builder/record.ts";
import { runBuild, type CheckRunner } from "../../src/builder/runner.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { briefHome, cleanSpawnEnv, fakeQuery, fakeRouted, NOW, prepared, tmp, writeSlug, type FakeTry, releaseTemps } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const KEY = "sk-ant-api03-S24CLEANUPKEYs24cleanup0123456789abcdef";
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: KEY };
const oflDirs = () => new Set(readdirSync("/tmp").filter((n) => n.startsWith("ofl-")));
const supervisors = (ws: string) =>
  spawnSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l.includes("harness.py") && l.includes(" serve ") && l.includes(ws));

/** Asserts nothing of the run remains: no cred/, no supervisor, no new /tmp/ofl-* folder, and a record exists. */
async function assertReleased(home: string, runId: string | null, ws: string, before: Set<string>) {
  await Bun.sleep(300);
  const runDir = join(ws, "..");
  expect(existsSync(join(runDir, "cred"))).toBe(false);
  expect(supervisors(ws)).toEqual([]);
  expect([...oflDirs()].filter((d) => !before.has(d))).toEqual([]);
  if (runId !== null) expect(readRunRecord(home, runId)).not.toBeNull();
}

async function rawCheck(content: string, file: "accept.py" | "accept.test.ts" = "accept.py") {
  const b = briefHome();
  const { model } = fakeRouted(b.home);
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  const dir = checksDir(b.home, b.briefId);
  writeFileSync(join(dir, file), content);
  const set = { ...c.set, file, sha256: checkSha(content) };
  writeFileSync(join(dir, "checks.json"), JSON.stringify(set, null, 2) + "\n");
  return { ...b, checkHash: set.sha256 };
}

async function run(tries: FakeTry[], extra: { limits?: object; runCheck?: CheckRunner } = {}) {
  const before = oflDirs();
  const p = await prepared();
  const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
  let ws = "";
  const f = fakeQuery(tries.map((t): FakeTry => ({ ...t, act: async (w, o) => { ws = w; await t.act?.(w, o); } })));
  const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, env: ENV, limits: extra.limits ?? {}, ...(extra.runCheck ? { runCheck: extra.runCheck } : {}) });
  return { p, rec, ws: ws || rec.artifactPath, before };
}

describe("s24 every exit path releases everything", () => {
  test("RECORD: PASS releases the supervisor, socket folder and cred/", async () => {
    const { p, rec, ws, before } = await run([{ act: writeSlug("good") }]);
    expect(rec.outcome).toBe("PASS");
    await assertReleased(p.home, rec.id, ws, before);
  }, 30_000);

  test("RECORD: FAIL (builder error) releases everything", async () => {
    const { p, rec, ws, before } = await run([{ throws: "process exited 1" }]);
    expect(rec.outcome).toBe("FAIL");
    await assertReleased(p.home, rec.id, ws, before);
  }, 30_000);

  test("RECORD: CAP releases everything", async () => {
    const { p, rec, ws, before } = await run([{ act: writeSlug("bad") }], { limits: { maxTries: 1 } });
    expect(rec.outcome).toBe("CAP");
    await assertReleased(p.home, rec.id, ws, before);
  }, 30_000);

  test("RECORD: TAMPER releases everything", async () => {
    const { p, rec, ws, before } = await run([{ act: (w) => { writeSlug("good")(w); chmodSync(join(w, "accept", "accept.py"), 0o644); writeFileSync(join(w, "accept", "accept.py"), "x\n"); } }]);
    expect(rec.outcome).toBe("TAMPER");
    await assertReleased(p.home, rec.id, ws, before);
  }, 30_000);

  test("RECORD: an error thrown inside the run is recorded as FAIL and releases everything", async () => {
    const boom: CheckRunner = () => {
      throw new Error("check runner exploded");
    };
    const { p, rec, ws, before } = await run([{ act: writeSlug("good") }], { runCheck: boom });
    expect(rec.outcome).toBe("FAIL");
    expect(rec.reason ?? "").toContain("exploded");
    await assertReleased(p.home, rec.id, ws, before);
  }, 30_000);

  test("RECORD: an artifact file made unreadable by builder code is a recorded FAIL ('artifact unreadable') and releases everything", async () => {
    const { p, rec, ws, before } = await run([{ act: (w) => { writeSlug("good")(w); writeFileSync(join(w, "locked.txt"), "x"); chmodSync(join(w, "locked.txt"), 0); } }]);
    expect(rec.outcome).toBe("FAIL");
    expect(rec.reason ?? "").toContain("artifact unreadable");
    await assertReleased(p.home, rec.id, ws, before);
    chmodSync(join(ws, "locked.txt"), 0o644);
  }, 30_000);

  test("RECORD: SIGTERM to the runner (CLI) releases the supervisor, socket folder and cred/", async () => {
    const before = oflDirs();
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const dir = tmp("offload-s24-fake-");
    const fake = join(dir, "slow-sdk.ts");
    writeFileSync(fake, `export function query(args: { options: { cwd?: string } }) { return (async function* () { require("node:fs").writeFileSync(${JSON.stringify(join(dir, "ws.txt"))}, args.options.cwd!); yield { type: "system", subtype: "init" }; await Bun.sleep(30000); })(); }\n`);
    const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const child = spawn(process.execPath, ["run", CLI, "build", "run", "--brief", p.briefId, "--token", token, "--home", p.home], {
      env: { ...cleanSpawnEnv(), OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file", OFFLOAD_BUILDER_FAKE_SDK: fake, NODE_ENV: "test", OFFLOAD_ANTHROPIC_KEYCHAIN: "offload-s24-test-service/none" },
      stdio: "ignore",
    });
    for (let i = 0; i < 100 && !existsSync(join(dir, "ws.txt")); i++) await Bun.sleep(100);
    const ws = require("node:fs").readFileSync(join(dir, "ws.txt"), "utf8") as string;
    expect(existsSync(join(ws, "..", "cred"))).toBe(true);
    expect(supervisors(ws).length).toBe(1);
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    await assertReleased(p.home, null, ws, before);
  }, 40_000);
});

describe("s24 JUnit report size", () => {
  test("SAFETY: a large JUnit report does not block bun (read while it runs): many passing tests still PASS", async () => {
    const check = ['import { expect, test } from "bun:test";', 'for (let i = 0; i < 3000; i++) test("case " + i + " " + "x".repeat(120), () => { expect(1).toBe(1); });', ""].join("\n");
    const p = await rawCheck(check, "accept.test.ts");
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: fakeQuery([{ act: writeSlug("good") }]).query, profile: ALLOW, limits: { maxTries: 1, wallMs: 25_000 } });
    expect(rec.outcome).toBe("PASS");
  }, 60_000);

  test("SAFETY: a JUnit report over the cap is not a PASS ('report too large')", async () => {
    const check = ['import { expect, test } from "bun:test";', 'for (let i = 0; i < 5000; i++) test("case " + i + " " + "y".repeat(2000), () => { expect(1).toBe(1); });', ""].join("\n");
    const p = await rawCheck(check, "accept.test.ts");
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: fakeQuery([{ act: writeSlug("good") }]).query, profile: ALLOW, limits: { maxTries: 1, wallMs: 40_000 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.tries.map((t) => t.checkOutput).join("\n")).toContain("report too large");
  }, 90_000);
});

