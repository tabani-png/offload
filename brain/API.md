# Brain local API (v1)

TypeScript types: `brain/src/api/types.ts` (the source of truth; this page explains them). `API_VERSION = 1`.
Changes inside v1 are additive only.

## Connection
- Base URL `http://127.0.0.1:<port>/`. The listener binds 127.0.0.1 only.
- Start: `bun run brain/src/cli.ts serve --home "$OFFLOAD_HOME" [--port P] [--model stub|real]` (`--port 0` or none =
  a free port). `--model real` (default) drafts with Claude through the Agent SDK; `--model stub` uses the
  deterministic offline test model (demos, e2e: no model cost). `claude` is an alias for `real` (s09b).
- Model label (s09b): every response has the header `x-offload-model: stub|real` (`MODEL_HEADER`), and every 2xx JSON
  object body gets `model: "stub" | "real"` (`ModelLabelled`) unless it already has one. Show stub drafts as
  "sample drafts". A stored dry run keeps the label of the model that wrote it.
- Ready line (s05c): the FIRST line on stdout is exactly
  `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}` (`BRAIN_READY_PREFIX`, one space, then `BrainReadyDTO` as JSON).
  Nothing is printed on stdout before it; startup, migration and purge logs go to stderr. Read stdout up to the first
  newline, check the prefix, parse the JSON. The listener is accepting connections when the line is printed. The
  token is printed only there (no `OFFLOAD_TOKEN=` line any more). A second line `brain listening on <url>` follows
  for older clients; do not rely on it.
- Auth: every request needs `Authorization: Bearer <token>`. The token is `OFFLOAD_TOKEN` (at least 32 chars) or, when
  unset, a fresh 256-bit token (it is in the ready line). The app passes its per-launch token in the env.
- Host must be `127.0.0.1` or `localhost` (any port). An `Origin` header, if sent, must equal `http://<host>`.
- GET (and HEAD) everywhere; POST, PUT and DELETE only on `/workflows…` (s05, s05c); POST on `/observer/pause` and
  `/observer/resume` (s09b); POST on `/connectors/:id/link` (s10e). Bodies are `application/json`,
  at most 64 KB. No CORS. Every response is `cache-control: no-store`, `x-content-type-options: nosniff`.

| status | body `error` | when |
|---|---|---|
| 400 | `bad_request` | malformed `day` or `reviewSeconds`, bad JSON body or field |
| 401 | `unauthorized` | missing or wrong bearer token |
| 403 | `forbidden` | foreign Host or Origin |
| 404 | `not_found` | unknown path, insight id, workflow id, batch hash, or a day not in the store |
| 405 | `method_not_allowed` | a method the path does not take, OPTIONS preflight |
| 409 | `conflict` | not allowed in the current state (run before activation, paused, batch not pending, connector missing) |
| 413 | `payload_too_large` | body over 64 KB, or a style card over `maxBytes` (16 KB) |
| 500 | `internal` | bug; logged on the brain's stderr |

Conventions: times are unix epoch ms; ratios and percentages are 0..1 (`share`, `savingPct`, `reach`); durations are
minutes unless the name says hours or seconds; days are `YYYY-MM-DD` local days.

Analysis is cached and recomputed when any day file changes (name, size or mtime).

Store reading (s05): days whose key file is a keychain-wrapped key (not 32 raw bytes) are read through
`offload-observer export-day DAY --home DIR` (`engine/.build/offload-observer`, or `OFFLOAD_OBSERVER_BIN`). A failed
export shows up as a day error in `/status` with every line counted bad; nothing is skipped silently.

Idle (s05): the observer stamps `idle_start` when it detects idle, 120 s after the last input. Sessionize backdates
it by that threshold (`IDLE_THRESHOLD_MS`), so the detection window is not counted as active time.

## GET /status → `StatusResponse`
Observer state (`recording` = an event in the last 5 min, `paused` = last event is `pause`, `stale`, `no_data`),
the stored days with event and bad-line counts and day errors (e.g. missing key), retention (`keepDays` 7, the next
day to be purged and the local midnight it expires), and a summary of the analysis.

