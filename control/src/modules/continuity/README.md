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

## Gate
Mounting routes wraps `registry.isRunnableBy` and `broker.proposeBatch` (ADR 0113 §1). A test or wiring that overrides
`ports.continuity` gets no gate.
