// s09b: the serve run loop. Each tick looks at every workflow's cron schedule (local time, workflows/schedule.ts) and
// starts the ones whose slot came due since they were last handled. ADR 0006 holds throughout:
// - only a workflow whose stored status is `active` starts (drafting, ready_for_review and paused never do);
// - auto-run off: it drafts the next live batch and leaves it pending; the dashboard shows needs_you
//   "A new batch of N is ready for review." Nothing is sent until you approve that batch's hash;
// - auto-run on: the loop approves that exact batch hash (a token for that hash only, as POST /approve does) and
//   sends it through the gate, but only when every required connector is connected; otherwise it stays pending.
// It never sends without an approved batch hash. A slot is handled once: missed slots are not caught up one by one,
// slots that pass while paused or while a batch waits are skipped, and a pending batch is never replaced.
import { nextCronRun } from "../workflows/schedule.ts";
import { approveBatch, pendingLiveBatch, prepareLiveBatch, RunError } from "../workflows/runner.ts";
import { connectorStatus, summaryOf } from "../workflows/service.ts";
import { listWorkflows, readWorkflow, updateWorkflow } from "../workflows/store.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { sendBatch, type WorkflowContext } from "./workflow-routes.ts";

export const SCHEDULER_INTERVAL_MS = 30_000;

export interface SchedulerTick {
  at: number;
  /** Batches the loop drafted this tick; `sending` = approved by auto-run and handed to the sender. */
  started: Array<{ workflowId: string; batchHash: string; items: number; sending: boolean }>;
  /** Due slots that did not start, with the reason. */
  skipped: Array<{ workflowId: string; reason: string }>;
}

/** The due slot the workflow has not handled yet, or null. Counted from the later of activation and the last slot. */
export function dueSlot(wf: WorkflowJson, now: number): number | null {
  if (wf.schedule.type !== "cron") return null;
  const since = Math.max(wf.activatedAt ?? -Infinity, wf.lastScheduledAt ?? -Infinity);
  if (!Number.isFinite(since)) return null;
  const due = nextCronRun(wf.schedule.cron, since);
  return due !== null && due <= now ? due : null;
}

export async function schedulerTick(ctx: WorkflowContext, log: (line: string) => void = (l) => console.error(l)): Promise<SchedulerTick> {
  const now = ctx.now();
  const out: SchedulerTick = { at: now, started: [], skipped: [] };
  const mark = (id: string) => updateWorkflow(ctx.home, id, (w) => void (w.lastScheduledAt = now), now);
  for (const wf of listWorkflows(ctx.home)) {
    if (dueSlot(wf, now) === null) continue;
    if (wf.status !== "active") {
      // Paused (or not yet approved): the slot passes. Resuming does not replay it.
      if (wf.status === "paused") mark(wf.id);
      continue;
    }
    if (pendingLiveBatch(ctx.home, wf.id, now) !== null) {
      mark(wf.id);
      out.skipped.push({ workflowId: wf.id, reason: "a batch already waits for review" });
      continue;
    }
    try {
      const batch = await prepareLiveBatch({ home: ctx.home, workflowId: wf.id, model: ctx.model, now: ctx.now });
      mark(wf.id);
      const fresh = readWorkflow(ctx.home, wf.id);
      let sending = false;
      if (fresh !== null && fresh.status === "active" && fresh.autoRun) {
        const missing = summaryOf(ctx.home, fresh, connectorStatus(ctx.home, ctx.env), now).connectors.filter((c) => c.required && c.status !== "connected");
        if (missing.length === 0) {
          // The same approval POST /approve gives: a token for this exact hash, used up when the send starts.
          const { workflow, token } = approveBatch(ctx.home, wf.id, batch.hash, now);
          ctx.background(sendBatch(ctx, wf.id, batch.hash, token, workflow.connectors));
          sending = true;
        } else log(`brain: scheduler: ${wf.id} auto-run batch waits: connect ${missing.map((c) => c.name).join(", ")}`);
      }
      out.started.push({ workflowId: wf.id, batchHash: batch.hash, items: batch.items.length, sending });
    } catch (err) {
      if (!(err instanceof RunError)) throw err;
      // Busy (another run holds the lock): try again next tick. Anything else (nobody left, not built): skip the slot.
      if (!/lock|already running|in progress/i.test(err.message)) mark(wf.id);
      out.skipped.push({ workflowId: wf.id, reason: err.message });
      log(`brain: scheduler: ${wf.id}: ${err.message}`);
    }
  }
  return out;
}