s11: `captioner` (`CaptionerStatusDTO`) is the health of the local vision captioner that turns the observer's masked
keyframes into Frame notes (ADR 0007): `enabled`, `captioner` (`off` | `stub` | `ollama`), `model` (tag in use; with
`--vision-model auto` the best pulled `qwen3-vl` instruct model, `"auto"` until the first health check), `healthy`
(null = not checked yet), `queueDepth`, `processed`, `failed` (given up after 3 attempts), `skipped` (purged before
captioning), `lastPollAt`, `lastCaptionAt`, `lastLatencyMs`, `lastError` (a short reason, never note text). With
`serve --captioner off` (the default) it is `{enabled:false, captioner:"off", model:null, healthy:null, ...zeros}`.

## Perception (s11, ADR 0007)
`serve --captioner off|stub|ollama [--vision-model TAG|auto] [--ollama-url URL]`. Default off. `ollama` captions with
a LOCAL Ollama server; the URL must be loopback (`127.0.0.0/8`, `[::1]`, `localhost` pinned to 127.0.0.1), any other
URL is a usage error (exit 2), and requests use `redirect: "error"`. `stub` is the deterministic offline captioner for
demos and tests. The worker polls every 15 s for keyframes of the last 8 local days that have no note
(`offload-observer list-frames` / `export-frame`; in-process under `OFFLOAD_KEYS=file`), keeps at most 32 queued,
captions one at a time, masks every text field with `grouping/normalize.ts maskText` (a bare person name in
`counterpart` becomes `<name>`), and writes `frame-notes/YYYY-MM-DD.jsonl.enc` sealed with the brain key of the
frame's capture day (purged with it). Readers: `vision/notes.ts readFrameNotes(home, day)`. Images never leave the
Mac and never reach Claude; no route serves images or frame notes yet.

## GET /insights[?reviewSeconds=S] → `InsightsResponse`
Ranked insights, best first. `reviewSeconds` (0 < S <= 600, default 20) changes only the saving estimate.

Each `InsightDTO` has:
- `id` (`ins_…`, stable for the same data), `rank`, `taskId`, `kind` (e.g. `email.outreach`), `name`, `description`,
  `category`, `app`, `template` (title template, `<*>` = varies).
- `figures`: `instances`, `daysActive`, `instancesPerDay`, `medianMinutes`, `p90Minutes`, `activeMinutes`, `share`,
  `sameness`. Each is `{ value, unit, display, eventCount }`; `display` is ready to show ("64.4%", "3.0 min").
- `saving`: `weeklyItems`, `weeklyHoursNow`, `weeklyHoursAfter`, `weeklyHoursSaved`, `savingPct`,
  `reviewSecondsPerItem`, `range.low/high {hoursSaved, pct}`, `arithmetic` (show verbatim), `assumptions[]`.
- `score`: `{ value, formula, factors: { volume, sameness, reachability, judgement, risk } }`.
- `judge`: `{ judgement, risk, reasons[] }`.
- `connectors[]`: `{ id, name, how, reach, role: "primary" | "also", limits? }`. `how` is `gmail-mcp`,
  `composio:<toolkit>` or `none`.
- `identifiers`: counts plus up to 5 `topDomains`. `keywords`: top OCR words. `examples`: first 3 instances.

Example (fixture week, trimmed):
```json
{
  "id": "ins_…", "rank": 1, "kind": "email.outreach", "name": "Outreach emails",
  "figures": { "share": { "value": 0.644, "unit": "ratio", "display": "64.4%", "eventCount": 3479 } },
  "saving": { "savingPct": 0.89, "reviewSecondsPerItem": 20,
    "arithmetic": "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)" },
  "connectors": [{ "id": "gmail", "name": "Gmail", "how": "gmail-mcp", "reach": 1, "role": "primary" }]
}
```

## GET /insights/:id/evidence → `EvidenceResponse`
The proof behind every number: `figures.<name>.eventIds` (all figures plus `saving`), the task's `instances`
(with span ids and counterparties) and its `spans` (with their event ids). Use it for "show me the rows".

