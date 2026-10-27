# 0016 Keep local data 30 days

Date: 2026-10-26. Status: accepted (operator decision). Slice: s32-retention-30d. Amends ADR 0007 (and plan.md)
where they say 7 days.

## Decision
Everything Offload deletes "after 7 days" is kept 30 days instead: the observer's day files, day keys and
`frames/DAY/` keyframes, the brain keys named for a day (`keys/brain-YYYY-MM-DD.key`, `brain-keys/DAY.key`), the
brain's sealed artefacts (dry runs, batches, labels, tone corpus and blind tests, frame notes), the sync outbox and
evidence-ref maps. A day goes when its local age is greater than 30: today and the 30 days before it are kept.
One value per side: `Retention.defaultKeepDays` (engine) and `KEEP_DAYS` in `brain/src/store/vault.ts` (brain). The
app shows the brain's `retention.keepDays` and uses `LocalRetention.days` only for fixed copy.

## Why
Weekly and monthly tasks (a Monday report, a month-end close, an invoice run) show up once a week or once a month.
With 7 days of history Offload sees a weekly task once and a monthly one at most once, so it cannot tell a pattern
from a one-off. 30 days shows a weekly task four times and gives a monthly task one full cycle.

## Disk estimate
Keyframes dominate. Measured: the 118 app snapshots (real window content, 2088 x 1450) re-encoded the way the
observer does it (long edge 1280 px, JPEG quality 0.6) average 101 KB, the largest 150 KB; sealing adds 28 bytes.
The throttle keeps at most 60 frames an hour (20 s apart, near-duplicates dropped).
- Typical (8 active hours a day at the cap): 480 frames, about 48 MB a day, about 1.5 GB for 30 days.
- Ceiling (the cap every hour of every day): 1,440 frames, about 145 MB a day, about 4.3 GB for 30 days.
- Day files: about 1,150 events a day in recorded weeks, well under 1 MB a day sealed, under 30 MB for 30 days.
Brain artefacts are small text files. `OFFLOAD_KEYFRAMES=0` still turns keyframes off.

## What stays the same
- What is captured, masking, exclusions, Secure Event Input and idle rules, and encryption at rest.
- The purge schedule: at start, hourly, `purge-now`, the brain at start and hourly, the app's purge at launch.
- The analysis window: insights, hours a week and the dashboard timeline still use the newest 7 stored days.
- Files the user gave Offload (recipients, facts, CRM logs, edited tone cards) are still kept until deleted.
