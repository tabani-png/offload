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
connections, record the offboarding, open one hand-over per role workflow the person holds, proposed or ran (registry `workflowsOf`, broker `batches`, S2-05
`run_outcomes`; `getVersion` keeps role workflows), then
pause the person's active policies and `broker.revokeTokensFor` (which flushes its audit events, taking the audit-chain
lock) LAST, then S2-10's own audit events, which were queued until then. After commit: `WorkersPort.pauseFor`
(advisory lock + `pause_pending`, with a timeout, retried by the sweep).

## Lock order (with the broker's, control/src/modules/broker/broker.ts)
S2-10's rows come before the broker's step 1, in this order, and no path goes back up:
0. the tenant's owners lock (`lockOwners`, db/people.ts: the same key and hash as people PATCH and directory
   deactivation), taken by POST /v1/people/:id/offboard and by the sweep's end-date freeze, so the last-owner check
   cannot race (the sweep keeps a due last owner `leaving` and records `person.freeze_deferred`, once per tenant day);
1. the leaver's `people` row (`FOR UPDATE`): freeze, depart, every sweep step, and every hand-over route (`lockHandover`,
   before the hand-over). Assign and accept also hold a person successor's / the acceptor's row `FOR SHARE`; the two
   people rows are taken in id order (`lockHandover`), so reciprocal successors cannot deadlock;
2. the advisory lock `continuity:<person>` (freeze, and its after-commit worker pause);
3. `handovers` rows, by id;
4. `offboardings` row;
then the broker's steps 2-9 (the freeze locks the leaver's active policies, step 2, before deleting connections that
batches reference), and the tenant's audit-chain lock last: S2-10's audit events are queued per transaction
(`deferAudits`) and written after the last row lock; `broker.revokeTokensFor` flushes its own just before.

## Remote calls never block offboarding
The freeze transaction does only database work: it pauses the leaver's active overnight policies and revokes their
tokens (`broker.revokeTokensFor`), the same as `broker.stopRunsFor` without its workers call. The workers pause
(`WorkersPort.pauseFor`, a remote service) runs only after commit, from the durable `offboardings.pause_pending` marker
(`pausePending`), bounded by `pauseTimeoutMs` (30 s), and is retried by every sweep until delivered
(`person.workers_paused`). Registry calls (`workflowsOf`, `getVersion`) and the run-record reads are in-process reads without locks. The
end-date sweep re-reads the end date under the person lock before it freezes.

## Decisions are re-read under the lock
Every sweep step lists candidates in one transaction and decides in another: each one re-reads under the person lock
(departure: state, open hand-overs and the 30-day expiry; end date due; early hand-overs: state, end date, no
offboarding yet). The proposeBatch gate is a pre-check in its own transaction; the broker re-checks the hold (and the
runner's state) inside its own transaction at propose, approval and before every call.

## Gate
Mounting routes wraps `registry.isRunnableBy` and `broker.proposeBatch` (ADR 0113 §1). The broker also asks
`continuity.held` itself in `runRefusal`, so an approved batch of a held workflow is revoked before it sends. A test or wiring that overrides
`ports.continuity` gets no gate.