## GET /timeline?day=YYYY-MM-DD → `TimelineResponse`
That day's spans in time order, each with its `taskId`, plus `byTask` minutes (sums to `activeMinutes`).

## GET /dashboard → `DashboardResponse`
`automations`: one per workflow. Existing fields are unchanged (`status` keeps its 4 legacy values: draft, dry_run,
approved, paused). Added: `state` (`drafting | ready_for_review | active | paused | needs_you`), `needsYou[]` (plain
reasons: a batch waits for review, a required connector is missing), `arithmetic`, `pendingBatch` and `measured`:
observed hours/week on the task in the store on full days before vs after activation (activation day left out), with
its arithmetic; null until both sides have a day. `measuredHoursSavedPerWeek` = `measured.hoursSavedPerWeek`.
`totals` sum active and needs_you automations. `suggestions`: the top 3 insights not yet automated.
s09b: each automation has `taskId` (the task its workflow automates; timeline spans carry the same id). `needsYou`
reasons are full sentences for a person, shown as they are: "A new batch of 3 is ready for review.",
"Connect Gmail so this can send." (`… so this can log what it sent.` for a log connector, `… so this can run.`
otherwise; a server whose env var is missing adds " Its sign-in setting is not set yet.").

## Workflows (s05)
A workflow is a folder `$OFFLOAD_HOME/workflows/<id>/`: `SKILL.md`, `workflow.json`, `facts.md` (the only facts drafts
may state), `recipients.csv`, `crm-log.csv`, `scripts/`, `batches/<hash>.json` (live) or `<hash>.json.enc` (dry run,
sealed), `approvals.json`, `gate-log.jsonl`, `dry-run.json.enc`, `dry-runs/<ts>.json.enc`. Files holding OCR or mail
text (dry runs, dry-run batches, `tone/corpus.jsonl.enc`, blind-test pairs) are sealed with a per-day brain key and
purged after 7 local days, at `serve` startup and hourly, with a
`purge-log.jsonl` line `{day, deletedAt, events: 0, files, by: "brain"}` (s05b). Days older than 7 local days are
never read, even when their files exist; the brain asks `offload-observer purge-now` to delete them.
Brain keys (s05c, closes REVIEW-1 H4): by default the observer holds them, Keychain-wrapped, in
`$OFFLOAD_HOME/keys/brain-YYYY-MM-DD.key`; the brain gets a day's key with `offload-observer wrap-key --name DAY`
(creates it) or `unwrap-key --name DAY` (binary: `OFFLOAD_OBSERVER_BIN`, else `engine/.build/offload-observer`) and
keeps it in memory only. A missing or failing observer is an error (sealing fails, a sealed file reads as missing and
is NOT purged); there is no fallback to raw keys. `OFFLOAD_KEYS=file` (tests, fixtures only) keeps the s05b raw
32-byte files in `$OFFLOAD_HOME/brain-keys/`. Raw key files left from s05b are wrapped with the same bytes and deleted
when `serve` starts (and when a day with only a raw key is next used); a conflict is logged and the raw file kept.
States: `drafting` → `ready_for_review` → (approve the dry-run batch) → `active` ⇄ `paused`; `needs_you` is shown on
top of `active` when a batch waits or a connector is missing. Auto-run is off by default.

