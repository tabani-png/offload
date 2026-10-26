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
import { generalDryRun, producesNothing } from "../plan/dryrun.ts";
import type { GeneralDryRunDTO } from "../api/s14-types.ts";
import type { UserContext } from "../types.ts";
import { readUserContext } from "../context/store.ts";
import { checkPlaybook } from "../playbook/check.ts";
import { readPlaybook } from "../playbook/store.ts";
import { NameMap } from "../privacy/names.ts";
import { readNamePolicy, signNames } from "../privacy/policy.ts";
import type { ReadPreviewDTO } from "../api/s14-types.ts";
import { recordRead, type SourceFetcher } from "./read-fetch.ts";
import { registerPreview } from "./runner.ts";
import { queryOf } from "../plan/read-source.ts";

export class DryRunError extends Error {}
/** s27: the dry run stopped because the workflow was paused or deleted while it read its source. */
export class DryRunStopped extends Error {}

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
  /** s27: reads the workflow's source now (read only) to show what a live run would use. */
  read?: SourceFetcher;
}

/** s27: a dry run of a plan workflow says what its read step read now (or why nothing). */
export const NO_SOURCE_DRY = "Offload has not seen where these values come from; live runs use your list items.csv.";

/** s14: a dry run of a general workflow also carries `general` (per-instance outputs of any type). */
export type DryRunResult = DryRunResponse & { general?: GeneralDryRunDTO; tools?: Array<{ stepId: string; tool: string; name: string; runsWith: string }>; read?: ReadPreviewDTO };

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
  // s27: the read step reads its source now, read only (gate mode read), so the dry run shows the values a live run uses.
  let read: ReadPreviewDTO | undefined;
  if (wf.plan !== undefined) {
    const src = wf.read;
    if (src === undefined) read = { status: "none", name: null, via: null, query: null, rows: [], rowsTotal: 0, message: NO_SOURCE_DRY };
    else if (o.read === undefined) read = { status: "not_read", name: src.targetName, via: null, query: queryOf(src), rows: [], rowsTotal: 0, message: `Reading ${src.targetName} is not set up on this Mac yet; live runs use your list ${wf.inputs.list}.` };
    else {
      // Pause and delete stop this read like a live run's: before every method and call, and in the readers.
      const stop = registerPreview(o.home, wf.id);
      let r;
      try {
        r = await o.read.fetch({ wf, now, logPath: gateLogPath(o.home, wf.id), signal: stop.signal, cancelled: stop.cancelled });
      } finally {
        stop.done();
      }
      if (!r.ok && r.status === "cancelled") throw new DryRunStopped(r.message);
      recordRead(o.home, wf.id, r, now);
      read = r.ok
        ? { status: "fetched", name: src.targetName, via: r.via, query: queryOf(src), rows: r.rows.slice(0, 20), rowsTotal: r.rows.length, message: r.message }
        : { status: r.status === "cancelled" ? "not_read" : r.status, name: src.targetName, via: null, query: queryOf(src), rows: [], rowsTotal: 0, message: `Could not read ${src.targetName}: ${r.message} Live runs use your list ${wf.inputs.list} until it can be read.` };
    }
  }
  const readAutomated = read?.status === "fetched";
  const general = wf.plan === undefined ? null : await generalDryRun({ home: o.home, analysis: o.analysis, wf, model: o.model, models, limit, now, facts: factsText, readAutomated, ...(user === undefined ? {} : { user }) });
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
  // s26: a general instance the workflow cannot fill at all saves nothing; only the ones it can do count.
  const doableOnes = general !== null ? general.general.instances.filter((i) => !producesNothing(general.general.outputType, i.ours)) : [];
  const doable = general !== null ? doableOnes.map((i) => i.estimate.observedMinutes) : timed;
  // s27: the reading time on the source, counted only when Offload read it itself.
  const readTotal = round1((general?.general.instances ?? []).reduce((n, i) => n + (i.estimate.readMinutes ?? 0), 0));
  const readDoable = round1(doableOnes.reduce((n, i) => n + (i.estimate.readMinutes ?? 0), 0));
  const readName = wf.read?.targetName ?? "";
  const readCounted = readAutomated && wf.read !== undefined && readTotal > 0;
  const doableMinutes = round1(doable.reduce((n, m) => n + m, 0) + (readCounted ? readDoable : 0));
  const reviewMinutes = round1((doable.length * wf.reviewSecondsPerItem) / 60);
  const savedMinutes = Math.max(0, round1(doableMinutes - reviewMinutes));
  const spent = `you spent ${observedMinutes.toFixed(1)} min on these ${timed.length}${readCounted ? ` + ${readTotal.toFixed(1)} min reading ${readName} (Offload reads it)` : ""}`;
  const tail = wf.read !== undefined && !readCounted && readTotal > 0 ? `; reading ${readName} stays with you (${readTotal.toFixed(1)} min, not counted)` : "";
  const arithmetic =
    (doable.length === timed.length
      ? `${spent} → review ${timed.length} × ${wf.reviewSecondsPerItem} s = ${reviewMinutes.toFixed(1)} min → saves ${savedMinutes.toFixed(1)} min`
      : `${spent} → ${doable.length} of ${timed.length} can be done from what was on screen (${doableMinutes.toFixed(1)} min) → review ${doable.length} × ${wf.reviewSecondsPerItem} s = ${reviewMinutes.toFixed(1)} min → saves ${savedMinutes.toFixed(1)} min`) + tail;
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
      arithmetic,
    },
    gateLog: gateLog.map((d) => ({ at: d.at, tool: d.tool, toolClass: d.toolClass, decision: d.decision, reason: d.reason, ...(d.itemKey === undefined ? {} : { itemKey: d.itemKey }) })),
    warnings,
    ...(o.modelLabel === undefined ? {} : { model: o.modelLabel }),
    ...(general === null ? {} : { general: general.general }),
    ...(read === undefined ? {} : { read }),
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
