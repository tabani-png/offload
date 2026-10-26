// s24 test setup: a draft brief on disk (the s22 LinkedIn remove_step fixture, through the real s22 code), a fake
// router backend replaying the recorded check-writer reply, and a fake Agent SDK query() that acts in the workspace
// like a builder would (writes files, asks canUseTool) and replies with recorded result messages.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChecks } from "../../src/builder/checks.ts";
import * as sandbox from "../../src/builder/sandbox.ts";
import { oflPrefix } from "../../src/builder/supervisor.ts";
import type { BuilderQuery } from "../../src/builder/runner.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { ModelRouter, RoutedModel, type Backend, type BackendRequest } from "../../src/models/router.ts";
import { writeBrief } from "../../src/solutions/brief.ts";
import { rulesSolutions } from "../../src/solutions/rules.ts";
import { buildFixture, LINKEDIN_IMAGE } from "../s22-solution-designer/fixtures.ts";

process.env.OFFLOAD_KEYS ??= "file";
// The builder is off by default (sandboxed code can read same-user process environments); these tests opt in.
process.env.OFFLOAD_BUILDER_ENABLED = "1";

// The build preflight refuses secret-bearing variables in the brain's LAUNCH environment (sandbox.ts launchEnv). The
// developer/agent shell running these tests may carry such variables (e.g. CLAUDE_CODE_MESSAGING_TOKEN), so tests see
// a clean launch environment by default; the preflight tests set their own with withLaunchEnv().
const sb = sandbox as unknown as { launchEnv?: { read: () => Record<string, string> }; secretEnvNames?: (e: Record<string, string>) => string[] };
const CLEAN_LAUNCH = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" });
if (sb.launchEnv) sb.launchEnv.read = CLEAN_LAUNCH;

export async function withLaunchEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  if (!sb.launchEnv) return fn();
  sb.launchEnv.read = () => env;
  try {
    return await fn();
  } finally {
    sb.launchEnv.read = CLEAN_LAUNCH;
  }
}

/** process.env without secret-bearing variables, for spawning a CLI that should start "clean". */
export function cleanSpawnEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const drop = sb.secretEnvNames ? sb.secretEnvNames(env) : Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k));
  for (const k of drop) delete env[k];
  return env;
}
export const NOW = new Date(2026, 9, 26, 12).getTime();
export const REC = join(import.meta.dir, "recorded");
export const CHECK_REPLY = readFileSync(join(REC, "check-writer.json"), "utf8");

/** Every temp folder this process's s24 tests created; releaseTemps() removes them (each test file calls it in
 * afterAll) and fails if any is still there, so repeated runs do not fill the disk. */
const createdTemps: string[] = [];
const RUN_START = Date.now() - 1000;
// s30: every folder carries this process's pid, so the stray check below sees only this process's folders, never those
// of another test run on the same Mac (another agent, another worktree) that happens to be alive at the same time.
const MINE = `p${process.pid}-`;
export const tmp = (prefix = "offload-s24-") => {
  const d = mkdtempSync(join(tmpdir(), `${prefix}${MINE}`));
  createdTemps.push(d);
  return d;
};

export function releaseTemps(): void {
  for (const d of createdTemps.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // a file a test made unreadable/read-only: make it writable and retry once
      spawnSync("/bin/chmod", ["-R", "u+rwX", d]);
      rmSync(d, { recursive: true, force: true });
    }
    if (existsSync(d)) throw new Error(`temp folder left behind: ${d}`);
  }
  // And nothing this run created outside tmp(): an offload-s24-* folder born after this process started is a leak.
  const strays = readdirSync(tmpdir())
    .filter((n) => n.startsWith("offload-s24-") && n.includes(MINE))
    .map((n) => join(tmpdir(), n))
    .filter((d) => {
      try {
        return statSync(d).birthtimeMs >= RUN_START;
      } catch {
        return false;
      }
    });
  if (strays.length > 0) throw new Error(`temp folders created by this run were left behind: ${strays.slice(0, 5).join(", ")}`);
}

