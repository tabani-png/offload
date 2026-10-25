# 0107 Continuity and offboarding

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/04-continuity-offboarding.md.

## Context
Operator: when someone leaves, their workflows become company knowledge and keep running, but never as the departed
person, and a personal LinkedIn is never automated.

## Decision
1. **Person states**: `active` → `leaving` (admin set an end date; everything runs; hand-over tasks open early) →
   `frozen` (on directory deactivation, admin action, or end date) → `departed` (all hand-overs closed or 30 days).
2. **On `frozen`, in one transaction plus async follow-ups (target under 5 min)**: revoke web sessions and device
   tokens; mark devices `revoked`; stop and refuse any run whose runner is the person; revoke unspent approval tokens
   they minted; delete every `personal-allowed` and `personal-forbidden` connection of the person from Offload
   (including any LinkedIn session or cookie reference); pause deployments of workflows they ran; open one hand-over
   per workflow they ran or owned; audit everything.
3. **Hand-over** (admin or the dept lead of the workflow's department): per workflow pick a successor person (who must
   hold the job role and consent to run it) or the job role's role identity. Until assigned, the workflow does not run.
4. **Resumed sends** use the successor's or role identity's connection and signature. In-flight sequences: default
   `pause`; the successor may choose `handover_message` (a one-time message from the successor, reviewed by them,
   before any further outreach) or `stop`.
5. **Inbox**: Offload does not move mailboxes. The hand-over screen shows the native step for the tenant's provider
   (Google: data migration / alias to a group or successor / archive; Microsoft 365: convert to a shared mailbox) and
   then re-binds the email connection to the shared mailbox or successor. Replies on open threads route to the
   successor's approval queue.
6. **LinkedIn**: steps on a personal LinkedIn connection stop permanently and the connection is deleted. Offered
   migrations: the successor's own LinkedIn only with the successor's consent and human approval on every send
   (drafts only in cloud; commit steps on `linkedin_personal` are forbidden everywhere per ADR 0104), or the Company
   Page through approved APIs.
7. **Knowledge**: the person's role workflows stay in the registry as versioned SOPs; their personal proposals that
   were never promoted are kept 90 days for the admin to promote or discard, without facts values.
8. **Data about the departed person**: per-person aggregates follow retention (default 90 days) then delete;
   aggregates already folded into group totals stay; the audit log keeps who assigned which successor and when sending
   resumed under which identity.
9. **Employee transparency**: the notice (ADR 0108) states that role workflows are company property and continue
   after departure, and that personal accounts are disconnected on exit.

## Consequences
- The safe default is "stopped until someone decides"; continuity is a deliberate admin act, never automatic.
- Directory sync becomes operationally important; tenants without it rely on the admin action.
