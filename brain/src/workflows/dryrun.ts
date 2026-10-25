// Dry run (AC-4): the workflow on last week's real instances from the store, every side effect disabled.
// Per instance: our draft next to what the user really wrote (OCR excerpt) and the time arithmetic (code, ADR 0005).
import { join } from "node:path";
import type { Analysis } from "../analyze.ts";
import type { DryRunInstanceDTO, DryRunResponse } from "../api/types.ts";
import { API_VERSION } from "../api/types.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import { draftInTone } from "../tone/draft.ts";
import { loadTonePack, type TonePack } from "../tone/pack.ts";
import { makeBatch, type BatchItem } from "./batch.ts";
import { createGate, type GateDecisionLog } from "./gate.ts";
import { parseFacts } from "./facts.ts";
import { observedInstances } from "./observed.ts";
import { ensureDir, gateLogPath, readText, readWorkflow, saveBatch, updateWorkflow, workflowDir, writePrivate } from "./store.ts";

export class DryRunError extends Error {}

export interface DryRunOptions {
  home: string;
  analysis: Analysis;
  workflowId: string;
  model: Model;
  limit?: number;
  now?: () => number;
}

const round1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;

export async function dryRun(o: DryRunOptions): Promise<DryRunResponse> {
  const now = (o.now ?? Date.now)();
  const wf = readWorkflow(o.home, o.workflowId);
  if (wf === null) throw new DryRunError(`no workflow ${o.workflowId}`);
  const models: ModelConfig = wf.models;
  const limit = Math.max(1, Math.min(50, Math.floor(o.limit ?? 5)));
  const warnings: string[] = [];
  const pack: TonePack = loadTonePack(o.home) ?? { corpus: [], cards: {} };
  if (pack.corpus.length === 0) warnings.push("no tone pack yet: run `tone build` so drafts follow your past emails");
  const factsText = readText(o.home, wf.id, "facts.md") ?? "";
  const facts = parseFacts(factsText);
  const emailWorkflow = wf.template !== "generic";

  const { instances: observed, skipped } = observedInstances(o.analysis, wf.taskId, { limit });
  if (observed.length === 0) warnings.push("no instance of this task in the store has a readable recipient");

  const items: BatchItem[] = [];
  const out: DryRunInstanceDTO[] = [];
  for (const ob of observed) {
    let draft: string | null = null;
    let examplesUsed: string[] = [];
    let itemWarnings: string[] = [];
    if (emailWorkflow) {
      // The observed subject stands in for the template so the two sides are the same email.
      const d = await draftInTone({ pack, bucket: wf.bucket, recipient: ob.recipient, subject: ob.subject, facts: factsText, model: o.model, models });
      draft = d.body;
      examplesUsed = d.examplesUsed;
      itemWarnings = d.warnings;
      items.push({ key: ob.recipient.email, to: ob.recipient.email, subject: ob.subject, body: d.body, sourceInstanceId: ob.instanceId, warnings: d.warnings });
    }
    const observedMinutes = round1(ob.minutes);
    const savedMinutes = round1(observedMinutes - wf.reviewSecondsPerItem / 60);
    out.push({
      instanceId: ob.instanceId,
      day: ob.day,
      start: ob.start,
      recipient: { email: ob.recipient.email, firstName: ob.recipient.firstName, org: ob.recipient.org ?? "" },
      subject: ob.subject,
      draft,
      observed: { excerpt: ob.excerpt, minutes: observedMinutes, eventIds: ob.eventIds },
      estimate: { observedMinutes, reviewSeconds: wf.reviewSecondsPerItem, savedMinutes },
      examplesUsed,
      warnings: itemWarnings,
    });
  }
  if (!emailWorkflow) warnings.push("this workflow kind has no drafting dry run yet; showing what you did and the time only");
  if (Object.keys(facts).length < 3 && emailWorkflow) warnings.push("facts.md is mostly empty: drafts will show [missing: ...] gaps");

  // Every side-effect step goes through the gate in dry-run mode: all denied, all logged.
  const batch = makeBatch(wf.id, "dry_run", items, now);
  const gateLog: GateDecisionLog[] = [];
  const gate = createGate({ workflowId: wf.id, mode: "dry_run", batch, autoRun: wf.autoRun, runToken: null, approvals: () => undefined, log: (d) => gateLog.push(d), logPath: gateLogPath(o.home, wf.id), now: () => now });
  let attempted = 0;
  for (const step of wf.steps.filter((s) => s.sideEffect && s.tool !== undefined)) {
    for (const it of batch.items) {
      attempted += 1;
      await gate.canUseTool(step.tool!, { to: it.to, subject: it.subject, body: it.body });
    }
  }
  if (items.length > 0) saveBatch(o.home, batch);

  const observedMinutes = round1(out.reduce((n, i) => n + i.estimate.observedMinutes, 0));
  const reviewMinutes = round1((out.length * wf.reviewSecondsPerItem) / 60);
  const savedMinutes = round1(observedMinutes - reviewMinutes);
  const res: DryRunResponse = {
    version: API_VERSION,
    workflowId: wf.id,
    ranAt: now,
    batchHash: batch.hash,
    instances: out,
    skipped,
    sideEffects: { attempted, denied: gateLog.filter((d) => d.decision === "deny").length },
    totals: {
      instances: out.length,
      observedMinutes,
      reviewMinutes,
      savedMinutes,
      arithmetic: `you spent ${observedMinutes.toFixed(1)} min on these ${out.length} → review ${out.length} × ${wf.reviewSecondsPerItem} s = ${reviewMinutes.toFixed(1)} min → saves ${savedMinutes.toFixed(1)} min`,
    },
    gateLog: gateLog.map((d) => ({ at: d.at, tool: d.tool, toolClass: d.toolClass, decision: d.decision, reason: d.reason, ...(d.itemKey === undefined ? {} : { itemKey: d.itemKey }) })),
    warnings,
  };
  const dir = join(workflowDir(o.home, wf.id), "dry-runs");
  ensureDir(dir);
  writePrivate(join(dir, `${now}.json`), JSON.stringify(res, null, 2) + "\n");
  writePrivate(join(workflowDir(o.home, wf.id), "dry-run.json"), JSON.stringify(res, null, 2) + "\n");
  updateWorkflow(o.home, wf.id, (w) => {
    w.lastDryRunAt = now;
    w.lastDryRunHash = items.length > 0 ? batch.hash : null;
  }, now);
  return res;
}