| route | body | returns |
|---|---|---|
| `POST /workflows/draft` | `{ insightId }` | `WorkflowDetailDTO` (201 new, 200 existing) |
| `GET /workflows` | | `WorkflowsResponse` |
| `GET /workflows/:id` | | `WorkflowDetailDTO` (steps, SKILL.md, facts, batches, `pendingItems` for review) |
| `POST /workflows/:id/dry-run` | `{ limit? 1..50 }` | `DryRunResponse` |
| `GET /workflows/:id/dry-runs/latest` | | `DryRunResponse`: the last dry run, opened from its sealed file for this response only; no model call. 404 when there is none or it was purged (older than 7 local days) (s09b) |
| `POST /workflows/:id/run` | | `RunResponse` (201): the next live batch, pending your review (409 until active) |
| `POST /workflows/:id/approve` | `{ batchHash }` | `ApproveResponse`: dry-run hash → `activated`; live hash → `sending` |
| `POST /workflows/:id/pause` / `resume` | | `WorkflowSummaryDTO`. Pause also stops a running batch before its next item |
| `POST /workflows/:id/release` | `{ batchHash, keys[] }` | `{ batch }`: you confirm these `unknown` sends did not go out; they can be drafted again (s05b) |
| `POST /workflows/:id/auto-run` | `{ enabled }` | `WorkflowSummaryDTO` with `autoRunPin` (s10b): on = pin (again) the recipient rows, facts.md, the tone card and SKILL.md; off = drop the pin and stop an auto batch before its next item |
| `DELETE /workflows/:id` | | `{ deleted }`. Stops a running batch first |
| `GET /workflows/:id/tone` | | `ToneCardDTO`: the style card of the workflow's tone bucket (`text` null when none) (s05c), plus `measured` (s10e, below) |
| `PUT /workflows/:id/tone` | `ToneCardUpdate { text }` | `ToneCardDTO`. Stored 0600 in `tone/<bucket>.md`; kept by later `tone build` unless `--force` |
| `GET /workflows/:id/skill` | | `SkillDTO`: SKILL.md, the editable text, the steps, gate ids, limits (s05c) |
| `PUT /workflows/:id/skill` | `SkillUpdate { description?, steps?: [{ id, title?, detail? }] }` | `SkillDTO`, SKILL.md re-rendered |

Tone PUT: only `text`, a non-blank string without control characters (tab and newlines are fine), at most
`maxBytes` = 16384 UTF-8 bytes (413 above). The card is the user's own style description; it goes into the drafting
prompt as before.

Tone `measured` (s10e, `ToneMeasuredDTO | null`, on GET and PUT): "Your voice" as a fact sheet, counted in code
(`measureStyle`, ADR 0005) over the tone pack's sent emails of the workflow's bucket: `emails`, `medianWords`,
`p90Words`, `medianSentences`, `greeting` and `sign` (`{ form, count }` of the most common one, e.g.
`{ form: "Hi {first},", count: 18 }`, null when the emails have none), `askShare` and `exclamationShare` (0..1),
`sample` (one sentence quoted from a real sent email of the bucket, never the greeting or sign-off, at most 140 chars:
the first body sentence of 5+ words of the median-length email) and `source` in plain words ("18 sent investor
emails"). null when there is no tone pack (or it was purged after 7 days) or the bucket has no email. `serve` does
not build a pack; `tone build` does (scripts/demo.sh builds one for the demo home from the fixture sent mail).

Default facts (s10e): when `$OFFLOAD_HOME/default-facts.md` exists, a new workflow's `facts.md` starts as a copy of it
(else the empty template). scripts/demo.sh writes the fixture founder's facts there.

Skill PUT edits text only. Allowed keys: `description` (1-1000 chars, may span lines) and per existing step id `title`
(1-120 chars) and `detail` (1-600 chars), both one line. No line may start with `#`, `---` or a code fence (SKILL.md
structure stays the template's). Any other key (`type`, `tool`, `connector`, `sideEffect`, `script`, `gates`,
`autoRun`, `skillMd`, ...), an unknown or repeated step id, or invalid text is a 400 and nothing is written. Steps
cannot be added, removed or reordered; omitted steps keep their text. The gate and runner never read SKILL.md: they
read the typed steps in workflow.json and the allowlist (`src/workflows/allowlist.ts`), which this route cannot touch.

Run times on `WorkflowSummaryDTO` and `AutomationDTO` (s05c): `lastRunAt` = `createdAt` of the newest live batch
(null before the first `run`); `nextRunAt` = the next due minute of the workflow's cron schedule in local time, only
while the workflow is active (or needs_you); null when the schedule is manual, paused or not yet approved. The brain
computes when a schedule is due; since s09b the `serve` run loop fires it (below).

Run loop (s09b, `src/api/scheduler.ts`): `serve` ticks every 30 s (and once at start). A workflow whose cron slot came
due since the later of its activation and its last handled slot (`lastScheduledAt` in workflow.json) starts ONLY when
its stored status is `active`. Auto-run off: the next live batch is drafted and left pending; the dashboard shows
needs_you "A new batch of N is ready for review." and nothing is sent until you approve that hash. Auto-run on: the
loop approves that exact batch hash (a one-use token, as `POST /approve` gives) and sends it through the gate, but only
when every required connector is connected; otherwise the batch stays pending. Nothing is ever sent without an
approved batch hash. Each slot is handled once: missed slots are not replayed, slots passing while paused (or while a
batch waits) are skipped, a pending batch is never replaced, and resuming does not catch up.

Auto-run pin and failures (s10b, REVIEW-2 N1, N2, N5): with auto-run on, the loop and `POST /run` send on their own
only recipients whose row was pinned when auto-run was turned on and is unchanged, drafted from the pinned facts.md,
tone card and SKILL.md. New or changed rows are split into a pending batch (`RunResponse.held`; needs_you "3 new
recipients need your review."); a changed pinned file holds the whole batch. Show `autoRunPin` (pinnedRecipients,
counts, file hashes with `changed`) when the user turns auto-run on. Turning auto-run off or pausing stops an auto
batch before its next item; a batch you approved yourself is not stopped by auto-run off. A scheduled run that fails
marks its slot, sets `lastRunError` and needs_you "The last scheduled run did not finish: ...", and is not retried
until the next slot; one failing workflow never stops the others.

Dry run: the task's newest real instances from the store (recipient and subject from OCR), our draft next to the OCR
excerpt of what you wrote, and per instance `estimate { observedMinutes, reviewSeconds, savedMinutes }`, computed in
code. Every side-effect step is sent through the gate in dry-run mode, denied and logged (`sideEffects`, `gateLog`).

Approval: `batchHash` is sha256 over the workflow id, the batch kind and every recipient, subject and body. Approving a
live batch stores a token for that hash only, used up when the batch starts. The runner's gate (`canUseTool` +
`PreToolUse` hook) is an allowlist (s05b, `src/workflows/allowlist.ts`): per connector one canonical send tool and one
CRM log tool, each with a declared argument schema. A call is allowed only with that token, only when the canonical
hash of its FULL arguments equals the expected hash of one item of that batch, and only once per item. Every other
tool that is not an allowlisted read is denied, unknown tools included. A dry run allows zero non-read tools.
A dry-run batch is never sendable. Live approval needs the workflow's required connectors connected (409 otherwise).
One run per workflow at a time (409 `conflict` while another prepare or send holds the lock).

