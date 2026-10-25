---
id: S2-05-ingest-metrics
title: Ingest (verify, consent re-check, store) and metrics API (hours saved, adoption, working time) with group floor
depends_on: [S2-01-control-core, S2-03-hours-saved]
parallel_safe: true
starts: wave B (after S2-01 and S2-03 merge)
human_gated: false
verify: bash slices/S2-05-ingest-metrics/verify.sh
paths_in_scope: [control/src/modules/sync/**, control/src/modules/metrics/**, control/migrations/05*.sql (0500-0599), control/tests/S2-05/**, slices/S2-05-ingest-metrics/**]
paths_out_of_scope: [control/src/{app.ts,ports.ts,rbac,db,auth,audit,schema}/** (S2-01, read-only), other modules, packages/hours-saved/** (read-only), brain/**, web/**, schemas/** (frozen)]
---

# S2-05 ingest + metrics

## Summary
ADR 0103 server side, ADR 0109 serving. `POST /v1/sync/batches`, `GET /v1/sync/config`, `GET /v1/metrics/*`.

## Behaviour
- Ingest pipeline: device token → `Offload-Signature` ES256 over the exact JCS bytes (re-canonicalise and compare) →
  `seq` > last and `sentAt` within ±10 min (`replay`) → per object: schema, `ConsentPort.allows(person, kind)`,
  `FeaturePort` for working_time → dispatch to the module's `syncHandlers[kind]` (this slice owns run_outcome,
  review_event, baseline_sample, daily_aggregate, working_time_aggregate; registry and compliance register theirs) →
  idempotent on `(tenant_id, device_id, object_id)` → `SyncReceipt`. One transaction per envelope.
- Tables (0500-0599): device_seq, run_outcomes, review_events, baseline_samples (+ instances), daily_aggregates,
  working_time_aggregates, metric_snapshots (monthly totals with inputsDigest), with the per-person RLS policy of
  ADR 0101 §5 on person tables.
- Metrics: build hs-1 inputs from tables, call `packages/hours-saved`, apply `suppress(tree, tenant.groupFloor)`;
  person scope only via `authorize` + `FeaturePort` + audit `person.read` in the same transaction with
  `SET LOCAL app.person_read = 'on'`. Evidence lists runs in scope; out-of-scope people's runs are counted only.
- Nightly job: recompute last 2 months' snapshots; mismatch → alert row + `final: false`.
- `GET /v1/sync/config` per device-config schema (features from FeaturePort, notice from ConsentPort).

## Acceptance (tag = test name prefix in control/tests/S2-05/)
- VERIFY: valid signature accepted; one flipped byte, other device's key, re-ordered keys with same JCS → expected results.
- REPLAY: same seq twice → replay; skewed sentAt → replay; same object id twice → accepted once (duplicate).
- CONSENT: before ack only notice_ack accepted; working_time rejected unless enabled+acked+period passed (fake ports).
- LEAK: an object with any extra field (e.g. `recipient`) → validation_failed and nothing stored; column scan: no text
  column in this slice's tables except ids, enums and codes.
- HOURS: endpoint output equals `packages/hours-saved` on the same rows (golden); company/department/job_role scopes.
- FLOOR: department with 4 people → suppressed (422 not used; cell suppressed); complementary suppression in children.
- PERSON: person scope without feature → 403 feature_disabled; with feature → 200 + audit event; self always 200.
- EVIDENCE: lists only in-scope runs; refs are opaque; pagination.
- RECOMPUTE: identical inputs → final true; altered row → mismatch alert.
- RLS: cross-tenant reads of every new table return nothing (reuse helper from S2-01).

## Done-signal
`verify.sh`: typecheck, ≥ 70 tests, tags, migration range respected, S2-01 suite still green.
