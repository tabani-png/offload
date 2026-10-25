---
id: s14-any-task-workflows
title: General workflow builder - any task profile -> SKILL.md + typed steps + gates; onboarding role/industry context
depends_on: [s11-perception (frame notes store), s12-understanding (v2 task profiles), s13-connector-chain (capability resolution; in progress, coded against as a seam)]
parallel_safe: true (with s13: disjoint files except the seams listed under "Shared files")
human_gated: false
verify: bash slices/s14-any-task-workflows/verify.sh
paths_in_scope: [brain/src/plan/**, brain/src/models/{router,api-backend,factory}.ts, brain/src/vision/{claude,routed}.ts (+ additive edits to vision/types.ts, worker.ts), brain/package.json + bun.lock (@anthropic-ai/sdk), plan/adr/0007 (revision), plan/adr/0008-model-router.md, brain/src/workflows/service.ts (detail additive), brain/src/api/server.ts (two seams), brain/src/api/types.ts (CaptionerStatusDTO additive), brain/src/context/**, brain/src/tone/text-source.ts, brain/src/understanding/notes-source.ts, brain/src/understanding/pipeline.ts (span->step map, additive), brain/src/types.ts (additive), brain/src/analyze.ts, brain/src/store/reader.ts (fingerprint), brain/src/store/vault.ts (frame-notes purge), brain/src/models/model.ts (roles, stub), brain/src/workflows/{drafter,dryrun,types}.ts, brain/src/api/s14-routes.ts, brain/src/api/s14-types.ts, brain/src/api/dto.ts (status, additive), brain/src/cli.ts, brain/API.md, brain/tests/s14-any-task-workflows/**, app/Sources/** (onboarding step, review plan + general dry run, launch defaults), app/build.sh (test list), app/snapshots/**, scripts/live-captures.sh (only if a new live capture is needed), slices/s14-any-task-workflows/**]
paths_out_of_scope: [engine/**, packet/**, schemas/**, brain/src/connectors/** (s13, read only), brain/src/workflows/{gate,allowlist,executor,batch,runner,chain-executor}.ts (s13), brain/fixtures/gen.ts, brain/fixtures/gen-domains.ts (s12; read only)]
---

# s14-any-task-workflows

## Summary
Operator: email is one example of a million. Offload finds repeated work in any field (s11 perception, s12 induction)
and must build the end-to-end workflow for it. This slice turns ANY v2 task profile into a workflow folder:
`SKILL.md` + `workflow.json` whose `plan` holds typed steps (read, transform, decide, draft, commit), each mapped to a
plain-words capability need ("read supplier invoice from Preview", "create bill in Xero", "update candidate stage in
Greenhouse") that the s13 chain resolves to a method. Harness^2 style (research 10 section 2): propose two workflow
variants, probe both on last week's real instances, keep the one closer to what the user actually did, show the
choice. The dry run shows, per instance, what the workflow would have produced next to what the user did, for any
output type. Onboarding asks one optional question: role + industry. ADR 0005 (numbers are code), ADR 0006 (every
commit passes the approval gate), ADR 0007 (Claude sees masked text only, never images) hold throughout.

## Design
### 1. Glue s11 -> s12 (NOTES)
- `understanding/notes-source.ts`: frame notes for the analysis window = store events of kind `frame` + fixture
  sidecar `frames/<day>.jsonl[.enc]` + the s11 notes store (`readFrameNotes(home, day)`), merged unique by id.
  `analyzeHome --understanding v2` uses it; `Analysis.understanding` reports `framesRead`, `framesBySource`.
- Purge consistency: a `frame-notes/DAY.jsonl.enc` file is deleted when EITHER its file-name day or its sealed day is
  older than 7 local days (or the two disagree); fixture sidecars `frames/DAY.jsonl[.enc]` older than 7 days are
  deleted too. Readers already refuse expired days.
- serve watches new notes: `storeFingerprint` covers `frame-notes/*.jsonl.enc` and `frames/*.jsonl[.enc]` (size +
  mtime), and the serve analysis cache also keys on the user-context file, so a new note or context re-analyses.
- E2E test: an engine-format keyframe (blob + index, `tests/s11-perception/support.ts writeFrame`) -> `CaptionWorker`
  with `StubCaptioner` -> sealed notes -> `analyzeHome(v2)` -> the insight's understanding counts frame sources and
  lists the note ids.

### 2. General workflow builder (PLAN)
- Input: an insight whose task has `profile.understanding` (v2) and is not one of the two built email templates
  (`email.outreach`, `email.scheduling` keep their s05 templates: the email demo is unchanged). A v1 profile gets a
  one-step understanding synthesised from its app/category so the builder still works.
- Step typing (deterministic, `plan/steps.ts`): per understanding step, by verb class: reading verbs -> `read`;
  judgement verbs (review, screen, assess, compare, triage) -> `read` + `decide`; record writes (enter, key in,
  fill in, update, create, add, move, log, match, reconcile) -> `transform` (fields from what was read) + `commit`;
  text writes (reply, answer, respond, write, send, message) -> `draft` (text) + `commit`. A commit that writes text
  fields (a scorecard, a reply) gets a `draft` step before it. Steps that are not in every instance become a
  `decide` step ("when the item names an order") guarding their `read`.
- Capability need per step: `{ need, target, targetName, capability, role }`. `target` = catalog connector id when
  the surface is in the catalog, else `app-<slug>` / `web-<slug>` (same convention as s13 `connectors/targets.ts
  appTargetId`); `capability` = canonical names (`screen.read`, `file.read` for local documents, `ui.commit`, or the
  catalog verb such as `mail.send`); `role` read | send | log. transform / decide / draft are local (no target).
- Every `commit` step has `gated: true` and is preceded by an `approval_gate` step in the legacy `steps` array
  (`read`/`draft`/`approval_gate`/`send`/`log`, which the gate and the app already read): first commit = `send`, later
  commits = `log`, `sideEffect: true`, no tool (the s13 chain picks the tool). The model can never remove a gate.
- Output type (deterministic): `email`, `ticket_reply`, `message`, `form_fields`, `rows`, `stage_change`, `record`;
  text-producing: email, ticket_reply, message, and any commit with a text field (scorecard).
- Variants (`plan/propose.ts`): A "every step you take" = core steps + optional steps behind a decide; B "core loop
  only" = core steps; when A and B would be equal, B = A + a "check before saving" decide step. Then the design model
  (`claude-opus-5-5`, role `workflow_design`) may rewrite titles and details of both variants from the MASKED
  profile summary + user context block; its reply is validated (same step ids, types, capabilities and gates; text
  only; no digits; size limits) and ignored when invalid. Stub model: echoes the rules variants (deterministic).
- Probe (`plan/probe.ts`): for every instance of last week, each variant predicts the steps it would run (core
  always; a decide-guarded step when the instance's other spans carry an identifier of the kind the step uses);
  the user's actual steps come from the instance's spans (span -> step map from induction). Pooled step agreement =
  matched / (matched + extra + missed). The higher agreement wins; ties go to the variant with fewer steps, then
  A. The arithmetic is shown. `POST /workflows/:id/plan {variant}` lets the user keep the other one.
- Files: `SKILL.md` (frontmatter name, description, connectors, gates, auto_run off, models; steps in plain words
  with their capability needs; rules), `workflow.json` (`plan` = WorkflowPlan v2, legacy `steps` derived from it),
  `facts.md`. Fixed template text and catalog/app names only; observed labels stay sealed (labels.json.enc, s10b N8).

### 3. Generic dry run (DRYRUN)
- `dryRun` on a plan workflow returns the usual `DryRunResponse` plus `general`: per instance (newest first, `limit`)
  `ours` vs `theirs` for the plan's output type, a match figure with arithmetic, the steps (ours / theirs), evidence
  (event, span and frame ids) and the time estimate. Output builders:
  - form_fields / rows: values copied in CODE from the read step's OCR (ids, amounts, dates, names, titles) into the
    labels learned from the commit surface's OCR across the week; theirs = the fields parsed from the commit OCR,
    else the field names the frame notes list. Numbers are never written by a model.
  - stage_change / record: the commit action ("move to next stage", "save bill") + its fields; theirs from frame
    outputs and the commit surface OCR.
  - ticket_reply / message / email: a text draft from the cheap model (`claude-sonnet-5-5`, role `step`) with the
    instance's masked source text, the text tone pack and the user context; numbers not in the source are flagged.
- Each dry-run item is a `dry_run` batch item (key = instance id) so approving the dry run activates the workflow as
  before; every commit step is put to the gate in dry-run mode (`mcp__<target>__commit`) and denied. The proposed
  `commit` per item (`{ verb, fields: [label, value][] }`) is in the response: the s13 `BatchItem.commit` seam.
- Text tone (`tone/text-source.ts`): for text-producing steps only, examples are the user's own text seen on the
  commit surface (OCR lines typed in high-key spans, masked), bucketed by output type; a measured style card (length,
  greeting, sign-off, from N examples) + BM25 retrieval of 3-5 examples, the same approach as the Sent-mail pack.
  Sent mail stays the source for email. Non-text steps never get a tone pack.

### 4. Onboarding context (CONTEXT)
- Brain: `GET /context`, `PUT /context {role?, industry?}` (null or "" clears; unknown keys 400; sanitised one line
  <= 80 chars), stored in `$OFFLOAD_HOME/user-context.json` (0600). Used as `userContext` by analyze (CLI `--role`
  / `--industry` win) and by the workflow design and step prompts, inside the marked `<user_context>` block only.
  Test: with and without context, every figure, score, saving, variant choice and probe number is identical.
- App: one optional onboarding step "What do you do?" between the permissions and "Come back" steps: role and
  industry text fields with a few suggestion chips each, Skip allowed (↩ continues, nothing sent when empty), sent
  with `PUT /context`. Design system: dark hero, the only white control is the primary, colour = state, rings, radii
  24/16/12, keyboard first (Tab between fields, ↩ continue, ⌘↩ skip). Snapshots `onboarding-context` dark + light.

### 5. Defaults (DEFAULTS)
- The app probes Ollama (`GET 127.0.0.1:11434/api/tags`): healthy and an embedding model pulled -> the brain starts
  with `--understanding v2 --embedder ollama --captioner ollama`; otherwise `--understanding v1` and the stub
  captioner off, and the dashboard shows a needs-you line ("Local models are not running: Offload uses its simpler
  task finder until Ollama is running."). `OFFLOAD_UNDERSTANDING=v1|v2` overrides. The demo week keeps v1 + stub
  model, so the email demo is unchanged. `GET /status` gains `understanding {version, embedder, framesRead}`.

### 6. Known answers (KNOWN)
For each s12 persona (recruiter, bookkeeper, support, salesops, mixed: both tasks): the drafted workflow's plan has
the right step types in order, every commit is gated and preceded by an approval gate, the capability targets name
the persona's apps, the dry run returns one `general` instance per limit with the persona's output type, and the
founder week (gen.ts) still drafts the investor outreach template.

## Acceptance criteria (tag = test name prefix in brain/tests/s14-any-task-workflows/)
- NOTES: notes from the s11 store reach v2; purge rule; fingerprint changes on a new note; E2E engine frame -> stub
  captioner -> notes -> v2 insight.
- PLAN: step typing table; capability needs; commit gated + gate step; output type; two distinct variants; model
  rewrite validated (bad reply ignored, gates kept); probe agreement arithmetic; tie rule; user override; SKILL.md.
- DRYRUN: per output type ours/theirs/match; numbers copied by code; text drafts flagged for foreign numbers; dry-run
  batch + gate denials; commit seam shape; sealed on disk.
- TONE: text source examples, measured card, BM25 retrieval, only for text steps; email keeps Sent mail.
- CONTEXT: GET/PUT /context validation and storage; context reaches prompts in the marked block; no number changes.
- DEFAULTS: status understanding block; CLI flags.
- KNOWN: the five personas + founder template.
- App (Swift Testing, `S14` suites): onboarding flow with the context step (skip, fill, suggestions, body JSON),
  launch flags from the Ollama probe, plan + general dry-run decoding, copy has no internal words.

## Shared files (seams with s13, kept minimal)
- `brain/src/api/server.ts`: one call to `s14Route(req, path, ctx)` before the workflow routes, and the analysis cache
  key gains the context file stamp.
- `brain/src/workflows/service.ts`: `detailOf` adds `plan` (additive).
- Capability resolution: `plan/capabilities.ts` exports `CapabilityResolver` (`resolve(needs) -> resolution per
  need`); the default `PendingChainResolver` answers `pending` until s13's `connectors/chain.ts` is wired in.

## Verify
`bash slices/s14-any-task-workflows/verify.sh`: brain typecheck; the s14 suite (>= 45 tests) passes with every tag
present and passing; the full brain suite passes; the real CLI drafts and dry-runs the top insight of every persona
(generated encrypted) under v2 and checks step types, gates and output type from its JSON; the founder fixture still
drafts `investor_outreach`; vision code never imports the model; app tests (`app/build.sh test`) pass with S14
suites; fresh snapshots include onboarding-context (dark, light) and the committed set has them; no commit since
BASE touches an out-of-scope path.

## Scope additions (operator, 2026-10-25, during the slice)
### 7. Claude captioner (CLAUDE)
`vision/claude.ts ClaudeCaptioner` implements the Captioner interface with the official `@anthropic-ai/sdk`: the
engine-masked JPEG as a base64 image block, structured output (`output_config.format`) against the caption fields of
schemas/frame-note.schema.json, stop_reason checked first (refusal = skipped at once, no paid retry; max_tokens =
error), typed SDK errors, SDK retries and timeouts, only https://api.anthropic.com (base URL and every request URL
checked, redirects refused), key from ANTHROPIC_API_KEY or a Keychain reference, never logged; per-frame and total
token use (and $ via the router) in `captioner.usage` of GET /status. `--captioner claude|auto`; `auto` follows
`AUTO_CAPTIONERS` (cli.ts, one line): Claude when a key is configured, then a healthy Ollama, else off with
`captioner.needsYou`. `vision/routed.ts` falls back to the local model when the budget or the account says no. App:
opt-in toggle "Read screens with Claude (your company account). Images are masked first." on the context step and in
the dashboard.
### 8. Model router (ROUTER) - ADR 0008
`models/router.ts`: routes -> tiers (Opus understand/design/choose/explain, Sonnet execute/draft/first item steps,
Haiku caption/refine/classify/proven item steps), the Haiku -> Sonnet -> Opus ladder with reasons, demotion after 5
clean runs and promotion on any edit or failure, per-route tokens and $, monthly budget (captions local at 80%, paid
routes blocked at 100%), GET /status `models`, GET /models/usage. `models/api-backend.ts`: SDK, cached system prompt,
effort per route, adaptive thinking on Opus, `fallbacks: "default"` on Opus/Sonnet 5.5. The CLI and serve use it.
### 9. Tool recommendations (TOOLS)
Workflows are MCP/API first; on screen is the last resort. `plan/tools.ts` proposes 1-3 tools per capability family
(e.g. outreach email at 100 a day -> Instantly / Smartlead / Gmail; enrichment -> Apollo / Clay; log -> the CRM),
with why, setup effort, a cost note and whether it is connected; default = connected and good enough, else the
first; Opus may reorder and reword only. `POST /workflows/:id/tools`. Drafts inside a tool are non-commit steps; a
send or launch stays a gated commit. Template workflows get suggestions too; their sends still run through Gmail
(`runsWith`) until s13's chain can drive the chosen tool. SEAM: the option list lives here until s13's catalog
carries these tools.
### Scope changes in other slices' files
- `brain/tests/s11-perception/captioner.test.ts` C4 and `slices/s11-perception/verify.sh`: "no vision file talks to
  Anthropic" becomes "only vision/claude.ts (and the selector routed.ts) may; no vision file imports the text model
  or the Agent SDK". `brain/tests/s11-perception/pipeline.test.ts` C9: `--captioner claude` is valid now; an unknown
  captioner is still a usage error. No other assertion removed.
- `slices/s09a-wiring/tests/S09ALifecycleTests.swift`: onboarding has 4 steps ("1 of 4").
