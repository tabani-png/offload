---
id: s32-retention-30d
title: Keep local data 30 days instead of 7 (observer day files, day keys, keyframes, brain day keys and artefacts, sync outbox)
depends_on: [s02 (observer retention), s05b/s10b (brain purge), s11 (keyframes), S2-02 (sync outbox), ADR 0003, ADR 0007]
parallel_safe: true
human_gated: false
verify: bash slices/s32-retention-30d/verify.sh
paths_in_scope: [engine/Sources/**, engine/Tests/**, engine/README.md, brain/src/**, brain/tests/**, brain/fixtures/**, brain/API.md, brain/CONNECTORS.md, app/Sources/Core/**, app/Sources/Surfaces/**, slices/*/tests/**, slices/s31-local-jobs/**, slices/s32-retention-30d/**, docs/**, plan/**, README.md]
paths_out_of_scope: [app/Sources/App/** (purge launch code, s31), control/**, web/**, schemas/**, packages/**]
---

# s32-retention-30d

## Summary
Operator decision 2026-10-26: what Offload keeps on the Mac is kept 30 days, not 7. Weekly and monthly tasks need
more than one week of history before a pattern shows. Everything that was deleted "after 7 days" is deleted after
30 days instead; nothing else changes. What is captured, masking, exclusions and encryption stay as they are.
Full-screen capture is not part of this slice.

## Design
1. **One window per side.** Engine: `Retention.defaultKeepDays = 30` is the only value; `export-day`,
   `wrap-key`/`unwrap-key` and `status --json keepDays` read it, and the usage text names it. Brain:
   `store/vault.ts KEEP_DAYS = 30` is the only value; `api/dto.ts` imports it (no second constant),
   `api/types.ts` types `keepDays` as `number`, and `api/observer-route.ts` falls back to `KEEP_DAYS` (was `?? 7`).
   The sync outbox and evidence-ref maps already use `isExpired`; the outbox replay set (`sync/state.ts`
   `KNOWN_KEEP_MS`) follows the window (`KEEP_DAYS + 1` days) so an object id is remembered as long as it can sit
   in the outbox.
2. **Age rule unchanged.** A day expires when its local age is greater than keepDays: today and the 30 days before it
   are kept. The purge schedule (start, hourly, `purge-now`, app launch) is unchanged.
3. **Analysis window unchanged.** Insights, hours a week and the dashboard timeline still read the newest 7 stored
   days (`readStore windowDays 7`, `DashboardComposer.timelineMax = 7`). The app shows the retention from the brain:
   "Kept on this Mac, encrypted, 30 days", "x of 30 days stored", "Day x of 30"; fixed copy says 30 days.
4. **Docs.** docs/store-contract.md, engine/README.md, brain/API.md, README.md, docs/SETUP.md, plan text, and
   plan/adr/0016-retention-30-days.md (decision, why, disk estimate, what stays the same).

## Acceptance (verify.sh)
- ENGINE: in a temp OFFLOAD_HOME (OFFLOAD_KEYS=file) a day 8 days old and one 31 days old each have
  `days/DAY.jsonl.enc`, `keys/DAY.key`, `frames/DAY/<id>.enc` and `keys/brain-DAY.key`. The real
  `offload-observer purge-now` keeps every file of the 8-day day and deletes every file of the 31-day day;
  `status --json` reports `keepDays` 30.
- BRAIN: the same home with `brain-keys/DAY.key`, `sync/outbox/DAY.json.enc` and `frames/DAY.jsonl` for both days.
  The real `cli.ts purge` keeps the 8-day files and deletes the 31-day ones, with a purge-log line for the 31-day day
  and none for the 8-day day.
- STATUS: `cli.ts serve --model stub` on that home answers `GET /status` with `retention.keepDays` 30.
- ONE SOURCE: no `KEEP_DAYS = 7`, no `defaultKeepDays = 7`, no `?? 7` keepDays fallback, `dto.ts` has no own constant.
- COPY: app copy and docs no longer say data is deleted after 7 days.
- SCOPE: the diff against `git merge-base HEAD origin/main` touches only paths in scope.
