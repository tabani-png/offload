# continuity (S2-10)

Offboarding (ADR 0107, amendments ADR 0113). Tables: `migrations/1000_continuity.sql` (`offboardings`, `handovers`,
`handover_events`, `removed_connections`).

## Reaching it from another module
`deps.ports.continuity` is the full object once routes are mounted; `continuityOf(deps.ports)` returns it typed
(`Continuity` in `continuity.ts`). The frozen `ContinuityPort` names only `freeze`.

| member | for | notes |
|---|---|---|
| `freeze(tx, person, reason)` | S2-01 directory webhook | the frozen port; idempotent (not active/leaving: no-op) |
| `freezeWith(tx, person, req)`, `markLeaving(tx, person, req)` | endpoint, sweep | |
| `runAs(tx, workflowId)` | S2-09 | `{held, identity}`: successor person, or role identity with its connection and signature |
| `checkRun(tx, {workflowId, identity, runnerPersonId})` | any runner | refusal (`forbidden`) audited as `run.identity_refused` / `run.held` |
| `held(tx, workflowId)` | | `awaiting_handover` / `awaiting_successor` / `null` |
| `sweep(tenantId)` | `continuity.sweep` job | departures, end dates, early hand-overs, pending worker pauses |
| `idle()` | tests, shutdown | waits for after-commit follow-ups |

## Freeze (one transaction)
Lock the person (row + `continuity:<id>` advisory lock), lock the person's active overnight policies (broker lock order
step 2), mark `frozen`, revoke sessions and devices (`revokeAccess`), delete (or erase, ADR 0113 §2) personal
connections, record the offboarding, open one hand-over per role workflow (registry `workflowsOf` + `getVersion`), then
`broker.stopRunsFor` (revokes tokens, pauses policies and workers, and flushes its audit events, taking the audit-chain
lock) LAST, then S2-10's own audit events, which were queued until then. Lock order: control/src/modules/broker/broker.ts. After commit: `WorkersPort.pauseFor` (advisory lock +
`pause_pending`, retried by the sweep).

## Lock order (with the broker's, control/src/modules/broker/broker.ts)
S2-10's rows come before the broker's step 1, in this order, and no path goes back up:
1. the leaver's `people` row (`FOR UPDATE`): freeze, depart, and every hand-over route (`lockHandover`, before the hand-over);
2. the advisory lock `continuity:<person>` (freeze, and its after-commit worker pause);
3. `handovers` rows, by id;
4. `offboardings` row;
then the broker's steps 2-9 (the freeze locks the leaver's active policies, step 2, before deleting connections that
batches reference), and the tenant's audit-chain lock last: S2-10's audit events are queued per transaction
(`deferAudits`) and written after the last row lock; `broker.stopRunsFor` flushes its own just before.

## Remote calls never block offboarding
`broker.stopRunsFor` calls `WorkersPort.pauseFor`. In the freeze it runs in a savepoint; if it fails, the freeze still
commits (tokens revoked, `person.freeze` with `runsStopDeferred: true`) and `offboardings.pause_pending` stays set:
after commit and on every sweep, `pausePending` calls `stopRunsFor` again (policies, workers) until it is delivered
(`person.workers_paused`). Registry calls (`workflowsOf`, `getVersion`) are in-process reads without locks.

## Gate
Mounting routes wraps `registry.isRunnableBy` and `broker.proposeBatch` (ADR 0113 §1). A test or wiring that overrides
`ports.continuity` gets no gate.
