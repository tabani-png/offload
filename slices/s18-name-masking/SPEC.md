---
id: s18-name-masking
title: Person-name masking - names never leave the Mac or reach notes; drafts are un-masked locally before review
depends_on: [s11-perception (frame notes), s12-understanding (span descriptions, personas), s14-any-task-workflows (router, text steps, dry run)]
parallel_safe: true
human_gated: false
verify: bash slices/s18-name-masking/verify.sh
paths_in_scope: [brain/src/privacy/**, brain/src/grouping/normalize.ts (maskText keeps person placeholders), brain/src/models/router.ts, brain/src/models/model.ts (ModelRequest.names, stub sign-off pattern), brain/src/vision/notes.ts (maskFields), brain/src/vision/prompt.ts (context hint), brain/src/understanding/describe.ts, brain/src/plan/text-step.ts, brain/src/plan/dryrun.ts, brain/src/tone/draft.ts, brain/src/workflows/runner.ts (run-scoped map only), brain/src/workflows/dryrun.ts (run-scoped map only), brain/src/workflows/autorun.ts + brain/src/workflows/batch.ts + brain/src/api/workflow-routes.ts (auto-run holds unfilled names; see Scope changes), brain/API.md, plan/adr/0010-name-masking.md, brain/tests/s18-name-masking/**, brain/tests/s05b-runner/idempotency.test.ts (ported H3 fix, see Scope changes), slices/s18-name-masking/**]
paths_out_of_scope: [app/**, engine/**, packet/**, schemas/**, brain/fixtures/**, brain/package.json, brain/bun.lock, every other test folder]
---

# s18-name-masking

## Summary
Known gap from s11 and s14: `grouping/normalize.ts maskText` masks numbers, emails, dates and ids but not person
names. Names leak into frame-note fields (activity, step, inputs, outputs; `counterpart` alone becomes `<name>`), into
span descriptions, and into the item text a text step sends to Claude (a CV, a ticket, a recipient row). This slice
adds a deterministic person-name masker (no model, no new dependency, ADR 0003 "metadata first", core principle
"deterministic over inference") and applies it at every point text leaves the Mac or is written into a note. What the
user reviews and approves is the real text, restored on the Mac; the gate hash is computed on that real text.

## Design
### 1. The masker (`brain/src/privacy/names.ts`, word lists in `privacy/lexicon.ts`)
Detection, per line, on runs of capitalised tokens (single spaces; lower-case particles van/de/da/di/del/der/la/le/
bin/al and middle initials allowed inside a run; possessive 's ignored):
- known names: the run map's names so far, the user's own name (policy), and contacts on disk (every
  `workflows/*/recipients.csv` first + last name). Full names match case-insensitively and across `.`/`-`/`_`/space,
  so `amara.okafor@`, `/in/amara-okafor` and a lower-cased identifier are caught once the name is known.
- honorific + name: Mr, Mrs, Ms, Miss, Mx, Dr, Prof, Sir, Dame, Mme, Herr, Frau (with or without a dot) + 1-3 tokens.
- cue + name: strong cues (Dear, Hi, Hello, Hey, Thanks, Cheers, Attn, Candidate, Applicant, Contact, Customer,
  Requester, Assignee, Name, Signed, cc, "assigned to", "reported by", "requested by") accept any capitalised token
  that is not a common/UI word; weak cues (from, by, with, to, for, meet, call, ask) need a given name or a pair.
- given + family pairs: 2-4 tokens whose first token is a given name or whose last token is a family name (embedded
  lexicons), none of them a common word, UI label, month, product or organisation word.
- signatures: the line after a closing ("Best,", "Thanks,", "Kind regards,", "Cheers,", "--", ...) or on the same
  line ("Thanks, Sam") when it is 1-3 name-like tokens.
- a lone given name (lexicon) anywhere; given names that are also common words (Will, May, Bill, Mark, Grace, June,
  Rose, ...) are not in the lexicon and need a cue, an honorific or a pair.
- email local parts that equal a name (every segment a given/family/known name, not a role mailbox like support@).
Runs containing an organisation word (Ltd, Inc, Logistics, Capital, Health, ...) or a product/app name (Google, Slack,
Xero, Greenhouse, Zendesk, ...) are never names.

Replacement: `NameMap` (one per run) gives stable placeholders `<person:TAG.N>` for the first surface it learns of
person N and `<person:TAG.N.first>`, `.last`, `.email`, `.full` for the other surfaces of that person (a casing variant
gets `~k`). TAG is a random 4-letter tag per map. The user's own name is `<person:TAG.me>` (`.first`, ...). Before
masking, any placeholder-shaped text in the input that the map did not write (any case, with or without a tag, also
after `maskText`) becomes `<name>`, so input cannot name a placeholder that restores to another person. Every surface has exactly
one placeholder, so `unmask(mask(x)) === x` exactly. The map lives in memory only: it is never written to disk,
logged or sent (`toJSON()` returns only a count). `maskNamesForStorage(text)` is the same detection with every
person collapsed to the grouping token `<name>` (notes keep no placeholder numbering and no map).
`maskText` is unchanged except that digits inside a `<person:...>` placeholder are not turned into `<n>`.

### 2. Where it applies
- Frame notes: `vision/notes.ts maskFields` (every captioner: stub, Ollama, Claude) runs `maskNamesForStorage` on
  activity, verb, object, surface, step, inputs and outputs (counterpart keeps its `<name>` rule; identifiers stay as
  the record ids the grouping needs, sealed on disk, and never go to a model). The caption user prompt masks names in
  the onboarding context hint.
- Span descriptions: `understanding/describe.ts` learns names from every span title of the run, then masks activity,
  object, surface, step and the embedded `text`.
- Every Claude request: `models/router.ts ModelRouter.complete` masks the system and user turns with the request's
  run map (`ModelRequest.names`) or a fresh one, before any backend (API, Claude Code login, stub) sees them. That
  covers every route: understand/label, design, choose, explain, execute, draft, item_step, refine, classify (bucket,
  style card). The captioner's text turn is fixed text + masked context.
- Replies: for text the user reviews (roles draft, step, style_card, explain) the router restores real names on the
  Mac before validation and before the caller sees the reply; for text that is stored as a name or a note (label,
  refine, workflow_design, bucket) placeholders collapse to `<name>`. A placeholder the map does not know (the model
  invented it) is left visible and the draft gets a warning "a name Offload could not fill in".
- Text steps and dry runs: `plan/text-step.ts` masks the source block with the run map; `plan/dryrun.ts` and
  `workflows/dryrun.ts` / `workflows/runner.ts` create one map per run (so every instance of one dry run uses the
  same placeholder for the same person) and pass it through `draftTextStep` / `draftInTone`.
- The user's own name (`$OFFLOAD_HOME/privacy.json`, `{ "ownName": "...", "ownNameToClaude": "mask" | "keep" }`; plus
  the workflow's facts.md `sign:` line for its runs): default `mask` (sent as `<person:me>`, restored locally); `keep`
  sends it as written and never masks it.

### 3. Review and gate
Drafts reach the batch with real names (restored by the router), so the approved item is exactly what is sent, and
`batchHash` is computed on that real text as before. The map never leaves the process.

## Acceptance criteria (tag = test name prefix in brain/tests/s18-name-masking/)
- DETECT: the rule kinds above, each with a known answer; placeholders are stable per run and per person part.
- NONNAME: a corpus of tricky non-names (UI labels, months, days, product, company and app names, job titles,
  headings) stays unmasked; the measured false-positive rate is <= 2% of corpus lines (printed by verify.sh).
- PERSONAS: known-answer masking for the five s12 personas (recruiter CVs, bookkeeper invoices with contact names,
  support tickets, sales-ops rows, founder outreach): every listed name masked, every listed non-name kept;
  measured false-negative rate <= 5% of name occurrences (printed by verify.sh).
- ROUNDTRIP: `unmask(mask(x)) === x` for every corpus text; the map serialises to a count only.
- NOTES: maskFields masks names in inputs/outputs/activity/step for every captioner path; stored sealed notes carry
  no fixture name; maskText keeps placeholders.
- SPANS: span descriptions of a persona week carry no fixture person name.
- ROUTER: every route's backend request is masked; draft/step replies are restored, label/refine/design collapsed;
  the run map gives the same placeholder across calls; an invented placeholder is reported.
- EGRESS: with a capturing backend behind the real router, analysing, drafting, choosing tools and dry-running every
  persona and the founder week (and a run of the founder outreach) sends no request body containing a fixture person
  name; the real `ApiBackend` HTTP body (stubbed fetch) has none either; the Claude captioner's text turn has none.
- INJECT: placeholder-shaped text in the input (a recipient's notes, `<person:1>`, `<person:me>`) is neutralised; a
  model echoing it in recipient B's draft (router, `draftInTone`, a live run) never restores recipient A's or the
  user's name.
- LEFTOVER: a draft that still holds a placeholder or `<name>` keeps its warning, is not auto-sendable, and the
  scheduler's auto-run sends the other drafts and holds it in a pending batch whose needs-you line says why.
- HELDOUT: a held-out set (>= 30 names in no lexicon, no cue, disjoint from the tuned corpus) has its false-negative
  rate measured and printed apart from the tuned rate (reported, not a gate).
- REVIEW: the drafted item and the approved batch contain the real names; the batch hash equals `batchHash` of the
  real text; the map never appears in any file under the home or in any request.
- SELF: own name masked as `<person:me>` by default and restored; `keep` sends it unmasked; facts `sign:` counts.

## Verify
`bash slices/s18-name-masking/verify.sh`: no new dependency (package.json/bun.lock unchanged since BASE); brain
typecheck; the s18 suite (>= 40 tests) passes with every tag present and passing; measured false-positive and
false-negative rates printed and within bounds; the full brain suite passes; the masker imports no model and no
network code; no s18 commit touches an out-of-scope path.

## Limits (stated, not gated)
- Names in no lexicon with no cue are not masked (held-out FN printed by verify.sh). Contacts in recipient lists are.
- Three model paths bypass the router and are not name-masked: screenshot captioning (the engine-masked image; its
  text turn is masked), the computer-use planner (screenshots, AX outline), and the approved batch handed to the
  executor (real text by design).

## Scope changes
- 2026-10-25: `brain/tests/s05b-runner/idempotency.test.ts` gets the H3 fix ported unchanged from S2-02 (PR #3,
  ba887f9): the test no longer probes the real `npx gmail-mcp` chain, which waited out the 5 s probe timeout wherever
  npx is installed and made the full brain suite red on main. Needed for this slice's "full brain suite passes" check.
- 2026-10-26 (review wave B, PR #7 item 2): `brain/src/workflows/autorun.ts` (`unfilledItems` in the auto partition,
  the needs-you sentence), `brain/src/workflows/batch.ts` (optional `review.unfilledNames`) and
  `brain/src/api/workflow-routes.ts` (`dispatchAuto` splits those drafts off) so an unfilled name is never auto-sent.