Item states (`BatchSummaryDTO.sent`, `.unknown`): every item is `pending → sending → sent | failed_before_send |
unknown`, written before the send. `unknown` (a throw, crash or no result after the call) counts as contacted and is
never sent again until you release it. `failed_before_send` (never called or denied) is drafted again next batch.

## GET /observer → `ObserverResponse` (s05c)
Runs `offload-observer status --json --home HOME` (5 s timeout) and returns its schemaVersion-1 report as `status`
(`ObserverStatusDTO`: running, paused, days, keysMode, keyFiles, heartbeat, nextPurgeAt, nextExpiry) with the
macOS permissions (`screenRecording`, `accessibility`, `inputMonitoring`; `permissionsSource` heartbeat, probe or
unknown) also at the top level. Always 200: a missing binary, non-zero exit, timeout, non-JSON output or another
schemaVersion gives `available: false`, `status: null` and the reason in `error`.
`keptFiles` (s10b, `KeptFileDTO[]`): files with your content that are kept until you delete them (recipients.csv,
facts.md, crm-log.csv per workflow, tone cards you edited), for the "Observing" section. Everything else holding
observed or mail text is sealed and purged 7 days after its capture day (slices/s10b-review2-brain/SPEC.md).

## Purge and logs (s10b)
`bun run brain/src/cli.ts purge --home DIR [--json]` runs the brain's purge (expired sealed artefacts and keys,
generated tone cards with their corpus, observed names); the app runs it at launch. `serve` runs it before it listens
and hourly. `serve --log-file FILE` writes the brain's log lines there (no content, rotated at 5 MB keeping 2);
without it they go to stderr, scrubbed the same way.

