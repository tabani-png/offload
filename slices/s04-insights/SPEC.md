---
id: s04-insights
title: Insights - ranking, saving estimator, connector map, fixture week, local API and CLI
depends_on: [s03-brain-core]
parallel_safe: true
human_gated: false
verify: bash slices/s04-insights/verify.sh
paths_in_scope: [brain/src/connectors/**, brain/src/insights/**, brain/src/analyze.ts, brain/src/api/**, brain/src/cli.ts, brain/fixtures/**, brain/API.md, brain/tests/s04-*/**, slices/s04-insights/**]
paths_out_of_scope: [engine/**, app/**, plan/**, packet/**, schemas/**, docs/**]
---

# s04-insights

## Summary
Turns s03 Tasks into ranked Insights with a saving estimate and its arithmetic, maps connectors, and serves it all
on a local API the UI codes against (`brain/API.md`, types in `brain/src/api/types.ts`). ADR 0005: the model never
produces a number. Pipeline steps S5, S6 and step 8 of the research doc's v1 pipeline.

## Acceptance criteria (each is a test in brain/tests/s04-*)
- AC-1 Ranking: `score = volume × sameness × reachability × (1 − judgement) × (1 − risk/2)`, volume = share of active
  time. Inputs outside 0..1 throw. Insights exclude tasks with < 3 instances, score 0 (no connector), judgement >= 0.8
  (needs a human: live calls, engineering) or an estimated saving < 0.25 h/wk.
- AC-2 Connector catalog `src/connectors/catalog.ts`: Gmail (`gmail-mcp`), Google Calendar, Slack, LinkedIn (limited,
  reach 0.3), Google Sheets, Notion, HubSpot, Attio, Zoom (limited), each `how: "gmail-mcp" | "composio:<toolkit>" | "none"`.
  Primary connector matches host or bundle id (Sheets also needs the /spreadsheets path). Calendar is added when
  >= 30% of instances read as scheduling. Reachability = primary reach, 0 without one.
- AC-3 `Judge` interface (sync or async) with a deterministic heuristic default: external send = risk 0.5, internal
  send 0.2; writing judgement = clamp(1 − sameness, 0.1, 0.9) ("free-form one-off writing" below sameness 0.5);
  reading / mail list views = triage (judgement 0.6, no risk); calls 0.9; code 0.8; sheets 0.15.
- AC-4 Saving estimator (pure): weekly hours now, after (review 20 s/item by default, configurable), saved, %, and a
  low/high range (low: review × 1.5 and 10% of items stay manual; high: review × 0.75). Inputs are rounded to what
  the string shows before the maths, e.g.
  `100/day × 5 days × 3.0 min = 25.0 h/wk → review 500 × 20 s = 2.8 h/wk → saves 22.2 h/wk (89%)`.
- AC-5 Fixture `brain/fixtures/gen.ts` (seeded, deterministic): 7 days for a founder; the analysis must give the
  outreach-email task as insight #1 with share 60-70% and saving 85-92%, and the scheduling task in the top 3.
  Plain and encrypted stores give identical insights.
- AC-6 API (`src/api/server.ts`): Bun.serve on 127.0.0.1 only; bearer token from `OFFLOAD_TOKEN` (>= 32 chars) or
  generated and printed once; foreign Host/Origin 403, OPTIONS 405, non-GET 405, no CORS, no-store.
  GET /status, /insights[?reviewSeconds=], /insights/:id/evidence, /timeline?day=YYYY-MM-DD, /dashboard (no
  automations yet). Shapes in `src/api/types.ts`, documented in `brain/API.md`.
- AC-7 CLI: `bun run brain/src/cli.ts analyze --home DIR [--top N] [--review-seconds S] [--json]` prints the top
  insights with their arithmetic; `serve --home DIR [--port P]` runs the API. Usage errors exit 2.

## Out of scope
Workflow drafting, dry run, approval gate, runner and the tone pack (s05). Model-backed Judge and Labeler.

## Verify
`bash slices/s04-insights/verify.sh`: runs `bun test tests/s04-` (>= 20 tests, 0 failures), `bunx tsc --noEmit`,
then generates the encrypted fixture with the real script, runs the real CLI and checks #1, share, saving and the
scheduling rank from its output. Exits non-zero on any failure.
