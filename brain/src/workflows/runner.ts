// Runner: prepare a live batch (pick recipients, draft in tone), approve exactly one batch hash, execute it
// through an Executor with the gate, then log what was really sent. The gate decides; this file only wires it.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../models/model.ts";
import { draftInTone } from "../tone/draft.ts";
import { loadTonePack } from "../tone/pack.ts";
import { makeBatch, type Batch, type BatchItem } from "./batch.ts";
import { crmLines, contactedFrom } from "./scripts/crm-log.ts";
import { pickNext, readRecipients } from "./scripts/recipients.ts";
import type { Executor } from "./executor.ts";
import { parseFacts, renderSubject } from "./facts.ts";
import { createGate } from "./gate.ts";
import { gateLogPath, listBatches, readApprovals, readBatch, readText, readWorkflow, saveApproval, saveBatch, updateWorkflow, workflowDir } from "./store.ts";
import type { WorkflowJson } from "./types.ts";

export class RunError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "bad_request",
  ) {
    super(message);
  }
}

export const pendingLiveBatch = (home: string, id: string): Batch | null => listBatches(home, id).find((b) => b.kind === "live" && b.state === "pending") ?? null;

export interface PrepareOptions {
  home: string;
  workflowId: string;
  model: Model;
  now?: () => number;
}

/** Drafts the next live batch and stores it as pending. Returns the existing pending batch when there is one. */
export async function prepareLiveBatch(o: PrepareOptions): Promise<Batch> {
  const now = (o.now ?? Date.now)();
  const wf = readWorkflow(o.home, o.workflowId);
  if (wf === null) throw new RunError(`no workflow ${o.workflowId}`, "not_found");
  if (wf.status === "paused") throw new RunError("workflow is paused", "conflict");
  if (wf.status !== "active") throw new RunError("approve a dry run first: the workflow is not active", "conflict");
  const pending = pendingLiveBatch(o.home, wf.id);
  if (pending !== null) return pending;
  if (wf.template !== "investor_outreach") throw new RunError(`live batches for ${wf.template} workflows are not built yet`, "bad_request");

  const factsText = readText(o.home, wf.id, "facts.md") ?? "";
  const facts = parseFacts(factsText);
  const contacted = contactedFrom(readText(o.home, wf.id, wf.inputs.crmLog) ?? "");
  for (const b of listBatches(o.home, wf.id)) if (b.kind === "live" && b.state !== "failed") for (const i of b.items) contacted.add(i.key);
  const next = pickNext(readRecipients(readText(o.home, wf.id, wf.inputs.list) ?? ""), contacted, wf.batchSize);
  if (next.length === 0) throw new RunError(`nobody left to write to in ${wf.inputs.list}`, "conflict");
  const pack = loadTonePack(o.home) ?? { corpus: [], cards: {} };
  const items: BatchItem[] = [];
  for (const r of next) {
    const recipient = { email: r.email, firstName: r.firstName, lastName: r.lastName, org: r.org, notes: r.notes };
    const subject = renderSubject(facts.subject ?? wf.inputs.subjectTemplate, facts, recipient);
    const d = await draftInTone({ pack, bucket: wf.bucket, recipient, subject, facts: factsText, model: o.model, models: wf.models });
    items.push({ key: r.email, to: r.email, subject, body: d.body, warnings: d.warnings });
  }
  const batch = makeBatch(wf.id, "live", items, now);
  saveBatch(o.home, batch);
  return batch;
}

export interface ApproveResult {
  batch: Batch;
  workflow: WorkflowJson;
  /** Token for a live batch; the executor run must hold it. */
  token: string | null;
}

/**
 * Approves exactly `hash`. A dry-run batch marks the workflow reviewed (active) and is never sendable.
 * A live batch gets a fresh token stored for that hash only.
 */
export function approveBatch(home: string, workflowId: string, hash: string, now: number): ApproveResult {
  const wf = readWorkflow(home, workflowId);
  if (wf === null) throw new RunError(`no workflow ${workflowId}`, "not_found");
  const batch = readBatch(home, workflowId, hash);
  if (batch === null) throw new RunError(`no batch ${hash} in ${workflowId}`, "not_found");
  if (batch.state !== "pending") throw new RunError(`batch is ${batch.state}, not pending`, "conflict");
  if (wf.status === "paused") throw new RunError("workflow is paused", "conflict");
  batch.state = "approved";
  batch.approvedAt = now;
  saveBatch(home, batch);
  if (batch.kind === "dry_run") {
    const updated = updateWorkflow(home, workflowId, (w) => {
      w.status = "active";
      w.activatedAt ??= now;
    }, now);
    return { batch, workflow: updated, token: null };
  }
  const token = randomBytes(32).toString("base64url");
  saveApproval(home, workflowId, hash, { token, approvedAt: now });
  return { batch, workflow: wf, token };
}

export interface ExecuteOptions {
  home: string;
  workflowId: string;
  hash: string;
  token: string | null;
  executor: Executor;
  /** Agent SDK MCP servers, resolved from connectors.json by the caller. */
  mcpServers?: Parameters<Executor["execute"]>[0]["mcpServers"];
  now?: () => number;
}

/** Runs the side-effect steps of one batch through the gate, then writes results and the CRM log. */
export async function executeBatch(o: ExecuteOptions): Promise<Batch> {
  const now = o.now ?? Date.now;
  const wf = readWorkflow(o.home, o.workflowId);
  const batch = readBatch(o.home, o.workflowId, o.hash);
  if (wf === null || batch === null) throw new RunError("no such workflow or batch", "not_found");
  if (wf.status === "paused") throw new RunError("workflow is paused", "conflict");
  if (batch.kind !== "live") throw new RunError("dry-run batches are never executed", "conflict");
  const approvals = readApprovals(o.home, o.workflowId);
  const gate = createGate({ workflowId: wf.id, mode: "live", batch, autoRun: wf.autoRun, runToken: o.token, approvals: (h) => approvals[h], logPath: gateLogPath(o.home, wf.id), now });
  batch.state = "sending";
  saveBatch(o.home, batch);
  let result;
  try {
    result = await o.executor.execute({ batch, gate, skill: readText(o.home, wf.id, "SKILL.md") ?? "", model: wf.models.cheap, cwd: workflowDir(o.home, wf.id), ...(o.mcpServers === undefined ? {} : { mcpServers: o.mcpServers }) });
  } catch (err) {
    batch.state = "failed";
    batch.results.push({ key: "*", tool: "executor", ok: false, at: now(), error: err instanceof Error ? err.message : String(err) });
    saveBatch(o.home, batch);
    return batch;
  }
  const sentKeys = new Set<string>();
  for (const c of result.toolCalls) {
    if (c.itemKey === undefined || !c.allowed) continue;
    batch.results.push({ key: c.itemKey, tool: c.tool, ok: c.ok, at: now(), ...(c.error === undefined ? {} : { error: c.error }) });
    if (c.ok && /send|reply|forward/i.test(c.tool)) sentKeys.add(c.itemKey);
  }
  batch.state = sentKeys.size === batch.items.length ? "sent" : sentKeys.size === 0 ? "failed" : "partial";
  saveBatch(o.home, batch);
  const entries = batch.items.map((i) => ({ at: now(), email: i.to, subject: i.subject, batch: batch.hash, status: sentKeys.has(i.key) ? ("sent" as const) : ("failed" as const) }));
  appendFileSync(join(workflowDir(o.home, wf.id), wf.inputs.crmLog), crmLines(entries), { mode: 0o600 });
  return batch;
}