## POST /observer/pause, POST /observer/resume → `ObserverControlResponse` (s09b)
Runs `offload-observer pause|resume --home HOME` (5 s timeout); on exit 0 answers 200 with `{ action, ok: true,
observer }`, where `observer` is a fresh `GET /observer` report. A missing binary, a timeout or a non-zero exit is a
409 `conflict` with the reason (stderr) in `message`. Other methods 405; other actions 404.

## GET /connectors → `ConnectorsResponse`
Servers from `$OFFLOAD_HOME/connectors.json` (`configErrors` when it is invalid), every catalog id with
`connected | missing_env | missing`, and per insight its connectors' status and `ready`. Setup: `brain/CONNECTORS.md`.
s10e: catalog entries carry `simulated: true|false` while the brain runs with the stub model (a demo sign-in, below).

## POST /connectors/:id/link, GET /connectors/:id/link → `ConnectLinkDTO` (s10e)
"Connect Gmail" from the app. POST (body `{}` or `{ "restart": true }`) starts a sign-in for one catalog id, GET polls
it (the app polls every few seconds). `:id` must be a catalog id (`src/connectors/catalog.ts`), else 404 `not_found`;
other methods 405; another body key or a non-boolean `restart` is a 400. Same auth, Host and Origin checks as every
route. Connecting never sends anything.

`ConnectLinkDTO`: `connectorId`, `name`, `via` (`composio` when a Composio/http server in connectors.json lists the id,
`gmail-mcp` when a stdio server does, else from the catalog `how`), `state` (`idle | waiting | connected | failed`),
`url` (the sign-in page to open, or null), `simulated`, `message`, `startedAt`, `connectedAt` (plus `model`).
`message` is plain words for a person, shown as it is ("Finish signing in to Gmail in your browser. Offload checks
every few seconds.", "Gmail is connected.", "The sign-in did not start: Composio did not answer in time.").

- GET before any POST: `idle`, or `connected` when the id already is. POST on a connected id answers `connected` and
  starts nothing. POST while a sign-in is waiting returns it; `restart: true` starts a new one.
- Stub model (`serve --model stub`): a demo sign-in, `simulated: true`. POST → `waiting`, `url` null; GET →
  `connected` once `linkMs` has passed since `startedAt` (default 2000 ms, `OFFLOAD_STUB_LINK_MS` 0..60000). The id is
  then kept in `$OFFLOAD_HOME/connect-sim.json` (0600, `{ "version": 1, "connected": { "<id>": <connectedAt> } }`) and
  counts as connected everywhere: GET /connectors (catalog and insights), workflow connectors, /dashboard needsYou and
  the approve check. Nothing can be sent through it: approving a live batch on a demo sign-in is a 409 `conflict`
  "Demo connection: Offload does not send from a demo sign-in.", auto-run and the run loop leave the batch pending,
  and any send path that still reaches `sendBatch` never starts the executor (its items end `failed_before_send`).
  Activation (approving the dry-run batch) works, because it sends nothing. With the real model the file is ignored
  (one line on stderr at start).
- Real model, `via: composio`: POST runs `composio link <toolkit> --no-browser --no-wait` (toolkit from the catalog
  `how`, `gmail` for Gmail; 30 s timeout) and answers `waiting` with the first https URL it prints (or `failed`). GET
  runs `composio link <toolkit> --list` (15 s timeout, at most every 2 s) and answers `connected` only when the account
  is active AND the catalog status is connected; active but no server lists the id stays `waiting` with "Gmail is
  signed in. Add it to the Composio server Offload uses, then Offload connects it."
- Real model, `via: gmail-mcp`: POST runs the configured stdio server's command and args plus `auth` (default
  `npx -y @gongrzhe/server-gmail-autoauth-mcp auth`) in the background (10 min timeout) and answers `waiting`, `url`
  null; GET answers from the catalog status; an auth command that fails ends `failed`.
- Every command gets only PATH, HOME, USER, LOGNAME, SHELL, TMPDIR and the locale: never `OFFLOAD_TOKEN`, a connector
  secret or a model login. Tests inject a fake runner (`BrainOptions.link.runner`) and never spawn.
