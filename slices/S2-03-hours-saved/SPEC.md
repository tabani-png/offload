---
id: S2-03-hours-saved
title: Hours-saved engine hs-1 (pure package) with group-floor suppression
depends_on: []
parallel_safe: true
starts: immediately (wave A)
human_gated: false
verify: bash slices/S2-03-hours-saved/verify.sh
paths_in_scope: [packages/hours-saved/**, slices/S2-03-hours-saved/**]
paths_out_of_scope: [everything else]
---

# S2-03 hours-saved engine

## Summary
Implement ADR 0109 exactly, as a dependency-free TypeScript package (`packages/hours-saved`, own package.json and
tsconfig with the brain's strict flags, no runtime dependencies). Pure functions only: no clock, no randomness, no
I/O. Also implements the group floor with complementary suppression (ADR 0103 §5) because every aggregate goes
through it.

## API (exported from `src/index.ts`)
- `baseline(samples) → { source, n, median, q1, q3, iqr, grade }` (dedupe by instanceRef; integer math).
- `savedForRun(run, baseline, reviews) → { saved, note }`.
- `total(rows, scopeFilter, period, tz) → Cell` with byGrade, bySource, byRuntime, overnightSeconds, runs, people.
- `suppress(tree, floor) → tree` (cells under floor and complementary cells become `{suppressed:true, reason:"group_floor"}`).
- `displayHours(seconds) → number` (round half even to 0.1 h).
- `inputsDigest(rows) → sha256 hex` of JCS of rows sorted by id.
- `anomalies(rows) → Anomaly[]`.
- Types mirror `schemas/stage2/hours-saved-report.schema.json` and `hours-saved-evidence.schema.json`.

## Acceptance (tag = test name prefix in packages/hours-saved/tests/)
- MEDIAN: odd, even (floor of mean), n = 1, duplicates by ref removed.
- GRADE: A boundary (n = 5, 2·iqr = median → A; +1 s → B); B; C for user estimate; default → no baseline.
- RUN: only success counts; items multiplier; residual subtraction; max(0, ...); missing review → 0 + note;
  policy-committed residual from digest seconds.
- TOTAL: period half-open bounds in a timezone incl. DST change day; scope filters; splits sum to total.
- FLOOR: 4 people suppressed; 5 shown; complementary suppression when exactly one sibling is suppressed; no numeric
  field present in a suppressed cell.
- DISPLAY: round-half-even on tenths of an hour (180 s = 0.05 h → 0.0; 540 s = 0.15 h → 0.2; 900 s → 0.2; 1260 s → 0.4), large sums.
- GOLDEN: three hand-computed fixtures (outreach, AP invoices, recruiting) with expected JSON committed by the test
  author; output is byte-identical across runs.
- PURE: src imports nothing outside the package and no `Date`, `Math.random`, `fetch`, `Bun.`, `process.` usage.

## Done-signal
`verify.sh`: typecheck, ≥ 60 tests, tags, purity grep.
