// s24 run records: append-only. Each build writes builds/<run_id>.json once (never overwritten) and one line in
// builds/runs.jsonl. No prompt and no key is stored; check output is truncated. The latest run of a brief feeds the
// additive `build` field of its solution option (hours saved vs cost).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefIdFor } from "../solutions/brief.ts";
import type { SolutionSet } from "../solutions/types.ts";
import { ensureDir } from "../workflows/store.ts";
import type { CheckFile } from "./checks.ts";
import { findSecret, secretValues, type ExecutionMode } from "./sandbox.ts";

export const RUN_ID_RE = /^run_[a-z0-9]{12,40}$/;
export type BuildOutcome = "PASS" | "FAIL" | "CAP" | "TAMPER";
export const MAX_CHECK_OUTPUT = 4000;

export interface BuildLimits {
  maxTries: number;
  maxUsd: number;
  maxTurns: number;
  wallMs: number;
}
export const DEFAULT_LIMITS: Readonly<BuildLimits> = { maxTries: 3, maxUsd: 1, maxTurns: 30, wallMs: 10 * 60_000 };

export interface TryRecord {
  n: number;
  /** SDK result subtype (success, error_max_turns, ...) or "error: ..." when the query threw. */
  result: string;
  turns: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number };
  /** null when the check did not run (tamper, error). */
  checkExit: number | null;
  checkOutput: string;
  checkHashOk: boolean;
  ms: number;
}

export interface RunRecord {
  version: 1;
  id: string;
  briefId: string;
  briefHash: string;
  checkHash: string;
  checkFile: CheckFile;
  dryRun: true;
  models: { checkWriter: string; builder: string; reported: string[] };
  versions: { sdk: string; claudeCode: string | null };
  profile: { mode: ExecutionMode; containerSandbox: boolean; /** The OS sandbox builder code ran in. */ sandbox: "sandbox-exec" | "container"; tools: string[]; disallowedTools: string[]; bashAllow: string[]; limits: BuildLimits };
  tries: TryRecord[];
  totals: { costUsd: number; tokens: { input: number; output: number; cacheRead: number }; turns: number };
  startedAt: number;
  wallMs: number;
  outcome: BuildOutcome;
  /** Why it stopped short of PASS (tries, cost, wall time, tamper, error). */
  reason: string | null;
  /** The workspace holding the built files. Nothing is installed: applying it is a separate approval. */
  artifactPath: string;
  /** sha256 over the workspace (paths, types, content; .tmp and __pycache__ left out) taken at the verdict, after every
   * builder process was stopped. A later install step must refuse when verifyArtifact() is false. */
  artifactSha256: string;
  denials: Array<{ tool: string; reason: string }>;
}

export const buildsDir = (home: string) => join(home, "builds");

const SKIP_DIRS = new Set([".tmp", "__pycache__"]);

/** Deterministic digest of a workspace tree. */
export function artifactDigest(ws: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        h.update(`d\0${r}\n`);
        walk(abs, r);
      } else if (st.isSymbolicLink()) h.update(`l\0${r}\0${readlinkSync(abs)}\n`);
      else if (st.isFile()) h.update(`f\0${r}\0${createHash("sha256").update(readFileSync(abs)).digest("hex")}\n`);
      else h.update(`o\0${r}\n`);
    }
  };
  walk(ws, "");
  return h.digest("hex");
}

const MAX_SCAN_BYTES = 16 * 1024 * 1024;

/** The first workspace file holding a secret (exact known value or secret-shaped string), as "path: what", or null. */
export function scanArtifactForSecrets(ws: string, known: readonly string[] = []): string | null {
  const walk = (dir: string, rel: string): string | null => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        // accept/ is the frozen, approved check (not builder output); .tmp and caches are not the artifact.
        if (SKIP_DIRS.has(name) || r === "accept") continue;
        const hit = walk(abs, r);
        if (hit !== null) return hit;
      } else if (st.isFile()) {
        const buf = readFileSync(abs);
        const what = findSecret(buf.subarray(0, MAX_SCAN_BYTES).toString("latin1"), known);
        if (what !== null) return `${r}: ${what}`;
      }
    }
    return null;
  };
  return walk(ws, "");
}

/** True when the run's workspace is byte-for-byte what it was at the verdict and holds no secret. Install must check
 * this first. */
export function verifyArtifact(home: string, runId: string, known: readonly string[] = secretValues(process.env)): boolean {
  const r = readRunRecord(home, runId);
  if (r === null || typeof r.artifactSha256 !== "string" || !existsSync(r.artifactPath)) return false;
  return artifactDigest(r.artifactPath) === r.artifactSha256 && scanArtifactForSecrets(r.artifactPath, known) === null;
}

export function truncateOutput(s: string, max = MAX_CHECK_OUTPUT): string {
  return s.length <= max ? s : `…[${s.length - max} chars cut]\n${s.slice(s.length - max)}`;
}

export function writeRunRecord(home: string, r: RunRecord): string {
  if (!RUN_ID_RE.test(r.id)) throw new Error(`bad run id ${r.id}`);
  ensureDir(buildsDir(home));
  const p = join(buildsDir(home), `${r.id}.json`);
  // "wx": a record is written once; a second write of the same id throws.
  writeFileSync(p, JSON.stringify(r, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  appendFileSync(join(buildsDir(home), "runs.jsonl"), JSON.stringify({ id: r.id, briefId: r.briefId, outcome: r.outcome, costUsd: r.totals.costUsd, tries: r.tries.length, at: r.startedAt }) + "\n", { mode: 0o600 });
  return p;
}

export function readRunRecord(home: string, id: string): RunRecord | null {
  if (!RUN_ID_RE.test(id)) return null;
  const p = join(buildsDir(home), `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunRecord) : null;
}

export interface BuildSummary {
  runId: string;
  outcome: BuildOutcome;
  costUsd: number;
  tries: number;
  /** Cost of all build runs of this brief so far. */
  totalCostUsd: number;
}

export function latestBuild(home: string, briefId: string): BuildSummary | null {
  const p = join(buildsDir(home), "runs.jsonl");
  if (!existsSync(p)) return null;
  let last: BuildSummary | null = null;
  let total = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      const v = JSON.parse(line) as { id: string; briefId: string; outcome: BuildOutcome; costUsd: number; tries: number };
      if (v.briefId !== briefId) continue;
      total += v.costUsd;
      last = { runId: v.id, outcome: v.outcome, costUsd: v.costUsd, tries: v.tries, totalCostUsd: 0 };
    } catch {
      // A torn last line is skipped; earlier records stand.
    }
  }
  return last === null ? null : { ...last, totalCostUsd: Math.round(total * 1e6) / 1e6 };
}

/** Additive: each brief option gets `build` (its latest run's outcome and cost) when it has been built. */
export function withBuildCosts(home: string, set: SolutionSet): SolutionSet {
  return {
    ...set,
    options: set.options.map((o) => {
      if (o.handoff.to !== "brief") return o;
      const b = latestBuild(home, briefIdFor(set.subjectId, o.kind));
      return b === null ? o : { ...o, build: b };
    }),
  };
}
