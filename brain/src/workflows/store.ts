// Workflow folders on disk: $OFFLOAD_HOME/workflows/<id>/{SKILL.md, workflow.json, facts.md, recipients.csv,
// crm-log.csv, scripts/, batches/<hash>.json (live) or <hash>.json.enc (dry run, sealed), approvals.json,
// gate-log.jsonl, dry-run.json.enc, dry-runs/<ts>.json.enc, preparing.json}. All 0600/0700. Sealed files hold OCR
// text and are purged after 7 days (store/vault.ts).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openText, sealText } from "../store/vault.ts";
import { batchHash, type Batch } from "./batch.ts";
import type { ApprovalRecord, GateDecisionLog } from "./gate.ts";
import type { WorkflowJson } from "./types.ts";

export const WORKFLOW_ID_RE = /^wf_[a-z0-9]{4,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export const workflowsDir = (home: string) => join(home, "workflows");
export function workflowDir(home: string, id: string): string {
  if (!WORKFLOW_ID_RE.test(id)) throw new Error(`bad workflow id ${id}`);
  return join(workflowsDir(home), id);
}

export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function workflowExists(home: string, id: string): boolean {
  return WORKFLOW_ID_RE.test(id) && existsSync(join(workflowDir(home, id), "workflow.json"));
}

export function readWorkflow(home: string, id: string): WorkflowJson | null {
  if (!workflowExists(home, id)) return null;
  return JSON.parse(readFileSync(join(workflowDir(home, id), "workflow.json"), "utf8")) as WorkflowJson;
}

export function writeWorkflow(home: string, wf: WorkflowJson): void {
  const dir = workflowDir(home, wf.id);
  ensureDir(dir);
  writePrivate(join(dir, "workflow.json"), JSON.stringify(wf, null, 2) + "\n");
}

export function updateWorkflow(home: string, id: string, change: (wf: WorkflowJson) => void, now: number): WorkflowJson {
  const wf = readWorkflow(home, id);
  if (wf === null) throw new Error(`no workflow ${id}`);
  change(wf);
  wf.updatedAt = now;
  writeWorkflow(home, wf);
  return wf;
}

export function listWorkflows(home: string): WorkflowJson[] {
  const dir = workflowsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => WORKFLOW_ID_RE.test(n))
    .sort()
    .map((id) => readWorkflow(home, id))
    .filter((w): w is WorkflowJson => w !== null);
}

export function deleteWorkflow(home: string, id: string): boolean {
  if (!workflowExists(home, id)) return false;
  rmSync(workflowDir(home, id), { recursive: true, force: true });
  return true;
}

export function readText(home: string, id: string, file: string): string | null {
  const p = join(workflowDir(home, id), file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// ---------- batches ----------

const batchesDir = (home: string, id: string) => join(workflowDir(home, id), "batches");

export class WorkflowGoneError extends Error {}

/** Live batches are plain JSON (the send record); dry-run batches hold OCR-parsed data and are sealed. */
export function saveBatch(home: string, b: Batch): void {
  // Never recreate a folder the user deleted mid-run.
  if (!workflowExists(home, b.workflowId)) throw new WorkflowGoneError(`workflow ${b.workflowId} was deleted`);
  ensureDir(batchesDir(home, b.workflowId));
  const base = join(batchesDir(home, b.workflowId), `${b.hash}.json`);
  const text = JSON.stringify(b, null, 2) + "\n";
  if (b.kind === "dry_run") sealText(home, `${base}.enc`, text, b.createdAt);
  else writePrivate(base, text);
}

/** True when the items on disk still hash to the batch's hash (REVIEW-1 L2). */
export const batchIntact = (b: Batch) => batchHash(b.workflowId, b.kind, b.items) === b.hash;

function parseBatch(text: string | null): Batch | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as Batch;
  } catch {
    return null;
  }
}

export function readBatch(home: string, id: string, hash: string, now: number = Date.now()): Batch | null {
  if (!HASH_RE.test(hash)) return null;
  const p = join(batchesDir(home, id), `${hash}.json`);
  if (existsSync(p)) return parseBatch(readFileSync(p, "utf8"));
  return parseBatch(openText(home, `${p}.enc`, now));
}

export function listBatches(home: string, id: string, now: number = Date.now()): Batch[] {
  const dir = batchesDir(home, id);
  if (!existsSync(dir)) return [];
  const out: Batch[] = [];
  for (const n of readdirSync(dir)) {
    const m = /^([0-9a-f]{64})\.json(\.enc)?$/.exec(n);
    if (m === null) continue;
    const b = m[2] === undefined ? parseBatch(readFileSync(join(dir, n), "utf8")) : parseBatch(openText(home, join(dir, n), now));
    if (b !== null) out.push(b);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.hash < b.hash ? -1 : 1));
}

// ---------- approvals and gate log ----------

export function readApprovals(home: string, id: string): Record<string, ApprovalRecord> {
  const p = join(workflowDir(home, id), "approvals.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, ApprovalRecord>) : {};
}

export function saveApproval(home: string, id: string, hash: string, rec: ApprovalRecord): void {
  const all = readApprovals(home, id);
  all[hash] = rec;
  writePrivate(join(workflowDir(home, id), "approvals.json"), JSON.stringify(all, null, 2) + "\n");
}

/** Uses an approval up: an approval token sends its batch once (REVIEW-1 L1). */
export function deleteApproval(home: string, id: string, hash: string): void {
  const all = readApprovals(home, id);
  if (!(hash in all)) return;
  delete all[hash];
  writePrivate(join(workflowDir(home, id), "approvals.json"), JSON.stringify(all, null, 2) + "\n");
}

export const gateLogPath = (home: string, id: string) => join(workflowDir(home, id), "gate-log.jsonl");

export function readGateLog(home: string, id: string): GateDecisionLog[] {
  const p = gateLogPath(home, id);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GateDecisionLog);
}
