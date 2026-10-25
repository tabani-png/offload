# 0109 Hours saved, computation version hs-1

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/06-hours-saved-method.md. Extends ADR 0005.

## Context
Operator: hours saved = median observed manual time minus measured review/fix time on successful runs, with an A/B/C
confidence grade, evidence links, deterministic. Market standard (Zapier 2 min, Microsoft 6 min, UiPath admin minutes)
uses assumed baselines; we observe ours.

## Decision
All arithmetic in integer seconds; rounding only at display. Implemented once in `packages/hours-saved` (pure,
no I/O, no clock, no randomness) and called by the control plane; the brain may call it for self-view.

1. **Baseline** for `(workflowId, version)`: the multiset `D` of `activeSeconds` from that version's
   `baseline_sample` objects (instances in the observation window; active time only, idle gaps over 120 s excluded on
   the Mac). If several devices sent samples, `D` is their union (deduplicated by `instanceRef`).
   `median(D)`: sort ascending; n odd → middle; n even → `floor((d[n/2-1] + d[n/2]) / 2)`.
   `q1`, `q3`: nearest-rank, `d[ceil(p·n) − 1]` for p = 0.25, 0.75. `iqr = q3 − q1`.
   `baselineSource`: `observed` if n ≥ 1; else `user_estimate` (seconds entered by the owner of the run, stored with
   who and when); else `default` (none: the workflow contributes 0 and is listed as "no baseline").
2. **Grade**: A = observed, n ≥ 5 and `2·iqr ≤ median` (iqr/median ≤ 0.5 without division); B = observed otherwise;
   C = user_estimate. Grade is per `(workflow, version)` and frozen with the baseline.
3. **Residual** per run `r`: `residual_r = reviewSeconds + editSeconds + fixSeconds` from that run's review events
   (Mac review sheet, web digest, fix-ups the user flagged). Missing review event → `saved_r = 0` and the run is listed
   as "not reviewed yet" (conservative: no measured residual, no credit). Exception: items committed under an
   overnight policy with no human review have residual = the morning digest seconds spent on that run (0 if the
   digest showed it and nobody opened it), because nobody reviewed them.
4. **Per run**: `saved_r = max(0, baseline × itemsSucceeded_r − residual_r)` for runs with outcome `success`; for any
   other outcome `saved_r = 0` and the run is listed separately. (`itemsSucceeded` = items `sent`; a baseline instance
   is one item, e.g. one outreach email.)
5. **Per scope and period**: `saved(scope, P) = Σ saved_r` over runs with `endedAt ∈ P` (half-open, UTC day bounds in
   the tenant's reporting timezone) whose workflow is in scope. Scopes: person, team/department, job role, company.
   Team/department/job-role/company views apply the group floor (ADR 0103 §5). Per-person views need
   `per_person_views` (ADR 0108) except self-view.
6. **Split**: every total also returns `byGrade { A, B, C }` seconds and `bySource { observed, user_estimate }`,
   `runs { success, failed, cancelled, rejected, capped }`, and `byRuntime { mac, cloud }` and `overnightSeconds`
   (runs started outside the runner's working hours setting).
7. **Evidence**: each total links to `GET .../evidence` → runs `{runId, endedAt, outcome, itemsSucceeded, baseline,
   residual, saved}` and the baseline sample `{instanceRef, activeSeconds, day}` (no content; refs resolve on the Mac).
8. **Re-baselining**: never rewrites history; a new version gets its own baseline (ADR 0104 §3).
9. **Money** (optional, owner-enabled): `hours × hourlyRate(department)`, rate shown next to the figure.
10. **Display**: hours = `round_half_even(seconds / 360) / 10` (one decimal). Label "measured" only for grade A/B
    observed; grade C shows "estimated".
11. **Reproducibility**: results carry `computation: "hs-1"` and `inputsDigest = sha256(JCS(sorted input rows))`. A
    nightly job recomputes every stored monthly total; a mismatch is an alert and blocks the CEO view's "final" badge.
12. **Anomaly flags** (shown, never auto-corrected): residual 0 on more than 90% of a person's runs in a month; baseline
    n < 3; device-reported outcomes for runs the broker also recorded that disagree.

## Consequences
- Numbers are explainable line by line and identical on every recomputation.
- Without review events, hours saved is conservative (0), which rewards wiring the review timer everywhere.
