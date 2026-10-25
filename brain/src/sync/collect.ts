// The collector: the ONLY sync code that reads brain state (workflow store, batches, the analysis of the observer
// store, facts.md, recipients.csv). It turns it into the narrow projector inputs of sync/types.ts: numbers, ids,
// hashes, and refs computed with the device evidence key. Content (recipients, subjects, bodies, titles, URLs, hosts,
// OCR) stops here: no input type has a field that could carry it. The one text that leaves is a shared workflow's
// definition (G4), and its facts values and recipient-list cells are redacted here before the projector masks it.
import type { Analysis } from "../analyze.ts";
import { localDay } from "../store/vault.ts";
import { parseFacts } from "../workflows/facts.ts";
import { listBatches, listWorkflows, readText, readWorkflow } from "../workflows/store.ts";
import type { Batch } from "../workflows/batch.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import type { EvidenceKey } from "./evidence-key.ts";
import type { ReviewRecord } from "./reviews.ts";
import type { BaselineInput, Binding, DailyInput, ProposalInput, ProposalStepInput, ReviewInput, RunInput, WorkingTimeInput } from "./types.ts";

const DONE = new Set(["sent", "partial", "failed"]);

function runOf(b: Batch, binding: Binding): RunInput | null {
  if (b.kind !== "live" || !DONE.has(b.state)) return null;
  const states = Object.values(b.itemStates ?? {});
  const times = [...states.map((s) => s.at), ...b.results.map((r) => r.at)];
  if (times.length === 0) return null;
  const count = (st: string) => b.items.filter((i) => (b.itemStates?.[i.key]?.state ?? "pending") === st).length;
  const startedAt = b.approvedAt ?? Math.min(...times);
  return {
    binding,
    batchHash: b.hash,
    startedAt,
    endedAt: Math.max(startedAt, ...times),
    state: b.state as RunInput["state"],
    items: { total: b.items.length, sent: count("sent"), failedBeforeSend: count("failed_before_send"), unknown: count("unknown"), pending: count("pending") + count("sending") },
    approver: b.approvedAt !== null ? "person" : "policy",
    failed: b.results.some((r) => !r.ok),
    overnight: false,
  };
}

export interface Collected {
  runs: RunInput[];
  reviews: ReviewInput[];
  baselines: BaselineInput[];
  daily: DailyInput[];
}

/** Local midnight after `day` minus 1 ms. */
export function dayEnd(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + 1).getTime() - 1;
}
const dayStart = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
};

export function collectRuns(home: string, bindings: Record<string, Binding>, now: number): RunInput[] {
  const out: RunInput[] = [];
  for (const [localId, binding] of Object.entries(bindings)) {
    if (readWorkflow(home, localId) === null) continue;
    for (const b of listBatches(home, localId, now)) {
      const r = runOf(b, binding);
      if (r !== null) out.push(r);
    }
  }
  return out.sort((a, b) => a.endedAt - b.endedAt || (a.batchHash < b.batchHash ? -1 : 1));
}

export function collectReviews(runs: readonly RunInput[], reviews: readonly ReviewRecord[]): ReviewInput[] {
  const byHash = new Map(runs.map((r) => [r.batchHash, r]));
  const out: ReviewInput[] = [];
  for (const r of reviews) {
    const run = byHash.get(r.batchHash);
    if (run === undefined) continue;
    out.push({ batchHash: r.batchHash, startedAt: run.startedAt, at: r.at, reviewSeconds: r.reviewSeconds, editSeconds: r.editSeconds, fixSeconds: r.fixSeconds, itemsEdited: r.itemsEdited, decision: r.decision, surface: r.surface });
  }
  return out;
}

/** Observed instances of each bound workflow's task, as evidence refs + active seconds (idle already excluded). */
export function collectBaselines(a: Analysis, home: string, bindings: Record<string, Binding>, evidence: EvidenceKey, now: number): BaselineInput[] {
  const out: BaselineInput[] = [];
  for (const [localId, binding] of Object.entries(bindings)) {
    const wf = readWorkflow(home, localId);
    const task = wf === null ? undefined : a.tasks.find((t) => t.id === wf.taskId);
    if (task === undefined || task.instances.length === 0) continue;
    const refs = evidence.remember(task.instances.map((i) => ({ instanceId: i.id, day: i.day })), now);
    const instances = task.instances.flatMap((i) => {
      const ref = refs.get(i.id);
      return ref === undefined ? [] : [{ instanceRef: ref, activeSeconds: Math.round(i.activeMs / 1000), day: i.day }];
    });
    if (instances.length > 0) out.push({ binding, instances });
  }
  return out;
}

/** Completed local days in the store window (today is still open, so it waits until tomorrow). */
export const completedDays = (a: Analysis, now: number) => a.windowDays.filter((d) => d < localDay(now));

