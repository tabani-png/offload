---
id: S2-08-compliance
title: Monitoring compliance - feature enablement per jurisdiction, DPIA attestation, notices + acks, self-view, access log, templates
depends_on: [S2-01-control-core]
parallel_safe: true
starts: wave B (after S2-01 merges)
human_gated: false
verify: bash slices/S2-08-compliance/verify.sh
paths_in_scope: [control/src/modules/compliance/**, control/migrations/08*.sql (0800-0899), control/tests/S2-08/**, compliance/**, slices/S2-08-compliance/**]
paths_out_of_scope: [control/src/{app.ts,ports.ts,rbac,db,auth,audit,schema}/** (read-only), other modules, app/** (S2-13), brain/**, web/**, schemas/** (frozen)]
---

# S2-08 monitoring compliance

## Summary
ADR 0108. Provides `ConsentPort` and `FeaturePort` (replacing S2-01 defaults), registers `syncHandlers.notice_ack`,
serves `/v1/me/*` and `/v1/compliance/*` and `/v1/audit-log*` read views. Ships the compliance pack templates.

## Behaviour
- Tables (0800-0899): feature_enablements, notices, notice_acks, correction_requests, retention_runs.
- Enable (owner only): requires jurisdictions, legal basis, DPIA attestation fields, a published notice listing the
  feature, notice period (min 1 day for US-NY, US-DE, US-CT); `DE` requires worksAgreementRef; `CA-QC` requires
  quebecActivationAck; `effectiveAt = enabledAt + noticePeriodDays`. Disable: owner or admin, immediate.
- `FeaturePort.isEnabled(feature, jurisdiction, at)`; unknown jurisdiction = off.
- `ConsentPort.allows(person, kind, at)`: G1 and G2 of ADR 0103 from acks + enablements.
- Notices: draft → publish; adding a feature to a new version requires re-ack; history kept (no DELETE grant).
- Self-view `/v1/me/data`: assembled from every table holding the person's id (registry of person tables in this
  module, with a test that scans the catalog for `person_id` columns and fails if a table is not covered).
- Access log for self: audit events with `subjectPersonId = me`.
- Retention job: deletes per-person rows past tenant retention; logs a retention_run.
- `compliance/templates/*.md` with frontmatter (`id`, `jurisdictions`, `requiredFields`): ontario-esa-policy,
  ct-posting, ny-notice-and-ack, de-daily-notice, bc-ab-notification, quebec-8-1-8-2, ca-notice-at-collection,
  uk-eu-transparency, dpia, ca-risk-assessment, de-works-agreement; plus `compliance/data-map.md` and
  `compliance/dpa-subprocessors.md` (Managed Agents not ZDR, Composio, WorkOS, host TBD). Each carries "Not legal
  advice; review by counsel before use".

## Acceptance (tag = test name prefix in control/tests/S2-08/)
- FEATURE: owner only; missing attestation field → 400; DE without works agreement → 400; QC without ack → 400.
- PERIOD: feature visible in config only after effectiveAt; disable immediate.
- NOTICE: publish, ack via sync and via web, re-ack required on new feature; history immutable.
- CONSENT: ConsentPort/FeaturePort decisions table-driven per jurisdiction.
- SELFVIEW: catalog scan covers all person tables; output validates against self-view schema; export equals data.
- ACCESSLOG: a person.read by an admin appears in the subject's access log; not in another person's.
- CHAIN: audit verify endpoint ok; tamper detected (reuses S2-01 chain).
- HIDDEN: feature off → per-person endpoints 403 and device config false.
- TEMPLATES: every template exists with frontmatter; Ontario template has fields how, circumstances, purposes, date
  prepared, dates changed; every template carries the counsel line.
- RETENTION: rows older than retention deleted; aggregates kept.

## Done-signal
`verify.sh`: typecheck, ≥ 60 tests, tags, templates present, migration range respected, S2-01 suite green.
