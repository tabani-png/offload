---
id: S2-12-security-e2e
title: Security review, end-to-end on docker-compose, compliance pack review checklist
depends_on: [all S2 slices]
parallel_safe: false
starts: wave D
human_gated: true (counsel review of compliance/ before any sale; break-glass procedure sign-off)
verify: bash slices/S2-12-security-e2e/verify.sh
paths_in_scope: [tests/e2e-stage2/**, docs/security/stage2-review.md, docs/security/break-glass.md, compliance/REVIEW-CHECKLIST.md, slices/S2-12-security-e2e/**]
paths_out_of_scope: [product code (findings become fix slices), schemas/** (frozen)]
---

# S2-12 security + e2e

## Acceptance (tags in tests/e2e-stage2/)
- ISOLATION: two tenants seeded; every GET in permissions.ts called with tenant A credentials for tenant B ids → 404;
  raw SQL as offload_app without tenant → 0 rows on every table.
- RBAC: full matrix sweep (every endpoint × every access role) matches API.md.
- LEAK: the s09 demo fixture runs through brain → sync → ingest; a DB dump contains none of the fixture's content
  strings (recipients, subjects, bodies, titles, hosts).
- INJECTION: the S2-09 injection scenario end to end; nothing committed.
- E2E: enroll → notice ack → sync → propose → promote → cloud run (fake CMA) → digest approve → commit (fake Composio)
  → hours-saved report with evidence → offboard → hand-over to role identity → next run uses the role identity.
- CHAIN: audit chain verifies after the e2e; tamper detected.
- REVIEW: `docs/security/stage2-review.md` lists each threat of plan/stage-2/plan.md with test links and residual
  risk; `break-glass.md` exists; `compliance/REVIEW-CHECKLIST.md` lists each template with counsel sign-off fields.

## Done-signal
`verify.sh`: all S2 verify scripts pass, e2e suite ≥ 25 tests with tags, review docs present.