export function collectDaily(a: Analysis, home: string, bindings: Record<string, Binding>, runs: readonly RunInput[], reviews: readonly ReviewInput[], baselines: readonly BaselineInput[], now: number): DailyInput[] {
  const activeWorkflows = listWorkflows(home).filter((w) => w.status === "active").length;
  const residual = new Map(reviews.map((r) => [r.batchHash, r.reviewSeconds + r.editSeconds + r.fixSeconds]));
  return completedDays(a, now).map((day) => ({
    day,
    dayEnd: dayEnd(day),
    activeWorkflows,
    workflows: Object.values(bindings).flatMap((binding) => {
      const mine = runs.filter((r) => r.binding.workflowId === binding.workflowId && r.binding.version === binding.version && localDay(r.endedAt) === day);
      if (mine.length === 0) return [];
      const success = mine.filter((r) => r.items.sent > 0 && r.state !== "failed");
      const base = baselines.find((b) => b.binding.workflowId === binding.workflowId && b.binding.version === binding.version);
      return [{ binding, runs: mine.length, successRuns: success.map((r) => ({ sent: r.items.sent, residualSeconds: residual.get(r.batchHash) ?? null })), baselineSeconds: base?.instances.map((i) => i.activeSeconds) ?? [] }];
    }),
  }));
}

/** Active time per completed day on or after `startsAt` (working time is never sent for days before the notice period
 * ended). Span titles, apps and hosts are read here and dropped: only seconds and two minute-of-day numbers remain. */
export function collectWorkingTime(a: Analysis, now: number, startsAt: number, noticeVersionId: string): WorkingTimeInput[] {
  const out: WorkingTimeInput[] = [];
  for (const day of completedDays(a, now)) {
    if (dayStart(day) < startsAt) continue;
    const spans = a.spans.filter((s) => s.day === day && s.activeMs > 0);
    if (spans.length === 0) continue;
    const midnight = dayStart(day);
    const first = Math.min(...spans.map((s) => s.start));
    const last = Math.max(...spans.map((s) => s.end - 1));
    out.push({
      day,
      dayEnd: dayEnd(day),
      activeSeconds: Math.round(spans.reduce((n, s) => n + s.activeMs, 0) / 1000),
      firstActiveMinute: Math.max(0, Math.floor((first - midnight) / 60_000)),
      lastActiveMinute: Math.min(1439, Math.max(0, Math.floor((last - midnight) / 60_000))),
      noticeVersionId,
    });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces every value in `secrets` (case-insensitive, at least 3 characters) with `[fact]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let t = text;
  for (const v of [...new Set(secrets)].filter((s) => s.trim().length >= 3).sort((x, y) => y.length - x.length)) t = t.replace(new RegExp(escapeRe(v.trim()), "gi"), "[fact]");
  return t;
}

function recipientCells(home: string, wf: WorkflowJson): string[] {
  const csv = readText(home, wf.id, wf.inputs.list) ?? "";
  return csv
    .split("\n")
    .slice(1)
    .flatMap((line) => line.split(","))
    .map((c) => c.trim().replace(/^"|"$/g, ""))
    .filter((c) => c.length >= 3);
}

/** The definition of a local workflow for G4, or null when it does not exist. */
export function collectProposal(home: string, localId: string, binding: Binding | null, timezone: string): ProposalInput | null {
  const wf = readWorkflow(home, localId);
  if (wf === null) return null;
  const facts = parseFacts(readText(home, wf.id, "facts.md") ?? "");
  const secrets = [...Object.values(facts), ...recipientCells(home, wf)];
  const r = (s: string) => redact(s, secrets);
  const capability = new Map((wf.tools ?? []).map((t) => [t.stepId, t.capability]));
  const steps: ProposalStepInput[] = wf.steps
    .filter((s) => s.type !== "approval_gate")
    .map((s) => ({ id: s.id, title: r(s.title), detail: r(s.detail), type: s.type as ProposalStepInput["type"], connector: s.connector, sideEffect: s.sideEffect, capability: capability.get(s.id) ?? null }));
  const trigger: ProposalInput["trigger"] =
    wf.schedule.type === "cron" ? { type: "cron", cron: wf.schedule.cron, timezone: wf.schedule.timezone === "local" ? timezone : wf.schedule.timezone } : { type: wf.trigger.type === "new_email" ? "event" : "manual", cron: null, timezone: null };
  return {
    localWorkflowId: wf.id,
    binding,
    definedAt: wf.updatedAt,
    name: r(wf.name),
    description: r(wf.description),
    trigger,
    steps,
    skillMd: r(readText(home, wf.id, "SKILL.md") ?? ""),
    factsKeys: Object.keys(facts),
    batchSize: wf.batchSize,
  };
}
