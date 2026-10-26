# 0112 S2-07 broker and policy amendments (wave B review)

Date: 2026-10-26. Status: accepted for S2-07 (after slices/S2-review/REVIEW-wave-B.md, PR #12). Amends ADR 0105 §3,
ADR 0106 and API.md where they were silent. Schemas are unchanged; every rule below is server behaviour.

## 1. A policy approval holds only while the policy allows it
- `PATCH /v1/overnight-policies/:id` that pauses the policy, or narrows it, takes back what it approved and has not
  sent, the same way a breaker trip does: its unspent tokens are revoked and its approved, unsent items go back to
  `pending` with no token and no schedule (a person approves them, or the next night's evaluation does).
- Narrowing: state other than `active`; an allowlisted email or domain removed; thread replies switched off; mode
  `drafts_only`; a send-window day removed, a later start or an earlier end; a lower night cap, weekly cap or
  budget; attachments switched off; a different template hash; `recipientTimezone` switched.
- At execute, an item whose token has a `policy_id` is not sent unless that policy is `active`. Otherwise the
  policy's items are unlinked as above.

## 2. Dry-run nights start again on any trust-widening edit
- Widening: an email or domain added; thread replies switched on; mode `preapproved`; a send-window day added, an
  earlier start or a later end; a higher night cap, weekly cap or budget; attachments switched on; looser circuit
  breakers; a different template hash; `recipientTimezone` switched. `dryRunNightsDone` goes back to 0.
- If tonight has already started, the rest of tonight is a dry run, and tonight does not count.
- Re-arming a tripped policy (`state: active`) alone is not widening and keeps the nights done.

## 3. Dry-run nights: a floor, and only nights that did not trip count
- A policy has at least 3 dry-run nights unless an owner or admin sets fewer (create, or a PATCH that lowers it
  below 3): 403 otherwise. The schema still allows 0-30.
- A night counts toward `dryRunNightsDone` only if it did not trip: a trip during a counted dry-run night takes it
  back.
- The night's first evaluation decides whether it is a dry run. A signal or cost reported before it does not decide
  it (`overnight_counters.evaluated`).

## 4. One recipient, one send
- At propose and edit, two items whose recipients are the same after the brain's `normaliseAddress` (trim, case,
  NFC, punycode) are refused (`validation_failed`).
- At execute, an unreleased `sending` or `unknown` to the same recipient in another batch of the workflow holds the
  item in `pending` (approved) until a person releases it. The check and the journal entry run under one lock per
  (workflow, recipient).

## 5. Audit and journal text carry no recipient
`batch.propose_rejected` and `batch.item_denied` carry the item's `itemRef` and a reason code. Free text (brain
allowlist reasons, provider errors, a person's reject reason) goes through the brain's `scrubLogText`, with the
batch's recipients and their domains removed, before it is stored in audit `detail`, `batch_items.error` or
`batches.rejected_reason`.

## 6. Who sees recipients
- Batch fields: an approver only (ADR 0111 §6). A runner who is not an approver under the role policy
  (`approvers: dept_lead`) sees the batch like the owner does, with `itemRef` keys and no fields. This matches
  `GET /v1/batches`, which lists only batches I may approve.
- Overnight policies: allowlisted emails are shown to the policy's owner only. Everyone else in scope sees one
  content-free ref per email (`itemRef(workflowId, email)`). A ref sent back in a PATCH keeps the address it stands
  for.

## 7. Scheduler
The broker module declares the job `broker.commit_due` (every minute, once per tenant: `reconcile` and then
`runDue`). As for S2-08's retention job, `Job.run(deps)` carries no tenant, so the tenant is a second argument and
the job refuses without one. Whoever runs module jobs (S2-12 or ops) calls it per tenant. S2-09 must not call
`runDue` or `reconcile` itself.

## 8. Integrity in the database
Migration 0701 adds triggers that stop `offload_app` from changing an item's fields, hash, key, position, capability or
recipient; from moving an item out of a final state (`sent`, `failed_before_send`, `unknown`, `rejected`); from
changing a release; from changing a token's binding (hash, batch, keys, approver, policy, expiry); and from unsetting
or changing `used_at` or `revoked_at` once they are set. The table owner is not bound (migrations, incident tooling).
