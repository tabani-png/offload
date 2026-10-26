// Dry run (AC-4): the workflow on last week's real instances from the store, every side effect disabled.
// Per instance: our draft next to what the user really wrote (OCR excerpt) and the time arithmetic (code, ADR 0005).
// The response carries the OCR excerpt; on disk the dry run and its batch are sealed with the day's brain key and
// purged after 7 days (store/vault.ts, REVIEW-1 H4).
import { join } from "node:path";
import { localDay, openText, sealText } from "../store/vault.ts";
import type { Analysis } from "../analyze.ts";
import type { DryRunInstanceDTO, DryRunResponse, ModelLabel } from "../api/types.ts";
import { API_VERSION } from "../api/types.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import { draftInTone } from "../tone/draft.ts";
import { loadTonePack, type TonePack } from "../tone/pack.ts";
import { makeBatch, type BatchItem } from "./batch.ts";
import { createGate, type GateDecisionLog } from "./gate.ts";
import { parseFacts } from "./facts.ts";
import { observedInstances } from "./observed.ts";
import { ensureDir, gateLogPath, readText, readWorkflow, saveBatch, updateWorkflow, workflowDir } from "./store.ts";
import { generalDryRun } from "../plan/dryrun.ts";
import type { GeneralDryRunDTO } from "../api/s14-types.ts";
import type { UserContext } from "../types.ts";
import { readUserContext } from "../context/store.ts";
import { checkPlaybook } from "../playbook/check.ts";
import { readPlaybook } from "../playbook/store.ts";
import { NameMap } from "../privacy/names.ts";
import { readNamePolicy, signNames } from "../privacy/policy.ts";

export class DryRunError extends Error {}

export interface DryRunOptions {
  home: string;
  analysis: Analysis;
  workflowId: string;
  model: Model;
  limit?: number;
  now?: () => number;
  /** s09b: stored with the result so the UI can say "sample drafts" for the stub. */
  modelLabel?: ModelLabel;
  /** s14: onboarding context for text steps of general workflows (prompts only). */
  user?: UserContext;
}

/** s14: a dry run of a general workflow also carries `general` (per-instance outputs of any type). */
export type DryRunResult = DryRunResponse & { general?: GeneralDryRunDTO; tools?: Array<{ stepId: string; tool: string; name: string; runsWith: string }> };

const round1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;

