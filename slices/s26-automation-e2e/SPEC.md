---
id: s26-automation-e2e
title: Individual automation end to end - one repeated non-email task from capture to an executed, approved fix and a measured saving; one case per other fix kind; safe-builder plan
depends_on: [s05/s05b (gate, runner), s13 (chain, computer use), s14 (general plan, dry run), s17 (connect anything), s22 (solution designer), s23 (time breakdown, neutral week), s24 (brief runner, builder off by default)]
parallel_safe: true (one small seam in runner.ts prepareLiveBatch; new files otherwise)
human_gated: false
verify: bash slices/s26-automation-e2e/verify.sh
paths_in_scope: [brain/tests/s26-automation-e2e/**, brain/src/workflows/plan-live.ts (new), brain/src/workflows/runner.ts (prepareLiveBatch seam only), brain/src/workflows/dryrun.ts (general totals only), brain/src/plan/dryrun.ts (per-instance saved minutes only), brain/API.md, plan/adr/0013-safe-builder.md, plan/plan.md (ADR list + s26 row), slices/s26-automation-e2e/**]
paths_out_of_scope: [engine/**, app/**, control/**, web/**, packet/**, schemas/**, brain/src/workflows/{gate,allowlist,executor,batch,chain-executor}.ts, brain/src/connectors/**, brain/src/builder/** (the builder stays OFF by default), brain/fixtures/**, every other slice's tests]
---

# s26 individual automation, end to end

## Operator intent (binding)
The individual Mac side ships first. Its promise is on-the-fly automation: Offload sees a repeated task on one
person's Mac, picks the best kind of fix, and (after the person's exact one-time approval and a dry run) does the
work. This slice PROVES that path on one Mac with a hermetic test, fixes what breaks when the fix is small, writes down
what is big, and plans how the builder (s24, off by default) can be made safe to turn on. No fake pass.

## The task
From the s23 neutral week (`brain/fixtures/gen-neutral.ts`): **"Spreadsheet updates: Team metrics"**, a product
engineer typing the week's numbers (Week, Signups, Active, Churn) into a Google Sheet three times a day. It is the
top insight of the neutral week and is not email.

## The path (tag = test name prefix in `brain/tests/s26-automation-e2e/`)
Every step runs through the real brain HTTP routes (`createBrain`) with the stub model, a fake clock, the stub
connector chain and the in-memory computer-use driver. No network, no real model, no real UI, nothing sent.

| # | step | tag | what is checked |
|---|---|---|---|
| 1 | captures | CAPTURE | Mon-Wed of the neutral week written in the observer's store format (focus, masked OCR, input counts) |
| 2 | understanding / insight | INSIGHT | `GET /insights`: the metrics task is an insight with code arithmetic and evidence ids |
| 3 | time breakdown | TIME | `GET /time`: a finding for that task, fix kind `workflow`, hours freed > 0 and below observed |
| 4 | solution designer | DESIGN | `GET /insights/:id/solutions`: top `workflow`; no option saves more than observed |
| 5 | workflow built | BUILD | `POST .../solutions/choose {workflow}`: a general plan (output `rows`), every commit gated, auto-run off |
| 6 | dry run shown | DRYRUN | `POST /workflows/:id/dry-run`: every commit put to the gate and denied; nothing on the driver |
| 7 | approval | APPROVE | approving the exact dry-run hash activates the workflow; a wrong hash is refused |
| 8 | live batch | LIVE | `POST /workflows/:id/run`: the next rows of the person's `items.csv` become one live batch, each item carrying its exact commit `{verb, fields}` |
| 9 | execute | EXECUTE | approving the live hash mints a token; `sendBatch` runs the chain (computer use, stub driver): the gate allows the exact approved form once per item; a changed value is denied |
| 10 | result recorded | RECORD | batch `sent`, item states, gate log, `done-log.csv`, contacted ledger; the next run skips done rows |
| 11 | time saved | METRIC | `GET /dashboard`: measured saving is null until a full day after activation, then the code arithmetic of observed hours before vs after |

## Other fix kinds (each must end in a sensible, honest state)
| kind | subject | tag | honest end state |
|---|---|---|---|
| setup | held-back "Coding with Claude Code" (neutral week) | SETUP | brief drafted, approve exact hash, one-time hand-off of the builder prompt; checks written; building is refused (builder off) and the approval is kept; no saving is claimed on the dashboard |
| remove_step | s22 LinkedIn image fixture (the neutral week has none) | REMOVE | same as setup |
| tool | metrics task's tool option | TOOL | same brief path; build refused while the builder is off |
| leave_alone | "Inbox triage" (neutral week, top kind leave_alone) | LEAVE | choosing it is a 409 "nothing to build"; nothing is written; the time screen shows the finding with fix kind leave_alone |

## Fixes made here (small, inside the brain)
1. **Live batches for general plan workflows** (`workflows/plan-live.ts`, one seam in `runner.ts prepareLiveBatch`).
   Before: `live batches for generic workflows are not built yet` (400) - every non-email workflow stopped after the
   dry run. Now, for output types `rows | form_fields | record | stage_change`: the items are the rows of the
   workflow's own `items.csv` (header = field labels, one row per item; the person fills it, or exports it), next N not
   done yet (done-log + live batches + ledger), each item `{ key: row-<sha>, commit: { verb, fields } }`. The verb is
   the UI verb of the plan's commit when it has one (send, save, submit, create, ...), else `save`. Values are copied
   by code (ADR 0005). No model call. Missing / empty list = 409 with plain words. Text outputs (ticket_reply,
   message, email) still refuse plainly: drafting live replies for general workflows is not built.
2. **Honest dry-run saving for field outputs** (`plan/dryrun.ts`, `workflows/dryrun.ts`). Before: an instance where
   the workflow filled 0 of N fields still claimed its full minutes as saved. Now that instance saves 0 min with the
   warning "nothing to fill from what was on screen: this one stays with you", and the totals count only the
   instances the workflow can do. When every instance can be done, the totals and their arithmetic are unchanged.

## Written down, not fixed (big)
See the "Gaps" section of the PR and `plan/adr/0013-safe-builder.md`. In short: the read side of a general workflow
(new source data through a connector) is not wired, so live items come from `items.csv`; live text replies for
general workflows; a choice of leave_alone is not remembered; the builder stays off (ADR 0013).

## Done-signal
`slices/s26-automation-e2e/verify.sh`: brain typecheck; the s26 suite (>= 20 tests) with every tag above present and
passing; the full brain suite; `OFFLOAD_BUILDER_ENABLED` is still checked in `builder/runner.ts` and no s26 file sets
it; ADR 0013 exists and names every fix kind, at least two options with costs and one recommendation; no s26 change
touches an out-of-scope path.

## Cannot pass vacuously
The path test fails when any step returns nothing: at least 2 insights, a finding with hours freed > 0, a dry run
with >= 2 instances and as many denied commits, a live batch of >= 2 items, the driver pressed Save exactly once per
item with exactly the approved values, a measured saving > 0 with its arithmetic. verify.sh counts tests per tag; a
tag with 0 passing tests fails.
