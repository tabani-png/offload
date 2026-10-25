---
id: S2-06-registry
title: Workflow registry - proposals, immutable versions, promotion to a job role, ownership tags, SOP export
depends_on: [S2-01-control-core]
parallel_safe: true
starts: wave B (after S2-01 merges)
human_gated: false
verify: bash slices/S2-06-registry/verify.sh
paths_in_scope: [control/src/modules/registry/**, control/migrations/06*.sql (0600-0699), control/tests/S2-06/**, slices/S2-06-registry/**]
paths_out_of_scope: [control/src/{app.ts,ports.ts,rbac,db,auth,audit,schema}/** (read-only), other modules, brain/**, web/**, schemas/** (frozen)]
---

# S2-06 workflow registry

## Summary
ADR 0104. Registers `syncHandlers.workflow_proposal`; provides `RegistryPort` (`getVersion`, `bindingsFor`,
`isRunnableBy(person|identity)`). Endpoints: API.md "Workflow registry".

## Behaviour
- Tables (0600-0699): workflows, workflow_versions (immutable: no UPDATE grant on definition columns),
  version_bindings, proposals_declined.
- Proposal ingest: validate, recompute `definitionHash` (sha256 of JCS of the definition minus id/kind/createdAt/
  workflowId/version/definitionHash) and reject on mismatch; dedupe by `(person, localWorkflowId, definitionHash)`.
- Promote: dept_lead of target department or admin; binds each step to a `company` connection or disables it;
  strips facts values (only `factsKeys` survive), recipients and tone; rejects `personal-forbidden` commit bindings
  and any commit capability on `linkedin_personal` with `409 forbidden_binding`.
- New version: immutable; baseline carry-over flag when step capabilities are unchanged (exposed for S2-05).
- SOP: deterministic Markdown template (`sop/template.ts`): purpose, trigger, steps in plain words, rules, gates,
  connections by label, owner job role, version history. `format=pdf` returns 501 `not_implemented` until a PDF
  dependency is approved (Scope changes note required to add one).

## Acceptance (tag = test name prefix in control/tests/S2-06/)
- PROPOSAL: accepted from a sync object; hash mismatch rejected; duplicate deduped; decline with reason.
- PROMOTE: allowed for dept_lead of target dept and admin only; creates version 1 owned by job role + department.
- VERSION: versions immutable (UPDATE fails at DB level); definitionHash stable across key order.
- BINDING: personal-forbidden commit → 409; linkedin_personal commit → 409 on promote and on new version.
- STRIP: promoted definition contains no facts values, no recipient-like strings from the proposal fixture.
- SOP: golden Markdown bytes; no connection secrets or external refs in output.
- RBAC: member sees role workflows of own job roles and own proposals only; dept_lead only own departments.
- AUDIT: proposed/promoted/versioned/retired/declined events written.

## Done-signal
`verify.sh`: typecheck, ≥ 50 tests, tags, migration range respected, S2-01 suite still green.
