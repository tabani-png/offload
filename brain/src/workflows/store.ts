// Workflow folders on disk: $OFFLOAD_HOME/workflows/<id>/{SKILL.md, workflow.json, facts.md, recipients.csv,
// crm-log.csv, scripts/, batches/<hash>.json, approvals.json, gate-log.jsonl, dry-runs/<ts>.json}. All 0600/0700.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Batch } from "./batch.ts";
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
  const tmp = `${path}.tmp-${process.pid}`;
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

export function saveBatch(home: string, b: Batch): void {
  ensureDir(batchesDir(home, b.workflowId));
  writePrivate(join(batchesDir(home, b.workflowId), `${b.hash}.json`), JSON.stringify(b, null, 2) + "\n");
}

export function readBatch(home: string, id: string, hash: string): Batch | null {
  if (!HASH_RE.test(hash)) return null;
  const p = join(batchesDir(home, id), `${hash}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Batch) : null;
}

export function listBatches(home: string, id: string): Batch[] {
  const dir = batchesDir(home, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Batch)
    .sort((a, b) => b.createdAt - a.createdAt || (a.hash < b.hash ? -1 : 1));
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

export const gateLogPath = (home: string, id: string) => join(workflowDir(home, id), "gate-log.jsonl");

export function readGateLog(home: string, id: string): GateDecisionLog[] {
  const p = gateLogPath(home, id);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GateDecisionLog);
}
