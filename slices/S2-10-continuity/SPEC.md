---
id: S2-10-continuity
title: Continuity - offboarding state machine, freeze, hand-overs, successors, role identities, LinkedIn rule
depends_on: [S2-06-registry, S2-07-policies-broker]
parallel_safe: true
starts: wave C
human_gated: false
verify: bash slices/S2-10-continuity/verify.sh
paths_in_scope: [control/src/modules/continuity/**, control/migrations/10*.sql (1000-1099), control/tests/S2-10/**, slices/S2-10-continuity/**]
paths_out_of_scope: [other modules (use ports: BrokerPort, RegistryPort, WorkersPort (fake until S2-09 merges)), control core files, brain/**, web/**, schemas/** (frozen)]
---

# S2-10 continuity

## Summary
ADR 0107. Provides `ContinuityPort.freeze` (replacing the S2-01 default) and the continuity endpoints of API.md.

## Behaviour
- Tables (1000-1099): offboardings, handovers, handover_events.
- `leaving` (end date set): hand-overs open early; everything keeps running.
- `freeze(person)` (directory deactivation, admin action, or end date job): in one transaction revoke sessions and
  devices, mark person frozen, `BrokerPort.revokeTokensFor`, `BrokerPort.stopRunsFor`, delete the person's
  personal-allowed and personal-forbidden connections (incl. LinkedIn), open one hand-over per workflow they ran or
  owned; after commit `WorkersPort.pauseFor(person)`; all audited.
- Assign: successor person must hold the job role and accept (`/accept`), or a role identity of the job role;
  `inFlight` default `pause`; `inboxStep` records the native mailbox step chosen. Until assigned, `isRunnableBy`
  is false for every run of that workflow.
- Resume: runs use the successor's or role identity's connection and signature; a run attempting the frozen
  person's identity is refused (`forbidden`), audited.
- `departed` after all hand-overs closed or 30 days; unpromoted proposals kept 90 days without facts values.

## Acceptance (tag = test name prefix in control/tests/S2-10/)
- STATES: transitions and illegal transitions.
- FREEZE: every effect observed in one call; partial failure rolls back the transaction; pause called after commit.
- DSYNC: S2-01 webhook path ends in a frozen person (integration).
- HANDOVER: one per workflow; dept_lead scope; close rules.
- SUCCESSOR: must hold job role; must accept; role identity must belong to the job role.
- RESUME: identity switched; departed person's identity never used (attempt refused + audited).
- INFLIGHT: default pause; handover_message requires successor review before any send.
- LINKEDIN: personal LinkedIn connection deleted on freeze; cannot be re-bound to a commit step afterwards.
- SOP: role workflows and versions still readable and exportable after departure.
- AUDIT: assignment, acceptance, resume events with identity.

## Done-signal
`verify.sh`: typecheck, ≥ 50 tests, tags, migration range, S2-01 suite green.