/** /tmp/ofl-* socket folders made by process `pid` (this test process by default; a spawned CLI's pid for the CLI).
 * Only that process's folders: another test run alive at the same time has its own. */
export const oflDirs = (pid: number = process.pid) => new Set(readdirSync("/tmp").filter((n) => n.startsWith(oflPrefix(pid))));

/** The /tmp/ofl-* folder a run's sandbox profile names (builds/<run>/sandbox.sb), or null when there is no profile. */
export function runSocketDir(runDir: string): string | null {
  const p = join(runDir, "sandbox.sb");
  if (!existsSync(p)) return null;
  const m = /\/(ofl-[^/"]+)\//.exec(readFileSync(p, "utf8"));
  return m?.[1] ?? null;
}

export function briefHome(prefix?: string): { home: string; briefId: string; briefHash: string } {
  const home = tmp(prefix);
  const f = buildFixture(LINKEDIN_IMAGE);
  const set = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
  const option = set.options.find((o) => o.kind === "remove_step")!;
  const { brief } = writeBrief(home, set, option, NOW);
  return { home, briefId: brief.id, briefHash: brief.hash };
}

/** The router over a fake backend: records each request, answers with `reply`. */
export function fakeRouted(home: string, reply: string | ((r: BackendRequest) => string) = CHECK_REPLY) {
  const calls: BackendRequest[] = [];
  const backend: Backend = {
    kind: "api",
    metered: true,
    async complete(req) {
      calls.push(req);
      return { text: typeof reply === "string" ? reply : reply(req), stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0 }, model: req.model };
    },
  };
  return { model: new RoutedModel(new ModelRouter({ home, backend, monthlyBudgetUsd: null, env: {} })), calls };
}

export async function prepared(prefix?: string) {
  const b = briefHome(prefix);
  const { model, calls } = fakeRouted(b.home);
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  return { ...b, checkHash: c.set.sha256, checks: c, calls };
}

export interface FakeTry {
  /** Runs in the workspace before the result: write files, call canUseTool. */
  act?: (ws: string, options: Parameters<BuilderQuery>[0]["options"]) => Promise<void> | void;
  costUsd?: number;
  turns?: number;
  subtype?: string;
  throws?: string;
}

/** A fake query(): try i plays tries[i] (the last one repeats). Records every prompt and options. */
export function fakeQuery(tries: FakeTry[]) {
  const seen: Array<Parameters<BuilderQuery>[0]> = [];
  const query: BuilderQuery = (args) => {
    seen.push(args);
    const t = tries[Math.min(seen.length - 1, tries.length - 1)]!;
    return (async function* () {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.310", model: "claude-sonnet-5-5", cwd: args.options.cwd, tools: args.options.tools };
      if (t.throws !== undefined) throw new Error(t.throws);
      await t.act?.(args.options.cwd!, args.options);
      yield { type: "result", subtype: t.subtype ?? "success", num_turns: t.turns ?? 4, total_cost_usd: t.costUsd ?? 0.05, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 }, modelUsage: { "claude-sonnet-5-5": {} }, result: "done" };
    })();
  };
  return { query, seen };
}

/** Runs a (wrapped) builder command through /bin/sh the way Claude Code does: in ANOTHER process, without blocking
 * this one (the runner in this process owns the command socket). Returns stdout + stderr and the exit code. */
export function shell(cmd: string, cwd: string, env: Record<string, string | undefined> = process.env): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((done) => {
    const c = require("node:child_process").spawn("/bin/sh", ["-c", cmd], { cwd, env });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (b: Buffer) => (stdout += b));
    c.stderr.on("data", (b: Buffer) => (stderr += b));
    c.on("close", (status: number | null) => done({ stdout, stderr, status }));
  });
}

export const writeSlug = (which: "good" | "bad") => (ws: string) => copyFileSync(join(REC, `slug-${which}.py`), join(ws, "slug.py"));
