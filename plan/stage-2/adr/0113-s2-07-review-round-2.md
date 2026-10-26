# 0113 S2-07 broker and policy amendments (fix round 2)

Date: 2026-10-26. Status: accepted for S2-07 (PR #12 re-review: Codex P1, security N1-N4, N6). Amends ADR 0106 and
ADR 0112. Schemas are unchanged; every rule below is server behaviour. Migration `0702_broker_round2.sql`.

## 1. Dry-run nights are enforced at execute too (amends 0112 §2)
- A widening edit that restarts the dry-run nights (the policy has `dryRunNights > 0`) also takes back what the
  policy approved and has not sent, as a narrowing edit does (0112 §1).
- At execute, an item whose token has a `policy_id` is not sent while that policy is in its dry-run nights
  (`dryRunNightsDone < dryRunNights`) or when tonight, or the night it was approved on, is a dry-run night. Its
  policy's unsent items are unlinked.

## 2. Who may make a policy approve in a person's place
- A policy names a live role workflow version in the S2-06 registry (`getVersion`, state `role`). Without the
  registry, or for an unknown version, create and edit are refused (400). Its owner runs the workflow: a holder
  of its job role, or a dept lead of its department.
- `mode: preapproved` (create, switch to it, or any widening edit of a preapproved policy) needs one of: the owner
  as runner approver under the role policy (`approvers` names the runner and the owner holds the job role); a dept
  lead of the workflow's department; an admin; the tenant owner. Otherwise 403. Narrowing stays the owner's.
- `budgetCentsPerNight` is at most the role policy's `dailyBudgetCents` (400 on create or on a raise); the
  evaluator also caps the night's budget by it, so a later lower daily budget holds.
- A run uses an overnight policy only if the policy's owner is the run's runner (`runnerPersonId`), for person and
  role-identity runs alike. The run names the policy id; the broker never picks one, so another person's policy for
  the same workflow version is never used.

## 3. An approval binds the connection account and identity
- Each token stores `binding_hash`: sha256 (JCS) of the batch hash, sending identity, runner, job role, CRM sheet and
  the connection's id, kind, ownership, provider, external account ref, owner and job role. Execute re-derives it;
  a mismatch (a re-linked mailbox, a re-pointed batch) revokes the batch's unspent approvals (`batch.binding_changed`).
- The binding columns of `batches` and the token's `binding_hash` are immutable for `offload_app` (trigger).

## 4. Re-arming and resuming
- Leaving `tripped` (to `active` or `paused`) needs an owner, admin or dept lead in scope (403 for the member who owns
  it). `paused_by` records who paused; a member resumes only a pause they set. A pause by the system (freeze) has no
  `paused_by`.

## 5. Execute re-checks the role policy
- Before every call the job role's current policy must still allow the item's capability, and a person's approval
  must still come from an approver it names (runner, or an active dept lead of the batch's department). Otherwise
  the batch's unspent approvals are revoked.

## 6. Lock order
- Execute reads the overnight policies an item depends on `FOR SHARE`, before it locks the batch and item, the same
  order a policy edit or a trip takes them in.

## Follow-ups (not in this round)
- N5: the plaintext token lives only in memory between approval and dispatch; if the process dies there, the items
  stay approved and unsent until the token expires (24 h) and they go back to `pending` (fails safe, no resume).
- #17: nothing schedules the `broker.commit_due` job per tenant yet (S2-09/S2-12 scheduler).
