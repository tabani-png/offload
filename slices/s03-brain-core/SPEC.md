---
id: s03-brain-core
title: Brain core - read the store, sessionize Spans, group Tasks, compute stats with evidence links
depends_on: []
parallel_safe: true
human_gated: false
verify: bash slices/s03-brain-core/verify.sh
paths_in_scope: [brain/src/types.ts, brain/src/store/**, brain/src/sessionize.ts, brain/src/grouping/**, brain/src/stats.ts, brain/tests/s03-*/**, brain/tests/helpers.ts, brain/package.json, brain/tsconfig.json, brain/bun.lock, slices/s03-brain-core/**]
paths_out_of_scope: [engine/**, app/**, plan/**, packet/**, schemas/**, docs/**]
---

# s03-brain-core

## Summary
Turns the observer store (docs/store-contract.md, schemas/event.schema.json) into Spans and Tasks with deterministic
numbers. No model is called. Stack: Bun 1.3 + TypeScript strict, `bun test`, no runtime dependencies.
s01 (scaffold) had not landed when this slice was built, so `brain/` carries its own package.json and tsconfig.
Pipeline steps S1, S3 and S4 of `adam/memory/research/10-harness-and-task-mining.md` section 3.

## Acceptance criteria (each is a test in brain/tests/s03-*)
- AC-1 Store reader (`src/store/reader.ts`, `crypto.ts`, `schema.ts`)
  - Reads `days/YYYY-MM-DD.jsonl` and `days/YYYY-MM-DD.jsonl.enc`. An encrypted line is base64 of
    `nonce(12) | AES-256-GCM ciphertext | tag(16)`, key = `keys/YYYY-MM-DD.key` (32 bytes). Round-trip tested with node:crypto.
  - Every line is validated against `schemas/event.schema.json` (the validator reads the schema file: required,
    additionalProperties false, per-property type and enum).
  - Bad lines are returned with day, file, 1-based line number and reason: `invalid_base64`, `decrypt_failed`,
    `invalid_json`, `schema_invalid`, `duplicate_id`. A missing or wrong-size key marks every line of that day bad and
    adds a day error. Blank lines are counted separately. Nothing is silently dropped.
  - `readStore` keeps the newest N days (default 7). A missing home gives an empty store.
- AC-2 Sessionize (`src/sessionize.ts`, pure)
  - A Span is continuous focus on the same app + title + host. A segment ends at the next focus, `idle_start`,
    `pause`, or the last event. `idle_end` resumes the last focus; after `resume` nothing counts until the next focus.
  - Idle is removed from `activeMs`. Segments of the same focus split only by idle (gap at most 15 min) are one Span.
  - Blips shorter than 10 s are merged: into the previous span when contiguous (and the next one too when it has
    the same key), otherwise into the next span.
  - Input counts and OCR snapshots attach to the open segment; their ids join the span's `eventIds`.
- AC-3 Task grouping (`src/grouping/*`)
  - Rule features: app, host, URL path pattern (ids, numbers and hyphenated slugs masked; query and fragment
    dropped), masked title (emails, URLs, dates, times, ids, numbers), OCR content words, identifiers.
  - Titles inside one app + host + path partition are clustered by an order-stable, Drain-style template miner
    (LCS similarity >= 0.6 after collapsing proper-name runs), so names normalise to `<*>`.
  - Task signature = app | host | path pattern | title template; task id = `t_` + sha256(signature)[0..12].
  - Instances: one per span, except consecutive spans with the same title and the same counterparties within 45 s
    (a short interruption) form one instance.
  - Identifiers: counterparties = emails in titles and OCR minus the user's own (detected from mail window titles);
    domains of those.
  - `Labeler` interface (sync or async) names tasks from the profile only. The default Labeler is rules (kinds:
    email.outreach / email.scheduling / email.triage / email.replies / chat.messages / call.meetings /
    code.claude-code / code.terminal / sheet.updates / calendar.review / social.browsing / web.browsing / other).
- AC-4 Stats (`src/stats.ts`, pure)
  - instances, days active, instances/day, median and p90 (nearest rank) minutes, active minutes, share of active
    time, sameness 0..1 = mean(title similarity, step similarity); step similarity is pairwise Jaccard of OCR words,
    or duration regularity (1 - CV) when most instances have no OCR. Large tasks use an even, deterministic sample of 120.
  - Every figure carries the event ids behind it; median and p90 point at the instance(s) at that rank.

## Out of scope
Ranking, savings, connectors and the API (s04). Model-backed Labeler (later). Embeddings (research S2).

## Verify
`bash slices/s03-brain-core/verify.sh`: runs `bun test tests/s03-` in brain/, requires >= 20 tests and 0 failures,
then `bunx tsc --noEmit`. Exits non-zero on any failure.
