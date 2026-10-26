// review_event: measured human seconds on one run (the hs-1 residual) and the decision. Never the edits themselves.
import type { ProjectionContext, ReviewEvent, ReviewInput } from "../types.ts";
import { runIdFor } from "./run-outcome.ts";

const secs = (n: number) => Math.max(0, Math.round(n));

export function projectReviewEvent(i: ReviewInput, ctx: ProjectionContext): ReviewEvent {
  return {
    id: ctx.ids("review_event", i.batchHash, i.at),
    kind: "review_event",
    createdAt: i.at,
    runId: runIdFor(ctx.ids, i.batchHash, i.startedAt),
    reviewSeconds: secs(i.reviewSeconds),
    editSeconds: secs(i.editSeconds),
    fixSeconds: secs(i.fixSeconds),
    itemsEdited: Math.max(0, Math.floor(i.itemsEdited)),
    decision: i.decision,
    surface: i.surface,
  };
}
