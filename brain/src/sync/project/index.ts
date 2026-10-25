// The projector: one function per sync kind. Inputs are the narrow ProjectionInput types (sync/types.ts); this folder
// imports nothing from store/, understanding/, vision/, tone/ or the event types (checked by verify.sh), so it has no
// code path to raw activity.
export { projectNoticeAck } from "./notice-ack.ts";
export { projectRunOutcome, runIdFor } from "./run-outcome.ts";
export { projectReviewEvent } from "./review-event.ts";
export { projectBaselineSamples, MAX_INSTANCES } from "./baseline-sample.ts";
export { projectDailyAggregate, medianSeconds } from "./daily-aggregate.ts";
export { projectWorkingTime } from "./working-time.ts";
export { projectWorkflowProposal } from "./workflow-proposal.ts";
export { mask, maskTo } from "./mask.ts";
