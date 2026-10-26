// s24 brief runner: the outcome loop the Cindy eval asked for (EVAL.md "BORROW"). After the exact single-use build
// approval (approval.ts), each try is one Agent SDK query() (ADR 0004) in a fresh workspace with the builder prompt;
// then the RUNNER, not the model, verifies the frozen check's sha256 and runs it. Exit 0 = PASS. A failure feeds the
// exact (truncated) check output into the next try. Caps: tries, USD, turns per try, wall time. DRY RUN: the files
// stay in the workspace; installing them on the user's system is a separate approval (not here).
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIER_MODELS } from "../models/router.ts";
import type { SolutionBrief } from "../solutions/brief.ts";
import { ensureDir } from "../workflows/store.ts";
import { consumeBuildApproval } from "./approval.ts";
import { checkSha, identityMask, type CheckFile, type Mask } from "./checks.ts";
import { buildsDir, DEFAULT_LIMITS, truncateOutput, writeRunRecord, type BuildLimits, type BuildOutcome, type RunRecord, type TryRecord } from "./record.ts";
import { assertSafeExecutionProfile, BASH_ALLOW, BUILDER_TOOLS, builderEnv, builderPermissions, CHECK_DIR, DISALLOWED_TOOLS, type ExecutionProfile } from "./sandbox.ts";

/** The SDK boundary: `query` from @anthropic-ai/claude-agent-sdk, or a fake with recorded messages in tests. */
export type BuilderQuery = (args: { prompt: string; options: Options }) => AsyncIterable<unknown>;

export const BUILD_SYSTEM_APPEND = [
  "You are building a small tool from a brief, in the current folder only. There is no network.",
  `The acceptance check in ${CHECK_DIR}/ decides when you are done. It is read-only: never change, move or delete it.`,
  "Run one plain command at a time (no pipes, redirects or chaining). Stop when the check passes.",
].join("\n");

export function checkCommand(file: CheckFile): string {
  return file === "accept.py" ? `python3 ${CHECK_DIR}/accept.py` : `bun test ./${CHECK_DIR}/accept.test.ts`;
}

export function tryPrompt(b: SolutionBrief, file: CheckFile, prior: { n: number; output: string } | null, mask: Mask = identityMask): string {
  const s = b.spec;
  const lines = [
    mask(s.builderPrompt),
    "",
    "Inputs:",
    ...s.inputs.map((x) => `- ${mask(x)}`),
    "Outputs:",
    ...s.outputs.map((x) => `- ${mask(x)}`),
    `Runs where: ${mask(s.runsWhere)}`,
    "",
    `The acceptance check is ${CHECK_DIR}/${file} (read-only). Run it with: ${checkCommand(file)}`,
    "Build until it passes.",
  ];
  if (prior !== null) lines.push("", `The check failed after try ${prior.n}. Its exact output:`, "<check_output>", prior.output, "</check_output>", "Fix the build so the check passes. Do not change the check.");
  return lines.join("\n");
}

export interface CheckRun {
  exit: number | null;
  output: string;
}
export type CheckRunner = (ws: string, file: CheckFile, env: Record<string, string>, timeoutMs: number) => CheckRun;

