---
id: s20-blind-fixes
title: Brain fixes from the 7-day blind test - over-merging, gerund typing, surface names, saving cap, plain-mode keys, caption routing
depends_on: [s12-understanding (induction), s13-connector-chain (resolution chain), s14-any-task-workflows (step typer, CapabilityResolver seam), s17-connect-anything (universe targets)]
parallel_safe: true (disjoint from the screenwatch importer, which another builder owns)
human_gated: false
verify: bash slices/s20-blind-fixes/verify.sh
paths_in_scope: [brain/src/understanding/{describe,induce,labeler,surfaces,verbs}.ts, brain/src/plan/{steps,capabilities,chain-resolver}.ts, brain/src/insights/saving.ts, brain/src/analyze.ts (saving inputs), brain/src/api/{dto,types}.ts (additive SavingDTO.confidence), brain/src/api/server.ts (plan resolver seam), brain/src/store/vault.ts (key mode), brain/src/sync/keys.ts (key mode call), brain/src/connectors/{chain,link}.ts (order for captioned products only), brain/API.md, brain/tests/s20-blind-fixes/**, slices/s20-blind-fixes/**]
paths_out_of_scope: [brain/tools/import-screenwatch.ts (another builder; imported read-only by the s20 fixture), engine/**, packet/**, schemas/**, app/**, brain/fixtures/**, brain/src/workflows/{gate,allowlist,executor,batch,runner,chain-executor}.ts, brain/src/connectors/{catalog,config,targets,composio,api,mcp-probe}.ts, every existing test file]
---

# s20-blind-fixes

## Summary
A blind test ran the brain on 7 days of the operator's real screen data: screenshots only (no app, window or URL;
the screenwatch importer puts every span on one synthetic app), captions from a small local vision model. Six brain
problems came out of it. Each is reproduced on a synthetic fixture and fixed here; ADR 0005 (numbers are code), ADR
0006 (every commit is gated) and ADR 0007 (the chain decides how, never whether) hold throughout.

## Fixture (`brain/tests/s20-blind-fixes/fixture.ts`)
A synthetic blind week built the way the importer builds a home: events from the importer's own `buildEvents`
(imported read-only, one synthetic app `screenwatch.screen`, a focus per kept screen, idle stamped at a run's end) in
a plain-mode home (`days/<day>.jsonl`) plus the frame sidecar (`frames/<day>.jsonl`). 7 days x 14 sessions of 4-9
screens over 12 kinds of screen in 11 products; 74% of captions say "reviewing", objects are mostly generic
("content", "page"), products are named inconsistently (Instagram / instagram.com, Terminal / terminal, Chrome /
Google Chrome, ChatGPT / chatgpt.com) and writes come as gerunds (writing a note in Granola, typing a message in
Gmail, updating an issue in Linear). On `main` this week induces one task holding 53.8% of screen time across 8
products; the over-merge reproduces.

## Design and acceptance

### 1. Over-merging (MERGE)
Cause: every span shares the stand-in app's surface key, so the same-surface merge and the surface bonus join
anything whose embedding is close, and "reviewing ..." texts are close.
- `understanding/verbs.ts`: `GENERIC_VERBS` (review, reviewing, view, look at, read, check, browse, watch, scroll,
  skim, ...). `descriptionText` leaves generic looking verbs out of the embedded text and leads with surface + object
  (`"Gmail content. ..."`). In step assignment a shared generic verb earns no same-verb bonus.
- Stand-in apps (`describe.ts standIns`): an app is a stand-in when it is a browser with no URL, or when its captioned
  screens name >= 2 known products other than itself in >= half of its framed spans. On a stand-in, a span whose
  confident captions name a known product takes that product's app/host/path/category (`surfaceFrom: "caption"`);
  other captioned spans get the normalised described surface as a key suffix. Real apps that name themselves are never
  touched (the s12/s14 persona fixtures are unchanged).
Acceptance: 10 "reviewing" captions across 6 apps on one stand-in app yield >= 4 tasks, none mixing products; the
blind week has >= 10 tasks, none over 25% of screen time, each inside one product; the embedded text has no
"review"; a real Terminal span stays observed.

### 2. Step typer (TYPER)
Cause: verb tables are keyed on base forms; "writing" / "typing" fell through to reading ("reading only: nothing is
changed") and no draft or commit step was designed.
- `verbs.ts baseVerb`: gerunds and third-person forms map to base verbs (writing -> write, typing -> type, entering ->
  enter, updating -> update, sending -> send, filling (in) -> fill in, creating -> create, replying -> reply, editing
  -> edit; "typing a message" -> type). "reviewing" / "comparing" stay as they are (s14 types them as reading).
  Applied where frame verbs enter (describe vote, frameVerbs, refiner) and inside `isWriteVerb`, `verbClass` and the
  judge.
- `plan/steps.ts stepClass`: typing / editing / creating a text object (message, note, reply, email, comment, post)
  is a text write: draft + gated commit.
Acceptance: every listed gerund is a write verb and a text/record class; looking verbs stay reads; the blind week's
"writing note in Granola" plan has a draft before a gated commit and no "reading only" reason; "typing a message in
Gmail" plans an email with draft + gated `mail.send`.

### 3. Surface names (SURFACE)
`understanding/surfaces.ts`: `normalizeSurface` (no scheme / www, spacing folded, known aliases -> one product name,
bare domain -> its name, rest of the words kept) and `surfaceKeyOf` (lower case) before the vote; `KNOWN_SURFACES`
(Gmail, Google Docs/Sheets/Calendar/Meet, Granola, Linear, Notion, Slack, ChatGPT, Claude, Claude Code, LinkedIn,
Instagram, YouTube, X, GitHub, Figma, Zoom, Outlook, Xero, Greenhouse, Zendesk, HubSpot, Airtable; containers Chrome,
Safari, Terminal, iTerm, Cursor, VS Code, Finder, Preview) with host, path, bundle id and Composio toolkit.
Acceptance: Instagram = instagram.com, Terminal = terminal, Chrome = Google Chrome; in the blind week each alias pair
lands in one task; ten mixed Instagram / instagram.com screens are one step on one surface key.

### 4. Saving cap (SAVING)
`insights/saving.ts`: `SavingInput.activeMinutes` (the task's observed minutes) caps the estimate: the weekly time it
starts from is cut to the observed weekly time when it is more than 10% over it (rounding slack) or when the saving
alone would exceed it, and the arithmetic says so ("..., capped at the X h/wk observed"); the point saving and both
ends of the range never exceed the observed weekly time. `confidence: "low"` with plain `confidenceReasons` when
capped, fewer than 5 instances, one day only, one task holding > 50% of all time across >= 4 apps, or >= 50% of its
time described only with looking verbs. The DTO adds `saving.confidence` only on a low-confidence estimate (v1 output
stays byte-identical: s12 V1GOLDEN).
Acceptance: the blind test's 52 h/wk-from-46.6 h case is capped and flagged; 2000 random inputs never save more than
the observed time; the outreach demo's arithmetic is unchanged; every blind-week insight saves no more than observed;
looking-only tasks are flagged in the API, the Granola write task is not.

### 5. Plain-mode keys (KEYS)
`store/vault.ts`: `isPlainHome(home)` = day files `days/*.jsonl` and no `.jsonl.enc`, no `keys/` folder.
`brainKeyMode(env, home)`: OFFLOAD_KEYS=file -> file, =keychain -> keychain, unset -> file on a plain home, else
keychain. Sealing, opening, migration and sync keys pass the home.
Acceptance: the blind week's plain home seals and opens with OFFLOAD_KEYS unset and a failing fake observer that is
never called; an observer home still asks the Keychain; the env overrides both ways.

### 6. Routing (ROUTE)
Cause: every step's target was the stand-in app (`app-screen`) and plan needs stayed `pending`.
- Steps of a captioned product target it (point 1): Gmail -> `gmail`, Granola -> `app-granola`, Linear ->
  `web-linear-app`, Google Docs -> `web-docs-google-com` named "Google Docs" (`targetOf` / labeler use known names).
- `connectors/chain.ts chainOrder` and `link.ts resolutionMethods`: an app target of a routable known product tries
  mcp -> composio -> api -> computer (other app targets keep s13's composio -> api -> computer).
- `plan/chain-resolver.ts ChainCapabilityResolver` (the s14 seam): per need, the chain's methods in order, Composio
  through the product's s17 universe toolkit when the index (or, with the stub model, a demo sign-in) has it; the
  first healthy method that offers the capability wins, the reason lists what was tried first. `serve` passes it to
  the s14 draft route. Every commit still goes through the approval gate.
Acceptance: the four products' steps target their product; chain order for a captioned product is mcp, composio,
api, computer and unchanged for unknown apps; with method probes at the edge, Granola resolves through Composio,
Linear through its API, Google Docs falls to computer use only after mcp, composio and api were probed in that order;
with the stub model a demo Composio sign-in for `tk-granola` resolves Granola's needs through Composio.

## Verify (`slices/s20-blind-fixes/verify.sh`)
1. brain typecheck  2. s20 suite (>= 24 tests, every tag MERGE TYPER SURFACE SAVING KEYS ROUTE present and passing)
3. full brain suite  4. the importer file is untouched by s20 commits and no s20 commit touches an out-of-scope path.
`scripts/verify-all.sh` stays as green as on `main` (engine/app slices need macOS; on Linux they fail on `main` too).
