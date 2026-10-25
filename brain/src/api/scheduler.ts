// s09b: the serve run loop. Each tick looks at every workflow's cron schedule (local time, workflows/schedule.ts) and
// starts the ones whose slot came due since they were last handled. ADR 0006 holds throughout:
// - only a workflow whose stored status is `active` starts (drafting, ready_for_review and paused never do);
// - auto-run off: it drafts the next live batch and leaves it pending; the dashboard shows needs_you
//   "A new batch of N is ready for review." Nothing is sent until you approve that batch's hash;
// - auto-run on: the loop approves that exact batch hash (a token for that hash only, as POST /approve does) and
//   sends it through the gate, but only when every required connector is connected; otherwise it stays pending.
// It never sends without an approved batch hash. A slot is handled once: missed slots are not caught up one by one,
// slots that pass while paused or while a batch waits are skipped, and a pending batch is never replaced.
// s10b N1: with auto-run on, only recipients pinned and unchanged are sent (dispatchAuto); the rest wait for review.
// s10b N2: each workflow runs in its own try: any error (a broken list, a model or SDK failure, a corrupt
// workflow.json) marks that slot as handled, stores a content-free reason (needs_you "The last scheduled run did not
// finish: ..."), and is not retried until the next slot, so a failing model is not called again every 30 s. Only a
// lock conflict (another run in progress) is retried on the next tick: it fails before any model call.
import { scrubLogText } from "../log.ts";
import { nextCronRun } from "../workflows/schedule.ts";
import { pendingLiveBatch, prepareLiveBatch, RunError } from "../workflows/runner.ts";
import { listWorkflowIds, readWorkflow, updateWorkflow, workflowExists } from "../workflows/store.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { dispatchAuto, type WorkflowContext } from "./workflow-routes.ts";

export const SCHEDULER_INTERVAL_MS = 30_000;

export interface SchedulerTick {
  at: number;
  /** Batches the loop drafted this tick; `sending` = approved by auto-run and handed to the sender. */
  started: Array<{ workflowId: string; batchHash: string; items: number; sending: boolean }>;
  /** Due slots that did not start, with the reason. */
  skipped: Array<{ workflowId: string; reason: string }>;
  /** s10b N2: due slots that failed; the slot is marked and the reason stored on the workflow. */
  failed: Array<{ workflowId: string; reason: string }>;
}

/** The due slot the workflow has not handled yet, or null. Counted from the later of activation and the last slot. */
export function dueSlot(wf: WorkflowJson, now: number): number | null {
  if (wf.schedule.type !== "cron") return null;
  const since = Math.max(wf.activatedAt ?? -Infinity, wf.lastScheduledAt ?? -Infinity);
  if (!Number.isFinite(since)) return null;
  const due = nextCronRun(wf.schedule.cron, since);
  return due !== null && due <= now ? due : null;
}

/** A failure reason safe to store and show: no addresses, no quoted content, at most 200 chars. */
export const failureReason = (err: unknown) => scrubLogText(err instanceof Error ? err.message : String(err)).slice(0, 200);

const isLockConflict = (err: unknown) => err instanceof RunError && /lock|already running|in progress/i.test(err.message);

const lastLogged = new Map<string, string>();

export async function schedulerTick(ctx: WorkflowContext, log: (line: string) => void = (l) => console.error(l)): Promise<SchedulerTick> {
  const now = ctx.now();
  const out: SchedulerTick = { at: now, started: [], skipped: [], failed: [] };
  const mark = (id: string, error?: { at: number; reason: string } | null) => {
    if (!workflowExists(ctx.home, id)) return;
    updateWorkflow(ctx.home, id, (w) => {
      w.lastScheduledAt = now;
      if (error !== undefined) w.lastRunError = error;
    }, now);
  };
  for (const id of listWorkflowIds(ctx.home)) {
    let wf: WorkflowJson | null;
    try {
      wf = readWorkflow(ctx.home, id);
    } catch (err) {
      // Unreadable workflow.json: nothing to mark and no model call; say so once, go on with the others.
      const reason = `workflow.json is not readable (${err instanceof Error ? err.name : "error"})`;
      if (lastLogged.get(`${ctx.home}\u0000${id}`) !== reason) log(`brain: scheduler: ${id}: ${reason}`);
      lastLogged.set(`${ctx.home}\u0000${id}`, reason);
      continue;
    }
    if (wf === null || dueSlot(wf, now) === null) continue;
    try {
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
      const batch = await prepareLiveBatch({ home: ctx.home, workflowId: wf.id, model: ctx.model, now: ctx.now });
      mark(wf.id, null);
      const d = dispatchAuto(ctx, wf.id, batch, now, log);
      const shown = d.sending ?? d.held ?? batch;
      out.started.push({ workflowId: wf.id, batchHash: shown.hash, items: shown.items.length, sending: d.sending !== null });
    } catch (err) {
      const reason = failureReason(err);
      if (isLockConflict(err)) {
        // Busy: try again next tick (fails before any model call).
        out.skipped.push({ workflowId: wf.id, reason });
      } else if (err instanceof RunError) {
        // Nothing to do this slot (nobody left, paused meanwhile, kind not built): handled, not a failure.
        try {
          mark(wf.id);
        } catch {
          // Deleted meanwhile.
        }
        out.skipped.push({ workflowId: wf.id, reason });
      } else {
        try {
          mark(wf.id, { at: now, reason });
        } catch {
          // Deleted meanwhile.
        }
        out.failed.push({ workflowId: wf.id, reason });
      }
      log(`brain: scheduler: ${wf.id}: ${reason}`);
    }
  }
  return out;
}
