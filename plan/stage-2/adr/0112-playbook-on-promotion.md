# 0112 Amendment to 0104: a promoted messaging workflow carries its playbook

Date: 2026-10-25. Status: **proposed** (s19). Amends ADR 0104 and `schemas/stage2/workflow-definition.schema.json`
(frozen: not changed by s19; this ADR is the proposal). Depends on plan/adr/0011-messaging-playbook.md.

## Context
ADR 0104 strips facts values, recipient lists and tone examples on promotion, so a role workflow keeps its steps but
loses what the messages were saying. s19 adds a de-personalised messaging playbook per workflow (the message, rules,
templates, skeletons, cadence, outcome counts; no names, addresses, figures or author identity, checked fail closed).
That is exactly the part a successor or a cloud worker needs to keep the same message going in their own voice.

## Proposal
1. `workflow-definition.schema.json` gains an optional `playbook` object (`schema: "offload.playbook/1"`, the
   brain's `PromotablePlaybook`: everything in playbook.json except `history`, `builtAt` and `warnings`) and an
   optional `playbookHash` (sha256 hex of its JCS). Both are covered by `definitionHash`.
2. The Mac attaches them to a `workflow_proposal` only from `playbookForPromotion(home, workflowId)` (brain seam,
   brain/src/playbook/promote.ts), which re-runs the de-personalisation check first. The registry re-validates the
   shape and rejects (`422 playbook_personal`) any text field matching an email, phone or link pattern, as a second
   line of defence.
3. Promotion keeps the playbook; the SOP export (0104 §7) renders its message, rules and templates as a "How we write
   these" section. A new version without a playbook change keeps the previous playbook.
4. Who runs a role workflow drafts with the playbook and their OWN style card (Mac) or the role identity's (cloud
   worker, ADR 0105), never the original author's.

## Consequences
- S2-06 needs a schema version bump and a migration-free JSONB column on `workflow_versions`; S2-02's proposal
  projection gains one optional field. Neither is done in s19.
- Until accepted, the brain seam exists and is tested, and nothing is sent.
