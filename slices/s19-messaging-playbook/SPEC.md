---
id: s19-messaging-playbook
title: Messaging playbook - the MESSAGE, style patterns and outcomes behind a messaging workflow, de-personalised
depends_on: [s05-workflows (tone pack, drafter, dry run), s14-any-task-workflows (model router, general dry run)]
feeds: [S2-06-registry (a promoted workflow carries its playbook; seam only, see section 7)]
parallel_safe: true
human_gated: false
verify: bash slices/s19-messaging-playbook/verify.sh
paths_in_scope: [brain/src/playbook/**, brain/fixtures/playbook-personas.ts, brain/tests/s19-messaging-playbook/**, brain/src/models/model.ts (two roles + stub branches, additive), brain/src/models/router.ts (ROLE_ROUTES for the two roles, additive), brain/src/tone/draft.ts (optional playbook, additive), brain/src/workflows/dryrun.ts (playbook verdict per draft, additive), brain/src/workflows/runner.ts (pass the playbook to draftInTone, one line), brain/src/workflows/autorun.ts (pin playbook.json when it exists), brain/src/api/workflow-routes.ts (GET/POST /workflows/:id/playbook), brain/src/api/types.ts (DryRunInstanceDTO.playbook, additive), brain/API.md, plan/adr/0011-messaging-playbook.md, plan/adr/0012-playbook-review-fixes.md (review fixes), plan/stage-2/adr/0112-playbook-on-promotion.md (proposed amendment), slices/s19-messaging-playbook/**]
paths_out_of_scope: [app/**, engine/**, packet/**, schemas/** (frozen: the registry field is proposed in ADR 0112, not added), control/**, web/**, brain/package.json + brain/bun.lock (no new deps), brain/fixtures/{gen,gen-domains,sent-mail}.ts (read only), brain/src/sync/** (S2-02, read only)]
---

# s19-messaging-playbook

## Summary
Operator: when a workflow is about messaging (outreach, follow-ups, replies), Offload must understand the STYLE of the
messaging, the MESSAGE the person is trying to portray, and the PATTERNS behind it, not just copy tone. Personal
things (who the person is, private relationships, personal details) are not carried over; the patterns are. A
de-personalised **messaging playbook** per workflow lets a successor or a cloud worker keep the same message going in
their OWN voice, and goes with the workflow when S2-06 promotes it to a team or role workflow.

Style card (s05) = how this person sounds. Playbook (s19) = what they are saying, to whom, in what shape, with what
result. The drafter uses the playbook for the message and the CURRENT user's style card and examples for the voice.

ADR 0005 (counts, shares, lengths and cadence are code), ADR 0006 (nothing here opens a gate), ADR 0007/0009 (models
see masked text only, through the router) hold throughout. Decision record: plan/adr/0011-messaging-playbook.md, amended by plan/adr/0012-playbook-review-fixes.md.

## Design

### 1. Sources and masking (`playbook/mask.ts`, `playbook/source.ts`)
- Input: `PlaybookMessage {id, channel: email|dm|ticket, to[], subject, body (raw), sentAt, replied?: boolean|null}`
  for one workflow. Email workflows read the sealed tone pack corpus (`loadTonePack`): the workflow's bucket plus the
  follow-ups in the same threads (recipient + subject without `Re:`/`Fwd:`). Other channels pass messages directly
  (library seam; fixtures for a support persona and a recruiter persona).
- Identity set (code): recipient addresses, their local-part names and domain stems, greeting names, sign names and
  the signature block (name line and the company after `Title, Company`), the author's `company:` and `sign:` from
  facts.md, and every capitalised mid-sentence word that is not on a short generic allowlist (days, months, Mac,
  Gmail, LinkedIn, Zoom, ...). These are the personal things.
- Masked text (what any model sees): emails -> `[email]`, links/hosts -> `[link]`, phones -> `[phone]`, numbers
  (incl. `$2.5M`, `40`, `20%`) -> `[number]`, greeting name -> `{first}`, author name -> `{sender}`, author company
  -> `{company}`, recipient orgs -> `{their_org}`, other identity words -> `[name]`. Quotes and signature blocks are
  cut first (tone/clean.ts).

### 2. Per-message read (`playbook/read.ts`), Haiku 5.5
- Rule labeller (code) gives every field from fixed vocabularies: role (first_touch | follow_up | reply), intent
  (book_meeting | get_reply | resolve_issue | confirm_details | share_resource), opener (personal_hook |
  direct_pitch | problem_first | short_preface | acknowledge | context_reference), body moves in order (hook, claim,
  proof, ask, attachment, apology, fix, next_step, alternative), CTA type (meeting | reply | resource | confirm |
  none) and whether it is time-boxed, proof kinds (traction | customer_outcome | momentum | social_proof | credential
  | specific_fix | timeline | role_fact), personalisation hook kinds (their_portfolio | their_writing |
  their_expertise | their_preference | their_work_history | their_issue_details | none: the KIND of fact, never the
  fact), follow-up / objection moves (adds_new_proof | lowers_the_ask | adds_urgency | plain_bump |
  asks_for_feedback | acknowledges_frustration | offers_alternative), audience segment, and the masked core claim.
- Structure is measured in code: words, sentences, paragraphs, questions, links, attachment mentions.
- The model (role `playbook_label`, route `classify` = Haiku 5.5) gets the masked text and the rule labels in
  `<label_hint>` and may overrule any enum field within the vocabulary and rewrite `coreClaim`, `positioning` and
  `audience` (masked again, cut to 160 chars, dropped when they leak). Anything off-vocabulary or unparsable falls
  back to the rule value. The stub echoes the hint.

### 3. Deterministic stats (`playbook/stats.ts`)
- Counts and shares per field (`{value, count, share}` sorted by count then value), median / p90 words, links per
  message, time-boxed CTA count, follow-ups per thread, days to the first follow-up (median; only positive gaps;
  others counted as `timingUnclear`), how follow-ups change (move counts).
- Outcomes (thread state): `replied` when the message carries `replied: true`, or a later message from the author
  in the same thread is a reply (role `reply`); `no_reply` when `replied: false` or the thread's next message is a
  follow-up; else `unknown`. Per pattern (opener, CTA, hook kind, proof kind, length band): `{sent, replied,
  noReply, unknown, enough}` with `enough = replied + noReply >= MIN_OUTCOME_SAMPLE (5)`. No rate is ever computed
  or written; under the sample the pattern reads "too few to say".

### 4. Playbook (`playbook/synth.ts`, `playbook/render.ts`), Opus 5.5
- Code writes a complete baseline from the stats: `message` (2-3 plain sentences: audience + intent, the core claim,
  the proof and the ask), `do` / `dont` rules (each `{id, text, check?}` where `check` is a machine-checkable rule:
  cta, opener, proof, max_words, max_links, no_author_identity), `templates` (first touch, follow-up) with slots
  `{greeting} {hook} {claim} {proof} {ask} {next_step} {sign_off}`, 3-5 de-personalised example `skeletons` built
  from the most common move sequences, `cadence`, `avoid`.
- The model (role `playbook`, route `understand` = Opus 5.5) gets the baseline in `<baseline>` and the counts, and
  may rewrite the wording of `message`, rule texts, template texts, skeletons and avoid lines (not ids, checks,
  slots or stats). Its reply is rejected (baseline kept, warning) when it is not the shape, adds a number that is not
  in the stats, drops a slot, or fails the de-personalisation check.
- `playbook.json` (`schema: "offload.playbook/1"`, `version` n, `builtAt`, `workflowId`, `channel`, `sources`
  {messages, threads}, `message`, `rules`, `templates`, `skeletons`, `cadence`, `avoid`, `stats`, `outcomes`,
  `notes`, `history[]`, `models` {label, synth}) + `PLAYBOOK.md` (deterministic render: same JSON -> same bytes) in
  `$OFFLOAD_HOME/workflows/<id>/`, 0600. Version +1 on every build and every notes edit.
- De-personalisation check (`playbook/leak.ts`) fails closed: any identity word, email, phone, link, number not in
  the stats, or the author's name or company in any text field (including user notes) -> `PlaybookLeakError`,
  nothing written (notes edit: 400). The check reports kinds and field paths, never the leaked value.

### 5. Using it (`tone/draft.ts`, `playbook/check.ts`, `workflows/dryrun.ts`, `workflows/runner.ts`)
- `draftInTone` takes an optional `playbook`: the prompt gains a `<playbook>` block (message, rules, templates) and a
  fixed instruction: say the playbook's message in the voice of the style card and examples, never the original
  author's sign-off, name or phrases. When the current user has no emails of this bucket, examples come from all
  their sent emails (voice only). So a successor writes in THEIR voice with the original MESSAGE.
- `checkPlaybook(draft, playbook)` (code): each checkable rule -> pass/fail with the rule text; verdict `yes` (all
  pass), `partly` (at least half), `no`. Dry run instances of email workflows gain `playbook: {version, verdict,
  rules: [{id, text, pass}]}` when the workflow has a playbook; live runs draft with it too; auto-run pins
  playbook.json when it exists (a rebuilt playbook holds the next auto batch for review).

### 6. API (`api/workflow-routes.ts`, brain/API.md)
- `GET /workflows/:id/playbook` -> `{version, workflowId, playbook | null, markdown | null}`.
- `POST /workflows/:id/playbook {action: "build"}` builds from the tone pack (409 `conflict` when there is no pack,
  fewer than 3 messages, or the check fails closed: the brain's ErrorCode set has no 422). `{action: "notes", notes}`
  sets notes (string <= 4000 chars, checked; 400 on a leak, a bad body or before the first build). Other keys 400.

### 7. Seam for S2-06 (`playbook/promote.ts`)
- `playbookForPromotion(home, workflowId)` -> `{playbook, playbookHash}` (re-checked; null when none), hash =
  sha256 of the JCS of the playbook without `history`/`builtAt`. The registry schema is frozen: the field is proposed
  as an amendment in plan/stage-2/adr/0112-playbook-on-promotion.md (`workflow-definition.playbook`, optional).

## Acceptance (tag = test name prefix in brain/tests/s19-messaging-playbook/)
- MASK: identity set from fixtures; masked text has no address, name, org, number or phone; the model prompt has none.
- READ: rule labels per message; model may overrule within vocabularies; off-vocabulary falls back; Haiku route.
- KNOWN: founder outreach (fixtures/sent-mail.ts): intent book_meeting, CTA meeting (time-boxed in most), proof
  traction, claim about automating repeat work, 12 replied / 6 no reply. Support persona: resolve_issue, acknowledge
  opener, proof specific_fix/timeline, CTA confirm/reply. Recruiter persona: book_meeting, hook their_work_history,
  proof role_fact, follow-ups that lower the ask.
- OUTCOME: counts with sample sizes, "too few to say" under 5 known outcomes, no rate or % in outcome output.
- PLAYBOOK: playbook.json shape + version bump, PLAYBOOK.md sections, deterministic render, 3-5 skeletons, slots.
- LEAK: names, emails, phones, links, orgs, private figures and the author's identity in model text or notes fail
  closed; clean playbooks pass on all three personas.
- NUMBERS: stats identical whatever the model says; a model number not in the stats drops the model text.
- ROUTER: per-message labels route to Haiku 5.5, synthesis to Opus 5.5 (router decisions).
- SUCCESSOR: a different user's tone pack + the founder playbook -> drafts keep the angle (claim + traction) and a
  meeting CTA, never "Muhammad", the founder's sign-off or the founder's phrases.
- DRYRUN: per draft `follows the playbook: yes/partly/no` with the specific failing rule; absent without a playbook.
- API: GET/POST playbook, notes edit, notes leak 400, 409 without a pack, 404 unknown workflow, promotion seam hash.

## Done-signal
`verify.sh`: typecheck; s19 suite >= 45 tests with every tag passing; full brain suite green; end-to-end on the
founder fixture through the real CLI and the brain API (build, leak scan of playbook files, dry run verdicts); no new
dependencies; s19 commits touch only paths in scope.