/** Runs the frozen check in the workspace (python3, or this bun for accept.test.ts). */
export const runCheckProcess: CheckRunner = (ws, file, env, timeoutMs) => {
  const [cmd, args] = file === "accept.py" ? ["python3", [`${CHECK_DIR}/accept.py`]] : [process.execPath, ["test", `./${CHECK_DIR}/accept.test.ts`]];
  const r = spawnSync(cmd, args, { cwd: ws, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error === undefined ? "" : `\n${r.error.message}`}`;
  return { exit: r.status, output: out };
};

function sdkVersion(): string {
  try {
    const p = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface RunBuildOptions {
  home: string;
  briefId: string;
  token: string;
  query: BuilderQuery;
  profile: ExecutionProfile;
  limits?: Partial<BuildLimits>;
  model?: string;
  mask?: Mask;
  runCheck?: CheckRunner;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export async function runBuild(o: RunBuildOptions): Promise<RunRecord> {
  assertSafeExecutionProfile(o.profile);
  const now = o.now ?? Date.now;
  const limits: BuildLimits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
  const model = o.model ?? TIER_MODELS.sonnet;
  const runCheck = o.runCheck ?? runCheckProcess;
  // The gate first: nothing exists on disk for a run that is not approved.
  const { brief, checks, content } = consumeBuildApproval(o.home, o.briefId, o.token, now());
  const startedAt = now();
  const id = `run_${randomBytes(8).toString("hex")}`;
  const ws = join(buildsDir(o.home), id, "workspace");
  ensureDir(join(ws, CHECK_DIR));
  const checkPath = join(ws, CHECK_DIR, checks.file);
  writeFileSync(checkPath, content, { mode: 0o444 });
  chmodSync(checkPath, 0o444);

  const env = builderEnv(o.env ?? process.env);
  const perms = builderPermissions(ws);
  const bypass = o.profile.mode === "bypass";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("wall time")), limits.wallMs);
  const tries: TryRecord[] = [];
  const reported = new Set<string>();
  let claudeCode: string | null = null;
  let spent = 0;
  let outcome: BuildOutcome = "CAP";
  let reason: string | null = null;
  let prior: { n: number; output: string } | null = null;

  try {
    for (let n = 1; ; n++) {
      if (n > limits.maxTries) {
        reason = `${limits.maxTries} tries without a passing check`;
        break;
      }
      if (spent >= limits.maxUsd) {
        reason = `cost cap $${limits.maxUsd} reached ($${round(spent)})`;
        break;
      }
      if (abort.signal.aborted) {
        reason = `wall time ${limits.wallMs} ms reached`;
        break;
      }
      const t0 = now();
      const options: Options = {
        model,
        cwd: ws,
        systemPrompt: { type: "preset", preset: "claude_code", append: BUILD_SYSTEM_APPEND },
        tools: [...BUILDER_TOOLS],
        allowedTools: [],
        disallowedTools: [...DISALLOWED_TOOLS],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: bypass ? "bypassPermissions" : "default",
        ...(bypass ? { allowDangerouslySkipPermissions: true } : { canUseTool: perms.canUseTool }),
        hooks: { PreToolUse: [{ hooks: [perms.preToolUse] }] },
        maxTurns: limits.maxTurns,
        maxBudgetUsd: round(limits.maxUsd - spent),
        env,
        abortController: abort,
      };
      const rec: TryRecord = { n, result: "no result", turns: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, checkExit: null, checkOutput: "", checkHashOk: true, ms: 0 };
      try {
        for await (const raw of o.query({ prompt: tryPrompt(brief, checks.file, prior, o.mask), options })) {
          const m = raw as Record<string, any>;
          if (m.type === "system" && m.subtype === "init") {
            if (typeof m.claude_code_version === "string") claudeCode = m.claude_code_version;
            if (typeof m.model === "string") reported.add(m.model);
          } else if (m.type === "result") {
            rec.result = String(m.subtype);
            rec.turns = Number(m.num_turns) || 0;
            rec.costUsd = round(Number(m.total_cost_usd) || 0);
            const u = m.usage ?? {};
            rec.tokens = { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0 };
            for (const k of Object.keys(m.modelUsage ?? {})) reported.add(k);
          }
        }
      } catch (err) {
        rec.result = abort.signal.aborted ? "aborted: wall time" : `error: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
      }
      spent = round(spent + rec.costUsd);
      // Tamper check before the check runs: the file must be the approved bytes.
      const now_ = existsSync(checkPath) ? readFileSync(checkPath, "utf8") : null;
      rec.checkHashOk = now_ !== null && checkSha(now_) === checks.sha256;
      if (!rec.checkHashOk) {
        rec.ms = now() - t0;
        tries.push(rec);
        outcome = "TAMPER";
        reason = "the acceptance check changed during the build";
        break;
      }
      if (abort.signal.aborted) {
        rec.ms = now() - t0;
        tries.push(rec);
        reason = `wall time ${limits.wallMs} ms reached`;
        break;
      }
      if (rec.result.startsWith("error:")) {
        rec.ms = now() - t0;
        tries.push(rec);
        outcome = "FAIL";
        reason = `the builder failed: ${rec.result.slice(7)}`;
        break;
      }
      const c = runCheck(ws, checks.file, env, Math.max(1000, Math.min(120_000, limits.wallMs - (now() - startedAt))));
      rec.checkExit = c.exit;
      rec.checkOutput = truncateOutput(c.output);
      rec.ms = now() - t0;
      tries.push(rec);
      if (c.exit === 0) {
        outcome = "PASS";
        reason = null;
        break;
      }
      prior = { n, output: rec.checkOutput };
    }
  } finally {
    clearTimeout(timer);
  }

  const totals = tries.reduce(
    (t, r) => ({ costUsd: round(t.costUsd + r.costUsd), turns: t.turns + r.turns, tokens: { input: t.tokens.input + r.tokens.input, output: t.tokens.output + r.tokens.output, cacheRead: t.tokens.cacheRead + r.tokens.cacheRead } }),
    { costUsd: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0 } },
  );
  const record: RunRecord = {
    version: 1,
    id,
    briefId: brief.id,
    briefHash: brief.hash,
    checkHash: checks.sha256,
    checkFile: checks.file,
    dryRun: true,
    models: { checkWriter: checks.model, builder: model, reported: [...reported].sort() },
    versions: { sdk: sdkVersion(), claudeCode },
    profile: { mode: o.profile.mode, containerSandbox: o.profile.containerSandbox, tools: [...BUILDER_TOOLS], disallowedTools: [...DISALLOWED_TOOLS], bashAllow: [...BASH_ALLOW], limits },
    tries,
    totals,
    startedAt,
    wallMs: now() - startedAt,
    outcome,
    reason,
    artifactPath: ws,
    denials: perms.denials.slice(0, 50),
  };
  writeRunRecord(o.home, record);
  return record;
}
