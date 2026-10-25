// run_outcome: workflow id + version, run id, mac runtime, times, outcome, item counts by state, batch hash, approver
// kind. Never recipients, subjects, bodies, tool arguments, titles or URLs: RunInput has none of them.
import type { IdMaker, ProjectionContext, RunInput, RunOutcome, RunOutcomeCode } from "../types.ts";

/** The run id of a local batch run: shared by its run_outcome and review_event. */
export const runIdFor = (ids: IdMaker, batchHash: string, startedAt: number) => ids("run_outcome", `run:${batchHash}`, startedAt);

function outcomeOf(i: RunInput): RunOutcomeCode {
  if (i.items.sent > 0 && (i.state === "sent" || i.state === "partial")) return "success";
  return "failed";
}

export function projectRunOutcome(i: RunInput, ctx: ProjectionContext): RunOutcome {
  const outcome = outcomeOf(i);
  return {
    id: ctx.ids("run_outcome", i.batchHash, i.endedAt),
    kind: "run_outcome",
    createdAt: i.endedAt,
    runId: runIdFor(ctx.ids, i.batchHash, i.startedAt),
    workflowId: i.binding.workflowId,
    version: i.binding.version,
    runtime: "mac",
    startedAt: i.startedAt,
    endedAt: Math.max(i.startedAt, i.endedAt),
    outcome,
    items: { ...i.items },
    batchHash: /^[0-9a-f]{64}$/.test(i.batchHash) ? i.batchHash : null,
    approverKind: i.approver,
    overnightPolicyId: null,
    costCents: 0,
    errorCode: outcome === "success" ? (i.items.unknown > 0 ? "unknown_items" : null) : i.failed ? "send_failed" : i.items.sent === 0 ? "nothing_sent" : "send_failed",
    overnight: i.overnight,
  };
}
