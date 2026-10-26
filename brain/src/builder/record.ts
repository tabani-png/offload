// s24 run records: append-only. Each build writes builds/<run_id>.json once (never overwritten) and one line in
// builds/runs.jsonl. No prompt and no key is stored; check output is truncated. The latest run of a brief feeds the
// additive `build` field of its solution option (hours saved vs cost).
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { appendFileSync, closeSync, mkdirSync, rmSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
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

/** Disposable folders: deleted from the workspace (after the final sweep) before the artifact is hashed; nothing that
 * remains is exempt from the hash or the secret scan, and verifyArtifact fails if one reappears. */
const DISPOSABLE_NAMES = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const isDisposable = (rel: string, name: string) => DISPOSABLE_NAMES.has(name) || rel === ".tmp" || rel === "node_modules/.cache" || rel.endsWith("/node_modules/.cache");

/** Relative paths of disposable folders in the workspace. */
export function findDisposables(ws: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (!lstatSync(abs).isDirectory()) continue;
      if (isDisposable(r, name)) out.push(r);
      else walk(abs, r);
    }
  };
  walk(ws, "");
  return out;
}

/** Deletes the disposable folders (never follows links; rmSync does not). `.tmp` is recreated empty while builds
 * continue (it is the builder's TMPDIR) and left out at the end. Returns what was removed. */
export function removeDisposables(ws: string, keepTmp: boolean): string[] {
  const gone = findDisposables(ws);
  for (const r of gone) rmSync(join(ws, r), { recursive: true, force: true });
  if (keepTmp) mkdirSync(join(ws, ".tmp"), { recursive: true, mode: 0o700 });
  return gone;
}

/** Deterministic digest of a workspace tree. */
export function artifactDigest(ws: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        h.update(`d\0${r}\n`);
        walk(abs, r);
      } else if (st.isSymbolicLink()) h.update(`l\0${r}\0${readlinkSync(abs)}\n`);
      else if (st.isFile()) h.update(`f\0${r}\0${fileSha(abs)}\n`);
      else h.update(`o\0${r}\n`);
    }
  };
  walk(ws, "");
  return h.digest("hex");
}

/** sha256 of a file, read in chunks (never the whole file in memory). */
function fileSha(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** The whole workspace above this is not inspected: the run fails closed ("workspace too large"). */
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/** Sizes the workspace from metadata only (lstat; no file is read): a file over the scan cap, a sparse file (huge
 * logical length, few real blocks) or a workspace over the total cap is a problem, returned as text; else null. */
export function checkArtifactLimits(ws: string): string | null {
  let total = 0;
  const walk = (dir: string, rel: string): string | null => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        const hit = walk(abs, r);
        if (hit !== null) return hit;
      } else if (st.isFile()) {
        if (st.size > 4 * 1024 * 1024 && st.blocks * 512 < st.size / 4) return `${r}: sparse file (${Math.ceil(st.size / (1024 * 1024))} MB logical, ${Math.ceil((st.blocks * 512) / (1024 * 1024))} MB on disk)`;
        if (st.size > MAX_SCAN_BYTES) return `${r}: too large to scan (${Math.ceil(st.size / (1024 * 1024))} MB, limit ${MAX_SCAN_BYTES / (1024 * 1024)} MB)`;
        total += st.size;
        if (total > MAX_ARTIFACT_BYTES) return `workspace too large (over ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB)`;
      }
    }
    return null;
  };
  return walk(ws, "");
}

async function eachChunk(path: string, deadline: number, fn: (b: Buffer) => boolean | void): Promise<void> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      if (Date.now() > deadline) throw new Error("ran out of time reading the artifact");
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) return;
      if (fn(buf.subarray(0, bytesRead)) === true) return;
    }
  } finally {
    await fh.close();
  }
}

async function eachFile(ws: string, fn: (abs: string, rel: string, st: Stats) => Promise<string | null> | string | null, skipRel: ReadonlySet<string> = new Set()): Promise<string | null> {
  const walk = async (dir: string, rel: string): Promise<string | null> => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        if (skipRel.has(r)) continue;
        const hit = await fn(abs, r, st);
        if (hit !== null) return hit;
        const sub = await walk(abs, r);
        if (sub !== null) return sub;
      } else {
        const hit = await fn(abs, r, st);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  return walk(ws, "");
}

/** artifactDigest, read asynchronously in chunks (never blocks the event loop), stopping at the deadline. Same value. */
export async function artifactDigestAsync(ws: string, deadline: number): Promise<string> {
  const h = createHash("sha256");
  await eachFile(ws, async (abs, r, st) => {
    if (st.isDirectory()) h.update(`d\0${r}\n`);
    else if (st.isSymbolicLink()) h.update(`l\0${r}\0${readlinkSync(abs)}\n`);
    else if (st.isFile()) {
      const fh = createHash("sha256");
      await eachChunk(abs, deadline, (b) => void fh.update(b));
      h.update(`f\0${r}\0${fh.digest("hex")}\n`);
    } else h.update(`o\0${r}\n`);
    return null;
  });
  return h.digest("hex");
}

/** scanArtifactForSecrets, read asynchronously in overlapping chunks, stopping at the deadline. */
export async function scanArtifactForSecretsAsync(ws: string, known: readonly string[], deadline: number): Promise<string | null> {
  const overlap = Math.max(4096, ...known.map((k) => k.length));
  return eachFile(
    ws,
    async (abs, r, st) => {
    if (!st.isFile()) return null;
    if (st.size > MAX_SCAN_BYTES) return `${r}: too large to scan`;
    // accept/ is the frozen, approved check: exact known values only (its fixtures may look secret).
    const patterns = !r.startsWith("accept/");
    let carry = "";
    let what: string | null = null;
    await eachChunk(abs, deadline, (b) => {
      const text = carry + b.toString("latin1");
      what = findSecret(text, known, patterns);
      carry = text.slice(-overlap);
      return what !== null;
    });
    return what === null ? null : `${r}: ${what}`;
    },
  );
}

/** Files above this are not scanned: the run fails closed ("too large to scan"). */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const SCAN_CHUNK = 1 << 20;

/** Scans a whole file in overlapping chunks (overlap >= the longest known secret and any secret shape's prefix). */
function scanFile(path: string, size: number, known: readonly string[], patterns = true): string | null {
  if (size > MAX_SCAN_BYTES) return `too large to scan (${Math.ceil(size / (1024 * 1024))} MB, limit ${MAX_SCAN_BYTES / (1024 * 1024)} MB)`;
  const overlap = Math.max(4096, ...known.map((k) => k.length));
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(SCAN_CHUNK);
    let carry = "";
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      const text = carry + buf.subarray(0, n).toString("latin1");
      const what = findSecret(text, known, patterns);
      if (what !== null) return what;
      carry = text.slice(-overlap);
    }
  } finally {
    closeSync(fd);
  }
  return null;
}

/** The first workspace file holding a secret (exact known value or secret-shaped string), as "path: what", or null. */
export function scanArtifactForSecrets(ws: string, known: readonly string[] = []): string | null {
  const walk = (dir: string, rel: string, patterns = true): string | null => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        // accept/ is the frozen, approved check: exact known values only (its test fixtures may look secret).
        if (r === "accept") {
          const hit = walk(abs, r, false);
          if (hit !== null) return hit;
          continue;
        }
        const hit = walk(abs, r, patterns);
        if (hit !== null) return hit;
      } else if (st.isFile()) {
        const what = scanFile(abs, st.size, known, patterns);
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
  if (checkArtifactLimits(r.artifactPath) !== null || findDisposables(r.artifactPath).length > 0) return false;
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