export async function dryRun(o: DryRunOptions): Promise<DryRunResult> {
  const now = (o.now ?? Date.now)();
  const wf = readWorkflow(o.home, o.workflowId);
  if (wf === null) throw new DryRunError(`no workflow ${o.workflowId}`);
  const models: ModelConfig = wf.models;
  const limit = Math.max(1, Math.min(50, Math.floor(o.limit ?? 5)));
  const warnings: string[] = [];
  const factsText = readText(o.home, wf.id, "facts.md") ?? "";
  const facts = parseFacts(factsText);
  const emailWorkflow = wf.template !== "generic";
  // s14: a general plan dry-runs any output type; the email templates keep the s05 path below.
  const user = o.user ?? readUserContext(o.home).context;
  const general = wf.plan === undefined ? null : await generalDryRun({ home: o.home, analysis: o.analysis, wf, model: o.model, models, limit, now, facts: factsText, ...(user === undefined ? {} : { user }) });
  const pack: TonePack = general !== null ? { corpus: [], cards: {} } : (loadTonePack(o.home, now) ?? { corpus: [], cards: {} });
  if (general === null && pack.corpus.length === 0) warnings.push("no tone pack yet: run `tone build` so drafts follow your past emails");
  if (general !== null) warnings.push(...general.warnings);

  const { instances: observed, skipped } = general !== null ? { instances: [], skipped: 0 } : observedInstances(o.analysis, wf.taskId, { limit });
  if (general === null && observed.length === 0) warnings.push("no instance of this task in the store has a readable recipient");

  const items: BatchItem[] = [];
  const out: DryRunInstanceDTO[] = [];
  // s19: an email workflow with a messaging playbook drafts with it, and each draft says whether it follows it.
  const playbook = emailWorkflow && general === null ? readPlaybook(o.home, wf.id, warnings) : null;
  // s18: one name map per dry run (stable placeholders across instances); the facts `sign:` line is the user's name.
  const names = new NameMap(readNamePolicy(o.home, signNames(factsText)));
  for (const ob of observed) {
    let draft: string | null = null;
    let examplesUsed: string[] = [];
    let itemWarnings: string[] = [];
    let verdict: DryRunInstanceDTO["playbook"];
    if (emailWorkflow) {
      // The observed subject stands in for the template so the two sides are the same email.
      const d = await draftInTone({ pack, bucket: wf.bucket, recipient: ob.recipient, subject: ob.subject, facts: factsText, model: o.model, models, playbook, names });
      draft = d.body;
      if (playbook !== null) verdict = checkPlaybook(d.body, playbook);
      examplesUsed = d.examplesUsed;
      itemWarnings = d.warnings;
      items.push({ key: ob.recipient.email, to: ob.recipient.email, subject: ob.subject, body: d.body, sourceInstanceId: ob.instanceId, warnings: d.warnings });
    }
    const observedMinutes = round1(ob.minutes);
    const savedMinutes = Math.max(0, round1(observedMinutes - wf.reviewSecondsPerItem / 60));
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
      ...(verdict === undefined ? {} : { playbook: verdict }),
    });
  }
  if (!emailWorkflow && general === null) warnings.push("this workflow kind has no drafting dry run yet; showing what you did and the time only");
  if (general !== null) items.push(...general.items);
  if (Object.keys(facts).length < 3 && emailWorkflow) warnings.push("facts.md is mostly empty: drafts will show [missing: ...] gaps");

  // REVIEW-2 N3: everything this dry run writes is sealed under the capture day of its oldest instance, so it is
  // purged 7 days after that capture, not 7 days after the run.
  const sealDay = [...out.map((i) => i.day), ...(general?.general.instances.map((i) => i.day) ?? [])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()[0] ?? localDay(now);

  // Every side-effect step goes through the gate in dry-run mode: all denied, all logged.
  const batch = { ...makeBatch(wf.id, "dry_run", items, now), sealDay };
  const gateLog: GateDecisionLog[] = [];
  const gate = createGate({ workflowId: wf.id, mode: "dry_run", batch, autoRun: wf.autoRun, runToken: null, approvals: () => undefined, log: (d) => gateLog.push(d), logPath: gateLogPath(o.home, wf.id), now: () => now });
  let attempted = 0;
  for (const step of wf.steps.filter((s) => s.sideEffect && s.tool !== undefined)) {
    for (const it of batch.items) {
      attempted += 1;
      await gate.canUseTool(step.tool!, { to: it.to, subject: it.subject, body: it.body });
    }
  }
  // s14: every commit of a general plan is put to the gate too (ADR 0006); in a dry run each one is denied.
  for (const tool of general?.commitTools ?? []) {
    for (const it of batch.items) {
      attempted += 1;
      await gate.canUseTool(tool, { item: it.key, subject: it.subject, body: it.body });
    }
  }
  if (items.length > 0) saveBatch(o.home, batch);

  const timed = general !== null ? general.general.instances.map((i) => i.estimate.observedMinutes) : out.map((i) => i.estimate.observedMinutes);
  const observedMinutes = round1(timed.reduce((n, m) => n + m, 0));
  const reviewMinutes = round1((timed.length * wf.reviewSecondsPerItem) / 60);
  const savedMinutes = Math.max(0, round1(observedMinutes - reviewMinutes));
  const res: DryRunResult = {
    version: API_VERSION,
    workflowId: wf.id,
    ranAt: now,
    batchHash: batch.hash,
    instances: out,
    skipped,
    sideEffects: { attempted, denied: gateLog.filter((d) => d.decision === "deny").length },
    totals: {
      instances: timed.length,
      observedMinutes,
      reviewMinutes,
      savedMinutes,
      arithmetic: `you spent ${observedMinutes.toFixed(1)} min on these ${timed.length} → review ${timed.length} × ${wf.reviewSecondsPerItem} s = ${reviewMinutes.toFixed(1)} min → saves ${savedMinutes.toFixed(1)} min`,
    },
    gateLog: gateLog.map((d) => ({ at: d.at, tool: d.tool, toolClass: d.toolClass, decision: d.decision, reason: d.reason, ...(d.itemKey === undefined ? {} : { itemKey: d.itemKey }) })),
    warnings,
    ...(o.modelLabel === undefined ? {} : { model: o.modelLabel }),
    ...(general === null ? {} : { general: general.general }),
    // s14: the tools this dry run stands for (the chosen option per step), shown next to the result.
    ...(wf.tools === undefined ? {} : { tools: wf.tools.map((t) => ({ stepId: t.stepId, tool: t.chosen, name: t.options.find((x) => x.id === t.chosen)?.name ?? t.chosen, runsWith: t.runsWith })) }),
  };
  const dir = join(workflowDir(o.home, wf.id), "dry-runs");
  ensureDir(dir);
  sealText(o.home, join(dir, `${now}.json.enc`), JSON.stringify(res, null, 2) + "\n", sealDay);
  sealText(o.home, join(workflowDir(o.home, wf.id), "dry-run.json.enc"), JSON.stringify(res, null, 2) + "\n", sealDay);
  updateWorkflow(o.home, wf.id, (w) => {
    w.lastDryRunAt = now;
    w.lastDryRunHash = items.length > 0 ? batch.hash : null;
  }, now);
  return res;
}

/** The last dry run of a workflow, or null when there is none or it is older than 7 local days. */
export function readLastDryRun(home: string, workflowId: string, now: number = Date.now()): DryRunResult | null {
  const text = openText(home, join(workflowDir(home, workflowId), "dry-run.json.enc"), now);
  return text === null ? null : (JSON.parse(text) as DryRunResult);
}
