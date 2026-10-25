---
id: S2-11-dashboard-wiring
title: Dashboard wiring - web on the real API, static serving, evidence drill-down, gated per-person and working-time views
depends_on: [S2-04-web-shell, S2-05-ingest-metrics, S2-08-compliance]
parallel_safe: true
starts: wave C
human_gated: false
verify: bash slices/S2-11-dashboard-wiring/verify.sh
paths_in_scope: [web/**, control/src/modules/web/** (serves web/dist with CSP and cache headers), control/tests/S2-11/**, slices/S2-11-dashboard-wiring/**]
paths_out_of_scope: [other control modules, control core files, brain/**, app/**, schemas/** (frozen)]
---

# S2-11 dashboard wiring

## Summary
Swap the S2-04 mock for the real API (same fetch layer, `VITE_API=real`), serve the SPA from the control plane,
finish evidence drill-down and the gated views (working-time is S2-09's old "working-time insights": team medians
only, group floor, no ranking).

## Acceptance (tags in control/tests/S2-11/ and web/tests/S2-11/)
- SERVE: `/` serves index.html with CSP (`default-src 'self'`), hashed assets cached immutable, API routes unaffected.
- REAL: against docker-compose Postgres with seeded tenant: overview, department, workflows, approvals, compliance and
  self-view render real data; responses validate.
- FLOOR: seeded department of 4 shows the floor message everywhere it appears.
- GATED: per-person and working-time screens absent until the feature is enabled and effective; appear after.
- EVIDENCE: drill-down from company total → workflow → runs + baseline samples matches API numbers exactly.
- NORANK: no screen sorts people by a metric (DOM check on people and department screens).
- CSRF: every mutation sends the CSRF header; a request without it fails.

## Done-signal
`verify.sh`: web + control typecheck, ≥ 30 tests, tags, vite build, S2-04 suite green.
