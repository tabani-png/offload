# 0113 Continuity (S2-10) contract amendments

Date: 2026-10-26. Status: proposed (S2-10 builder; for the coordinator). Amends ADR 0107 and API.md where they are silent,
and records what S2-10 needs from other slices. Nothing here edits a frozen schema, `ports.ts`, `app.ts` or another
module.

## 1. The run gate goes through the public ports
SPEC: "Until assigned, `isRunnableBy` is false for every run of that workflow" and "a run attempting the frozen person's
identity is refused (`forbidden`), audited". Neither `RegistryPort` nor `BrokerPort` in `ports.ts` can be edited, so when
its routes are mounted the continuity module wraps two members of the registry's and broker's own port objects, the
same way the broker binds itself in place of its placeholder:
- `registry.isRunnableBy(tx, workflow, version, runner)` is `false` while a hand-over of that workflow belonging to a
  `frozen` or `departed` person is not ready (open; or a person successor who has not accepted, or not reviewed the
  hand-over message). Otherwise it is the registry's answer. Hand-overs opened early (person still `leaving`) hold nothing.
- `broker.proposeBatch(tenant, run, items)` first runs `continuityOf(ports).checkRun` in its own transaction:
  a run whose identity or runner is a person offboarded through continuity and now `frozen`/`departed` →
  `{ok: false, code: "forbidden"}` and audit `run.identity_refused`; a held workflow → `forbidden` and audit `run.held`.
  Then the broker's own checks run unchanged. A person frozen some other way (no offboarding row) still gets the
  broker's own `forbidden_binding`, so S2-07's contract is unchanged.
- The check and the proposal are two transactions. The window is harmless: the freeze revokes every approval the
  person minted or ran, so a batch that slips through cannot be committed without a new approval.
- `continuityOf(ports).runAs(tx, workflowId)` returns `{held, identity}`; `identity` is the successor person
  (`connectionId: null`, they send through their own connections) or the role identity with its company `connectionId`
  and `signature`. S2-09 should use it to pick the run identity.

## 2. Removing personal connections when history references them
On freeze every `personal-allowed` / `personal-forbidden` connection of the person (and any `linkedin_personal`) is
deleted. A connection that a batch still references (`batches.connection_id`, no `ON DELETE`) cannot be deleted; its
credential reference is erased instead (`external_ref = ''`, `health = 'failed'`). Either way the removal is recorded in
`removed_connections` (`mode` `deleted` | `erased`), audited `connection.removed`, and listed in every hand-over's
`removedConnections`. An erased row can never send: its owner is frozen, and the broker sends through a personal
connection only as its owner. In practice LinkedIn is always `deleted` (no batch can reference it).

## 3. Accept body and the hand-over message
- `POST /v1/handovers/:id/accept` takes `{reviewedHandoverMessage?: boolean}` (module-local schema, no extra fields).
- `inFlight: handover_message` needs a person successor (a role identity cannot write or review it): `400`.
- With `handover_message`, accepting without `reviewedHandoverMessage: true` is `409`; until accepted with it, the
  workflow is held (no send). `pause` is the default when `inFlight` is omitted; `stop` is recorded.
- A role identity successor needs no acceptance (it is the company's); the workflow runs as it at assignment.
- `inboxStep` is recorded as chosen (default `null`); Offload moves no mailbox (ADR 0107 §5).

## 4. Freeze, the after-commit pause, and S2-07's `stopRunsFor`
- The freeze is one transaction in the caller's (`ContinuityPort.freeze(tx, ...)`, the S2-01 webhook's or the
  endpoint's). It takes a per-person advisory transaction lock and sets `offboardings.pause_pending`. A follow-up task
  waits on that lock (released at commit or rollback) and calls `WorkersPort.pauseFor` only if the freeze committed,
  then clears the flag (audit `person.workers_paused`). If `pauseFor` fails, the flag stays and the sweep retries.
- `person.freeze` keeps S2-01's `detail.pending: true` (the after-commit pause is still to come) and `people.pending_freeze_at`
  is set to the freeze time, so the S2-01 suite holds with this module loaded.
- **For S2-07:** `broker.stopRunsFor` also calls `WorkersPort.pauseFor` inside the caller's transaction. SPEC S2-10 wants
  the pause after commit, so that a slow or failing worker service can neither hold nor roll back a freeze. Proposal:
  drop the `pauseFor` call from `stopRunsFor` (continuity makes it after commit). Until then it is called twice;
  `pauseFor` must be idempotent.

## 5. States, close rules, departure
- Legal transitions: `active→leaving`, `active→frozen`, `leaving→leaving` (new date), `leaving→active`, `leaving→frozen`,
  `frozen→departed`. Anything else is `409 conflict`. Offboarding yourself is `409`; an admin offboarding an owner is `403`;
  the last owner is `409`.
- `POST /v1/people/:id/offboard`: `reason: directory_deactivated` or `effectiveOn` ≤ today (tenant timezone) freezes now;
  a later date makes the person `leaving` and opens hand-overs early. `PATCH /v1/people/:id {leavingOn}` (S2-01) also
  makes a person `leaving`; the sweep opens their hand-overs.
- Close: only an `assigned` hand-over whose successor is ready (`409` otherwise). Closing the person's last open hand-over
  makes them `departed`. The sweep (`continuity.sweep`, every 15 minutes, once per tenant) freezes people whose end date
  has come, departs people frozen 30 days or with no hand-over left open, and retries pending worker pauses.
- A successor person must be `active`/`leaving`, hold the workflow's job role at assignment *and* at acceptance, and not
  be the leaver. A role identity must belong to the workflow's job role.

## 6. Proposals and knowledge (ADR 0107 §7)
Hand-overs open only for role workflows (registry `getVersion(workflow, 1)`, state `role`); unpromoted proposals get
none. `offboardings.proposals_kept_until` = departure + 90 days. **Open for S2-06:** proposals are stored as received
(the proposal half of a workflow row is immutable), so "kept without facts values" and deletion after 90 days need a
registry port (e.g. `discardProposal`); continuity will call it once it exists.

## 7. Matrix gap: who can accept
API.md gives `POST /v1/handovers/:id/accept` to the member column only (`S`). A successor whose access role is
dept_lead or admin therefore cannot accept. Proposal: `S` for every person column. Not changed (permissions.ts is S2-01's).

## 8. For S2-08: person columns of the continuity tables
`SELFVIEW: the catalog scan ...` (already red on `integration-wave-b` for wave-B columns) also needs these rows in
`PERSON_COLUMNS` (`control/src/modules/compliance/selfview.ts`):

| table.column | shownIn | reason |
|---|---|---|
| `offboardings.person_id` | `null` | my offboarding record: state, dates and reason; each change is in my access log (`person.offboard`, `person.freeze`, `person.departed`) |
| `offboardings.requested_by` | `null` | an admin's act, not data about them; recorded in the audit log as `person.offboard` |
| `handovers.person_id` | `null` | hand-over tasks for my workflows after I leave; each one is in my access log (`handover.*` events name me as subject) |
| `handovers.successor_person_id` | `null` | that I was named successor; the assignment and my acceptance are in the audit log (`handover.assigned`, `handover.accepted`) |
| `handovers.assigned_by` | `null` | an admin's or dept lead's act, recorded in the audit log as `handover.assigned` |
| `handovers.closed_by` | `null` | an admin's or dept lead's act, recorded in the audit log as `handover.closed` |
| `removed_connections.person_id` | `null` | references to my personal connections removed on exit; each removal is in my access log as `connection.removed` |
