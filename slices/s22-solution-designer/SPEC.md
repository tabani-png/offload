---
id: s22-solution-designer
title: Solution designer - for every repeated task, rank the best KIND of fix (workflow, tool, setup change, remove the step, leave alone)
depends_on: [s04-insights (insights, saving), s05-workflows (drafter, approval gate), s12-understanding (v2 steps), s14-any-task-workflows (general drafter, router, design pass)]
parallel_safe: true (with s20-blind-fixes: disjoint files; see "Shared files")
human_gated: false
verify: bash slices/s22-solution-designer/verify.sh
paths_in_scope: [brain/src/solutions/**, brain/tests/s22-solution-designer/**, slices/s22-solution-designer/**, brain/API.md, brain/src/cli.ts (solutions command), brain/src/api/server.ts (one route seam + additive insights field), brain/src/analyze.ts (additive heldBack list), brain/src/models/model.ts (role solution_design, stub), brain/src/models/router.ts (ROLE_ROUTES entry), outreach-bias neutralisations listed under "Bias audit"]
paths_out_of_scope: [engine/**, packet/**, schemas/**, app/**, brain/tools/import-screenwatch.ts, brain/src/understanding/{induce,embed}.ts, brain/src/plan/steps.ts, brain/src/insights/saving.ts, brain/src/store/vault.ts, brain/src/connectors/{chain,targets}.ts (s20-blind-fixes owns these), brain/src/workflows/{gate,allowlist,executor,batch,runner,chain-executor}.ts]
---

# s22-solution-designer

## Summary
Operator: Offload grew up around outreach email, which was only the most basic process in their screenshots. When
Offload finds a repeated task it must propose the BEST KIND of solution, not only an app-step workflow. Examples:
a custom system that improves their IDE / coding-agent workflow (most of their screen time is watching coding
agents), and removing the manual image generation for LinkedIn posts. Direction: any domain, MCP-first, best tool
per job. ADR 0005 (numbers are code), ADR 0006 (approval gates), ADR 0009 (router: Opus designs) hold throughout.

## Design
### 1. Kinds (KINDS)
For each insight (and each held-back task, below) the designer ranks five kinds of solution:
- `workflow` (a): automate it as a workflow - the existing drafter (s05 template or s14 general plan; MCP ->
  Composio -> API -> computer use through the s13 chain). Unchanged; the option only hands off.
- `tool` (b): build a custom tool or script. Spec: inputs, outputs, where it runs, rough effort.
- `setup` (c): change the user's setup / config: IDE, coding-agent rules and permission allowlists, notifications,
  shortcuts, templates, snippets.
- `remove_step` (d): replace a manual sub-process with an automated pipeline (e.g. post images generated from the
  post text instead of made by hand).
- `leave_alone` (e): do nothing, with the reason.

### 2. Deterministic core (RULES) - `solutions/signals.ts`, `solutions/rules.ts`
- Parts: v2 tasks = their understanding steps (verb, object, surface, app, host, activeMs, span ids from
  `stepOf`); v1 tasks = one part (the whole task). Each part gets tags from a fixed lexicon over its words (verb,
  object, surface, app name, host; v1 also titles, template, OCR keywords, label kind): `messaging`, `publish`,
  `media_make`, `agent_watch`, `agent_prompt`, `code_manual`, `data_entry`, `copy_between`, `reading`,
  `approval_prompt`. Messaging tags come only from messaging evidence (mail/chat surfaces, reply/send verbs,
  `email.*` / `chat.*` kinds): nothing else defaults to email. An app, domain or keyword alone never decides the
  kind of work: making and writing tags need the activity (the step's verb for v2, the label kind and name for v1,
  never OCR words), and a part that only reviews, reads or navigates gets none of them (a Figma review is not image
  making, reading Gmail is not messaging, reading the LinkedIn feed is not publishing).
- Observed weekly time (h/wk) = stats `activeMinutes` / 60 x 7 / window days. Every option's weekly saving =
  min(observed, observed x share x factor), where `share` = active-time share of the parts the option replaces and
  `factor` is a per-kind constant (SOLUTION_FACTORS, each at most 0.5: unmeasured shares never claim the larger
  half); `remove_step`'s factor is the s04 review model's low case on the measured minutes per item of the removed
  parts (every item still approved). The workflow option uses the s04 saving estimate (review
  model) times its share, also capped at observed. Each option carries the arithmetic string.
- Confidence (0..1, code): fit (from the tags and figures) x evidence (instances, sameness); level high >= 0.7,
  medium >= 0.45, else low. Effort: per-kind level + setup hours constant (EFFORT); payback weeks = setup hours /
  saving (null when no saving).
- Ranking: weekly saving x confidence, ties -> fewer setup hours -> kind order a..e. `leave_alone` goes first when
  no other option clears LEAVE_ALONE_FLOOR (0.5 h/wk x confidence) or the task is reading-only one-off work.
- Evidence: each option lists the span ids of the parts it replaces (all of them belong to the task) and the
  task's instance ids.
- The model never writes a number: kinds, order, savings, confidence, effort and evidence are code.

### 3. Design pass (DESIGN) - `solutions/design.ts`
Opus (`claude-opus-5-5`, role `solution_design` -> router route `design`) sees the MASKED profile summary
(understanding/context.ts), the user-context block and the rules options as JSON, and may rewrite only the words:
each option's `what` (one line), `why`, and the brief's `inputs`, `outputs`, `runsWhere`, `builderPrompt` and
`acceptance` lines. Same kinds in the same order; no digits, no angle brackets, size limits; anything else and the
whole reply is ignored (rules wording stands, `designedBy: "rules"`). The stub model echoes the baseline.

### 4. Hand-off and briefs (BRIEF) - `solutions/brief.ts`, `solutions/service.ts`
- `workflow` hands off to the existing drafter unchanged (`draftWorkflow` / `draftGeneralWorkflow`, the same call
  `POST /workflows/draft` makes). Held-back tasks have no workflow option.
- `tool` / `setup` / `remove_step` produce a solution brief: `$OFFLOAD_HOME/solutions/<sol_id>/brief.json` +
  `BRIEF.md` (0600): what to build, spec (inputs, outputs, where it runs, effort), the Claude Code prompt for a
  builder, acceptance checks, evidence ids, and the code figures. Status `draft`.
- Approval = the s05 gate's rules for a brief: `approve {briefHash}` only for the exact current content hash of a
  draft brief (sha256 of the canonical brief), mints a single-use hand-off token; `handoff {token}` returns the
  builder prompt once and marks the brief `handed_off`; a second use, a stale hash, an edited file or a wrong token
  is refused. Nothing runs: a brief is text for a builder. `leave_alone` has no brief. No dead ends: approving an
  approved, unused brief again for its exact hash replaces the token (the old one stops working); choosing the
  solution again redrafts a brief edited on disk or without a usable approval (voiding it) and, when the content
  changed, a handed-off brief (the old files move to `history/`).

### 5. Surfaces (API, CLI)
- `GET /insights` gains, additively, `solutions` on each insight (rules only, no model call: `{top, options[{kind,
  what, weeklyHoursSaved, effort, confidence}]}`) and a top-level `heldBack[]` (tasks that repeat but need a person
  at the keyboard, e.g. watching a coding agent, with their solutions). `toInsights` itself is unchanged (v1 golden).
- `GET /insights/:id/solutions` -> `SolutionsResponse` (design pass with the serve model).
  `POST /insights/:id/solutions/choose {kind}` -> workflow: the drafter's detail; else the brief (201).
  `GET /solutions/:id`, `POST /solutions/:id/approve {briefHash}`, `POST /solutions/:id/handoff {token}`.
- CLI: `solutions --insight N|ins_ID [--held N] --home DIR [--choose KIND] [--json] [--model stub|real]` (stub design
  model unless `--model` is given, like `draft`), `solutions approve --brief sol_ID --hash H`, `solutions handoff
  --brief sol_ID --token T`.
- `analyze.ts`: additive `Analysis.heldBack` = tasks with enough instances that the judge holds back
  (judgement >= maxJudgement). Insights and their order are unchanged.

### 6. Bias audit (BIAS)
Grep prompts, examples, few-shots, defaults and fixtures in brain/src for email/outreach assumptions that leak into
non-messaging tasks; neutralise them so messaging logic applies to messaging tasks only. Every change is listed in
the PR and pinned by a BIAS test.

## Acceptance criteria (tag = test name prefix in brain/tests/s22-solution-designer/)
- KINDS: fixtures (handcrafted insights over real span/step structure, run through the real designer):
  coding-agent watching -> top `setup` or `tool`; LinkedIn post image making -> top `remove_step`; email follow-up
  -> top `workflow`; one-off browsing -> top `leave_alone`. Every option has what, saving, effort, confidence,
  evidence.
- SAVING: no option's saving exceeds observed weekly time (fixtures + seeded random profiles + an inflated s04
  estimate); arithmetic string matches the figures; numbers identical with and without a model and user context.
- RULES: tags per lexicon; messaging only from messaging evidence; evidence span ids belong to the task.
- DESIGN: recorded Opus replies through a fake backend at the router boundary (route design, tier Opus) rewrite
  wording; a reply with a digit / new kind / reorder is ignored; numbers never change.
- BRIEF: workflow choice calls the existing drafter (same workflow id as `draft`); brief files 0600, draft status;
  approve exact hash only, single-use token, stale hash / edited file / reuse refused.
- API: additive insight field, heldBack, routes; existing keys unchanged.
- CLI: real CLI on the founder fixture (`solutions --insight 1 --json`) -> top workflow; `--choose`.
- BIAS: each neutralised default pinned.

## Shared files (seams, kept minimal)
- `brain/src/api/server.ts`: one `solutionsRoute(...)` call before the s14 routes; `/insights` body gets
  `withSolutions`.
- `brain/src/analyze.ts`: `heldBack` (additive).
- `brain/src/models/model.ts` / `router.ts`: role `solution_design` -> route `design`; the stub echoes `<baseline>`.

## Verify
`bash slices/s22-solution-designer/verify.sh`: typecheck; the s22 suite (>= 30 tests) with every tag present and
passing; the full brain suite; the real CLI on the founder fixture ranks `workflow` first for insight #1 and never
shows a saving above observed time; v1 golden digest unchanged; no commit since BASE touches an out-of-scope path.
