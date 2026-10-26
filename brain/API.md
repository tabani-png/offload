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
  `/observer/resume` (s09b); POST on `/connectors/:id/link` (s10e); POST on `/computer/stop` (s13). Bodies are `application/json`,
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
frame's capture day (purged with it). Readers: `vision/notes.ts readFrameNotes(home, day)`. Images are masked by the
engine first; with `ollama`/`stub` they stay on the Mac. No route serves images or frame notes.
s14 adds `--captioner claude|auto` and `--claude-vision-model claude-haiku-5-5|claude-sonnet-5-5|claude-opus-5-5`:
`claude` reads each masked frame with Claude on the user's own Anthropic account (only https://api.anthropic.com,
structured output against the frame-note schema, stop_reason checked, a refused frame skipped at once), falling back
to the local model when the router's budget says so or the account does not work; `auto` tries
`AUTO_CAPTIONERS` in order (Claude when a key is configured, then a healthy Ollama), else captions are off and
`captioner.needsYou` says what is missing. The default stays `off` for the bare CLI; the app passes `auto`.
`captioner` in GET /status gains `usage {frames, inputTokens, outputTokens, lastFrame, refusals, costUsd}` and
`needsYou`.

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

### Understanding v2 (s12, behind a flag; ADR 0007)
`serve` and `analyze` take `--understanding v1|v2` (default `v1` until s15 flips it). v1 is unchanged byte for byte.
v2 finds repeated work in any field instead of keying tasks on app/host rules:
1. Every span gets an internal description (`brain/src/understanding/describe.ts`): activity, verb, object,
   counterpart, surface, step, identifiers. Frame notes (`schemas/frame-note.schema.json`, events of kind `frame`
   from s11; until then a fixture sidecar `frames/<day>.jsonl[.enc]` encrypted with the day key) win by
   confidence-weighted vote; without frames it is composed from focus, title, URL, input counts and OCR.
2. The masked description text (no identifiers, no counterpart) is embedded locally: `--embedder stub` (default,
   deterministic, offline) or `--embedder ollama` (127.0.0.1:11434 only, `--embed-model qwen3-embedding:0.6b|bge-m3`).
   A failing Ollama call is an error, never a silent fallback.
3. Task induction (`induce.ts`, Task Model Induction style): step clusters by embedding + surface + verb/object with a
   daily global merge; steps link into one task by shared item identifiers (an invoice number, a ticket id, a file)
   or a reliable step-to-step transition; instances split on a new day, a gap over 10 min, a different item on a
   screen already in the instance, or the start step coming round again (loop model).
4. Tasks keep the v1 `Task`/`TaskProfile` shape, so figures, saving arithmetic, ranking and evidence are the same code
   (ADR 0005). `category` and `app`/`template` describe the step with the most time and are features only.
   `kind` is `task.<verb>-<object>` (mail-only tasks keep v1's `email.*` kinds), `reachability` is the domain-neutral
   reach: per surface a catalog connector, a local document (0.8) or computer use as last resort (0.35),
   active-time-weighted.
5. `--role R --industry I` (or `AnalyzeOptions.userContext`, from onboarding in s14) reach the Labeler (second
   argument) and Judge (`input.user`) and the prompt builders (`understanding/context.ts`) as context only.

Additive field on `InsightDTO` (v2 only): `understanding` = `{ goal, steps[{id, name, verb, object, surface, app, host,
perInstance, repeatsPerInstance, core}], loop[stepId], surfaces[{app, appName, host, minutes}],
reach{value, perSurface[{app, host, via: catalog|local_file|computer_use, connectorId, reach}]},
identifiers{items, containers[]} }`. v1 responses never carry it.
Known-answer fixtures: `bun run brain/fixtures/gen-domains.ts --out DIR [--persona recruiter|bookkeeper|support|salesops|mixed|all]`;
agreement report: `bun run brain/fixtures/domains-report.ts [--embedder ollama]`.

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
s13: `chains: ConnectorChainDTO[]`, one per catalog id plus one per app the insights touch that the catalog does not
know (`app-<slug>`, `web-<slug>`). Stub model: probed (deterministic demo probes). Real model: from the cache, expired
ones re-probed in the background; `GET /connectors?refresh=1` probes now. With the real model, a catalog id that an
unexpired chain decision can commit through (e.g. the Composio CLI with no Composio server) counts as `connected`.

## The connector chain (s13) → `ConnectorChainDTO`
How Offload reaches one app (brain/CONNECTORS.md "Resolution chain"): `targetId`, `name`, `catalog`, `method` (the
first healthy method that offers what the app is used for, or null), `health` (`ok | failed | skipped`),
`capabilities { reads, writes }` of that method (canonical names such as `mail.search`, `mail.send`, `sheet.append`,
`screen.read`, `ui.commit`), `lastError` (the last run failure, scrubbed), `next` (the method used if this one fails),
`decidedAt`, `expiresAt` (re-checked after it, 10 min when something works, 2 min when nothing does), `simulated`, and
`methods[]`: `ChainMethodDTO { method, health, code, reason, reads, writes, tools, lastError, checkedAt, latencyMs }`.
`code` is machine-readable (`ok`, `no_server`, `missing_env`, `timeout`, `no_allowlisted_tools`, `composio_missing`,
`no_toolkit`, `not_signed_in`, `reads_only`, `asks_every_call`, `no_api`, `no_health_check`, `no_secret`, `refused`,
`down`, `computer_off`, `no_permission`, `app_missing`, `run_failed`, `probe_error`, `stub_failed`); `reason` is plain
words for a person (null when ok); `tools` maps a capability to the tool the gate sees
(`mcp__gmail__send_email`, `mcp__composio_cli__GMAIL_SEND_EMAIL`, `mcp__api_gmail__users.messages.send`,
`mcp__computer_gmail__commit`). No secret, server credential or Composio account id is ever in it.

## POST /connectors/:id/link, GET /connectors/:id/link → `ConnectLinkDTO` (s10e)
"Connect Gmail" from the app. POST (body `{}` or `{ "restart": true }`) starts a sign-in for one catalog id, GET polls
it (the app polls every few seconds). `:id` must be a catalog id (`src/connectors/catalog.ts`), else 404 `not_found`;
other methods 405; another body key or a non-boolean `restart` is a 400. Same auth, Host and Origin checks as every
route. Connecting never sends anything.

`ConnectLinkDTO`: `connectorId`, `name`, `method`, `methods`, `next`, `detail` (below), `via` (kept for compatibility:
`gmail-mcp` when `method` is mcp, `composio` otherwise), `state` (`idle | waiting | connected | failed`),
`url` (the sign-in page to open, or null), `simulated`, `message`, `startedAt`, `connectedAt` (plus `model`).
`message` is plain words for a person, shown as it is ("Finish signing in to Gmail in your browser. Offload checks
every few seconds.", "Gmail is connected.", "The sign-in did not start: Composio did not answer in time.").

- Methods (connecting is generic, not Gmail-specific): `method` is one of `mcp` (a connector on this Mac),
  `composio`, `api`, `computer`. `methods` is the ordered list the connector can use, from `resolutionMethods()` in
  `src/connectors/link.ts`: gmail `["mcp", "composio"]` (`composio` first when only a Composio http server lists it),
  Composio-catalog ids `["composio"]` or `["composio", "mcp"]` when a stdio server lists them, then always `"api",
  "computer"`. The first is the default. POST takes `{}`, `{ "restart": true }` or `{ "method": M, "restart"? }`;
  another method while one waits starts the new one. `api` and `computer` are declared seams: they answer `failed`
  with `detail` "That way of connecting is not available yet."; a method the connector cannot use fails with "That
  way of connecting does not work for Slack yet." `next` is the method to offer after a failure (the next available
  one in `methods`, wrapping; never a seam), else null. `detail` is plain words like `message` (what the method is, or
  why it failed). Methods live in a registry (`LinkMethod` with start/poll, `registerLinkMethod`); a later slice adds
  the fallback chain and computer use by registering, not by editing the route.
- `GET /connectors/:id/status` returns the same DTO as `GET /connectors/:id/link` (the generic name; GET and HEAD
  only, other methods 405).
- s13: every link / status answer carries `chain: ConnectorChainDTO` (above). Stub: probed. Real: `/status` probes when
  the cached decision expired (`?refresh=1` now); `/link` answers from the cache, so a sign-in poll never starts a
  probe. `:id` may also be an app target id (`app-…`, `web-…`) once `GET /connectors` has seen it in an insight (kept
  7 days from when it was last seen); its methods are `composio, api, computer`.
- s13: `api` and `computer` are real ways of connecting now. Both answer at once from the chain's probe: `connected`,
  or `failed` with the reason in `detail` ("No direct connection is set up for Gmail.", "Using apps on your screen is
  off until you turn it on."). `next` only names a way that can work for that connector right now (api only when
  connectors.json `apis` lists it, computer only when computer use is on); with the stub model those two are demo
  sign-ins when usable. After a Composio sign-in (real model) the id counts as connected once a fresh probe can commit
  through the Composio CLI, also without a Composio server in connectors.json.
- GET before any POST: `idle`, or `connected` when the id already is. POST on a connected id answers `connected` and
  starts nothing. POST while a sign-in is waiting returns it; `restart: true` starts a new one.
- Stub model (`serve --model stub`): a demo sign-in, `simulated: true`. POST → `waiting`, `url` null; GET →
  `connected` once `linkMs` has passed since `startedAt` (default 2000 ms, `OFFLOAD_STUB_LINK_MS` 0..60000). The id is
  then kept in `$OFFLOAD_HOME/connect-sim.json` (0600, `{ "version": 1, "connected": { "<id>": <connectedAt> } }`) and
  counts as connected everywhere (every available method simulates the same way; `OFFLOAD_STUB_LINK_FAIL`, a comma
  list such as `mcp`, makes those methods end `failed`, e.g. mcp: detail "The connector on this Mac did not answer.",
  next `composio`): GET /connectors (catalog and insights), workflow connectors, /dashboard needsYou and
  the approve check. Nothing can be sent through it: approving a live batch on a demo sign-in is a 409 `conflict`
  "Demo connection: Offload does not send from a demo sign-in.", auto-run and the run loop leave the batch pending,
  and any send path that still reaches `sendBatch` never starts the executor (its items end `failed_before_send`).
  Activation (approving the dry-run batch) works, because it sends nothing. With the real model the file is ignored
  (one line on stderr at start).
- Real model, method `composio`: POST runs `composio link <toolkit> --no-browser --no-wait` (toolkit from the catalog
  `how`, `gmail` for Gmail; 30 s timeout) and answers `waiting` with the first https URL it prints (or `failed`). GET
  runs `composio link <toolkit> --list` (15 s timeout, at most every 2 s) and answers `connected` only when the account
  is active AND the catalog status is connected; active but no server lists the id stays `waiting` with "Gmail is
  signed in. Add it to the Composio server Offload uses, then Offload connects it."
- Real model, method `mcp`: POST runs the configured stdio server's command and args plus `auth` (for Gmail without
  one, `npx -y @gongrzhe/server-gmail-autoauth-mcp auth`) in the background (10 min timeout) and answers `waiting`, `url`
  null; GET answers from the catalog status; an auth command that fails ends `failed`.
- Every command gets only PATH, HOME, USER, LOGNAME, SHELL, TMPDIR and the locale: never `OFFLOAD_TOKEN`, a connector
  secret or a model login. Tests inject a fake runner (`BrainOptions.link.runner`) and never spawn.

## POST /computer/stop, GET /computer/session → `ComputerSessionDTO` (s13)
Computer use (the last resort of the chain, off until turned on) drives one app at a time. `POST /computer/stop` is the
kill switch (the app maps Esc and a menu item to it): the run stops before its next action; it answers
`{ stopped, session }` (`stopped` false when nothing was running). Pausing or deleting the workflow, or moving the
pointer yourself, stops it the same way. `GET /computer/session`: `{ running, workflowId, targetId, pointer, stopped,
stopReason }`; `pointer` is the last pointer event `{ x, y, label, action, at }` (screen points, the control's
Accessibility title) for a Clicky-style overlay glyph. Other methods 405. Every action of a run passed the gate first
(brain/CONNECTORS.md "The gate for every method").

## GET /catalog/capabilities, GET /catalog/capabilities/:id → `CapabilitiesResponse`, `CapabilityDTO` (s13)
Read-only data for the workflow builder: what a workflow can use for a capability, not only the app the person used
(`src/connectors/capabilities.ts`). Capabilities: `send-outreach-sequence`, `send-email`, `enrich-contact`,
`log-to-crm`, `create-bill`, `update-ats-stage`, `reply-ticket`, `write-sheet-row`, `post-message`,
`schedule-meeting`. Each `CapabilityDTO { id, name, description, checkedAt, candidates[] }` lists candidates in the
order Offload recommends them (for outreach: Instantly, Smartlead and Apollo before sending one by one from Gmail).
`CapabilityToolDTO`: `toolId`, `name`, `why`, `cost`, `mcp { status: CONFIRMED | UNKNOWN, url, kind, checkedAt,
evidence }` (the vendor's own MCP server; community servers do not count), `composio { toolkit, status, tools,
checkedAt }` (listed read-only with the Composio CLI), `apiDocs`, `catalogId`, `reads[] { slug, gateTool }` and
`commits[] { slug, verb: send | launch | create | update | delete, gateTool, allowedByGate }`. `gateTool` is the name the
gate sees (`mcp__composio_cli__<SLUG>`); `allowedByGate` is false until the allowlist has that tool's argument schema
(today only `GMAIL_SEND_EMAIL` and the sheet append): the catalog recommends, the gate allows. Unknown id 404; GET only.


## s14: general workflows, context and the model router (additive)
- `GET /context` -> `{version, context: {role?, industry?}, updatedAt, suggestions: {roles, industries}}`.
  `PUT /context {role?, industry?}`: each a one-line string of at most 80 characters, or null / "" to clear; other keys
  400. Stored in `$OFFLOAD_HOME/user-context.json` (0600). Context only: it reaches label, design and step prompts
  inside `<user_context>` and changes no number.
- `POST /workflows/draft {insightId}`: for any insight that is not an s05 email template (`email.outreach`,
  `email.scheduling`) the brain builds a general plan: workflow.json `plan` (`WorkflowPlanDTO`, api/s14-types.ts) with
  typed steps read / transform / decide / draft / commit, two variants probed on last week's instances, the chosen
  one, the probe arithmetic, and capability needs per step (`{need, target, targetName, capability, role, via}`, target
  = catalog id or `app-<slug>` / `web-<slug>`). The legacy `steps` follow the chosen variant, with the approval step
  before the first commit. The detail gains `plan` and `tools`.
- `POST /workflows/:id/plan {variant: "a"|"b"}` keeps the other variant (detail back; the dry run must be re-run).
- `tools` (both plan and template workflows): per step that needs an outside tool, 1-3 options for its capability
  family (`email.send_bulk`, `enrich.person`, `crm.log`, `sheet.update`, `ticket.reply`, `accounting.bill`,
  `ats.stage`, `order.lookup`, `doc.read`, `chat.message`), each `{id, name, via, why, setup, cost, connected,
  connectorId}`, plus `chosen`, `chosenBy`, `runsWith` and a one-line `suggestion`. Default: a connected option that
  is good enough for the daily volume, else the first. `POST /workflows/:id/tools {stepId, toolId}` records a pick.
- `POST /workflows/:id/dry-run` on a plan workflow adds `general` (`GeneralDryRunDTO`): per instance `ours` vs
  `theirs` (`{kind, summary, fields[{label, value|null}], text, actions}`), a match figure with arithmetic, the steps,
  evidence ids, the time estimate and the `commit` the chain would make: `{tool, verb, fields: [label, value][],
  missing}` in the labelled form of the chosen tool's s16 schema (brain/CONNECTORS.md "Commit schemas (s16)"). Values are copied by code; text steps are
  drafted from masked text. `tools` lists the chosen tool per step. `instances` stays `[]` for plan workflows.
- `GET /status` gains `understanding {version, embedder, framesRead}` and `models` (router summary: backend, metered,
  month, spentUsd, budgetUsd, captionsLocal, blocked, needsYou, routes). `GET /models/usage`: the month's ledger per
  route and model, prices, the last 100 routing decisions (route, tiers tried, escalation reasons, tokens, cost).
- CLI: `draft` and `dry-run` take `--understanding v1|v2` (and the embedder flags); `draft` of a general insight uses
  the stub design model unless `--model real` is given.

## Solutions (s22): the best kind of fix per task (additive)
For every insight, and every task the judge holds back because a person is at the keyboard (e.g. watching a coding
agent), the brain ranks five kinds of fix (`brain/src/solutions/`):
`workflow` (automate it: the existing drafter, MCP -> Composio -> API -> computer use), `tool` (build a custom tool or
script), `setup` (change the setup: IDE, coding-agent rules and permissions, shortcuts, templates), `remove_step`
(replace a manual sub-process with a pipeline, e.g. post images generated from the post text), `leave_alone`.
Numbers are code (ADR 0005): observed h/wk = `activeMinutes` / 60 × 7 / window days; each option saves
min(observed, observed × share × factor) (workflow: min(observed, the s04 estimate) × share), never more than
observed; confidence = fit × (0.6 + 0.4 × min(1, √(instances/8))); rank = saving × confidence (ties: fewer setup
hours), `leave_alone` first when nothing clears 0.5 h/wk × confidence or the task is one-off reading. Opus 5.5 (role
`solution_design`, router route `design`) may reword only `what`, `why` and the brief text; a reply that changes a
kind, the order, a figure or holds a digit is ignored (`designedBy: "rules"`).

- `GET /insights` gains `solutions` on each insight (`{top, observedWeeklyHours, options[{kind, what,
  weeklyHoursSaved, effort, confidence}]}`, rules only, no model call) and a top-level `heldBack[]` (`{id, taskId,
  kind, name, description, category, reason, activeMinutes, instances, solutions}`). Every existing key is unchanged.
- `GET /insights/:id/solutions` -> `SolutionSet` (`solutions/types.ts`): `{version, subjectId, taskId, name, heldBack,
  observedWeeklyHours, observedArithmetic, parts[{id, name, activeMs, spanIds, tags}], options[], top, designedBy}`;
  each option `{kind, what, why, weeklyHoursSaved, share, arithmetic, effort{level, setupHours, paybackWeeks},
  confidence{value, level, reasons}, evidence{spanIds, instanceIds, parts}, handoff}`; `handoff` is
  `{to: "workflow_drafter", insightId}`, `{to: "brief", spec{inputs, outputs, runsWhere, builderPrompt, acceptance}}`
  or `{to: "none"}`. `:id` is an `ins_…` id of an insight or a held-back task.
- `POST /insights/:id/solutions/choose {kind}`: `workflow` -> `{kind, workflow: WorkflowDetailDTO}`, exactly what
  `POST /workflows/draft` makes (201 new, 200 existing); `tool` / `setup` / `remove_step` -> `{kind, brief}` (201
  new), a draft in `$OFFLOAD_HOME/solutions/<sol_id>/{brief.json, BRIEF.md}` (0600). `leave_alone` or an option that
  is not a fit -> 409.
- `GET /solutions/:id` -> the brief (`status` draft | approved | handed_off, `hash` = sha256 of its canonical content).
  `POST /solutions/:id/approve {briefHash}` -> `{brief, token}`: only the exact current hash of a draft (409
  otherwise, also when the file changed on disk); the token is single use and only its sha256 is stored.
  `POST /solutions/:id/handoff {token}` -> `{brief, builderPrompt, briefMd}` once (403 wrong token, 409 reused or not
  approved). Nothing is executed: a brief is text for a builder (e.g. a Claude Code session).
- CLI: `solutions (--insight N|ins_ID | --held N) --home DIR [--choose KIND] [--json] [--model stub|real]` (stub design
  model unless `--model` is given, like `draft`); `solutions approve --brief sol_ID --hash H --home DIR`;
  `solutions handoff --brief sol_ID --token T --home DIR`. `analyze --json` carries the same additive fields.

## Builds (s24): build a brief until its frozen checks pass (dry run, additive)
A tool / setup / remove_step brief is built by the brief runner (`src/builder/`). Outcome-based: done means the
check script exits 0, never "the model says done".
- `POST /solutions/:id/checks` (no body) -> 201 `{set: CheckSet, content, buildMd}`. A separate model call (role
  `build_checks`, router route `draft`, Sonnet) turns the brief's `acceptance` lines into ONE check script
  (`accept.py` or `accept.test.ts`), stored at `solutions/<id>/checks/` with its sha256 and shown in
  `solutions/<id>/BUILD.md`. `CheckSet = {version, briefId, briefHash, file, sha256, model, createdAt}`.
- `POST /solutions/:id/build/approve {briefHash, checkHash}` -> `{briefHash, checkHash, token}` (token shown once,
  single use). 409 when either hash is not the current one or a file changed; same rules as the s05 / s22 gates.
- `POST /solutions/:id/build {token}` -> 201 `RunRecord` (403 no / wrong approval or bypass outside a container,
  409 token used or check changed after approval). Fresh workspace `builds/<run_id>/workspace`; each try is one Agent
  SDK `query()` (tools Read, Write, Edit, Glob, Grep, Bash with a command allowlist; no network tools; cwd locked;
  `accept/` read-only); the runner checks the script's sha256 and runs it; a failure's exact output feeds the next
  try. Caps: 3 tries, $1, 30 turns per try, 10 min. DRY RUN: files stay in the workspace (`artifactPath`);
  installing them is a separate approval, not offered here.
- `GET /builds/:runId` -> `RunRecord`: `{version, id, briefId, briefHash, checkHash, checkFile, dryRun: true,
  models {checkWriter, builder, reported[]}, versions {sdk, claudeCode}, profile {mode, containerSandbox, sandbox, tools,
  disallowedTools, bashAllow, limits}, tries[{n, result, turns, costUsd, tokens, checkExit, checkOutput (last 4k),
  checkHashOk, ms}], totals {costUsd, tokens, turns}, startedAt, wallMs, outcome: PASS|FAIL|CAP|TAMPER, reason,
  artifactPath, denials[]}`. Records are written once (`builds/<run_id>.json`) plus a line in `builds/runs.jsonl`.
- `GET /insights/:id/solutions`: each built brief option gains, additively, `build {runId, outcome, costUsd, tries,
  totalCostUsd}` (hours saved vs cost).
- CLI: `build --solution N|ins_ID|held:N --option n --home DIR [--model stub|real] [--json]` (brief + checks, prints both
  hashes); `build approve --brief sol_ID --brief-hash H --check-hash C --home DIR`; `build run --brief sol_ID --token T
  --home DIR [--max-tries N] [--max-usd X]` (exit 0 only on PASS); `build record --run run_ID --home DIR`.
- Env: `OFFLOAD_BUILDER_SANDBOX=container` allows bypass mode (inside a throwaway container only). Claude Code
  subprocesses get `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`.
- Isolation: builder Bash commands and the acceptance check run under an OS sandbox (macOS `sandbox-exec`,
  deny-default: workspace read-write, `accept/` and the frozen check copy at `builds/<run>/frozen/` read-only,
  toolchain read-only, no network) via `env -i` with only PATH, HOME=workspace, LANG, TMPDIR=workspace/.tmp. The
  frozen check is hashed before and after every run. No usable sandbox and no container profile = 403 / exit 2
  before the approval is used (fail closed). Check output is secret-redacted before it is stored or re-prompted.
  Limits must be finite and positive (whole numbers for tries); bad values are refused (400 / exit 2) before the
  token is consumed.

## Company sync (S2-02, ADR 0103)
The brain's sync client (`src/sync/`) connects this Mac to the company control plane (`OFFLOAD_CONTROL_URL`, https;
http only on 127.0.0.1). It can emit only the seven sync objects of `schemas/stage2` (`notice_ack`, `run_outcome`,
`review_event`, `baseline_sample`, `daily_aggregate`, `working_time_aggregate`, `workflow_proposal`), each validated
against its schema before it is queued. Raw activity has no code path to the network: the collector
(`sync/collect.ts`) turns brain state into numbers, ids, hashes and evidence refs, and the projectors
(`sync/project/*`) never see events, spans, OCR, frame notes, recipients, subjects or bodies. Without
`OFFLOAD_CONTROL_URL`, or before "Connect", nothing is sent and no request is made.
- Keys: `device-signing` (P-256 private scalar, ES256) and `device-evidence` (HMAC key) are brain keys wrapped by the
  observer (`offload-observer wrap-key --name device-signing|device-evidence`; raw files under `OFFLOAD_KEYS=file`).
  `DeviceSigner` is the seam for a Secure Enclave key. `instanceRef = hex(HMAC-SHA256(deviceEvidenceKey,
  localInstanceId))[0:32]`; the ref -> instance map is sealed per capture day and resolves only on this Mac, 7 days.
- Consent (checked here before anything but the notice ack is sent; the server re-checks): unknown config = only
  `notice_ack`; no required notice in the config = only `notice_ack` too (fail closed, ADR 0111 §3); G1 nothing else
  until the required notice version is acknowledged on this Mac. Consent is forward-only: nothing observed before that
  acknowledgement time leaves the Mac (runs that started earlier, their reviews, instances that started earlier, daily
  rows of days that ended earlier, active spans that started earlier; the acknowledgement day counts only what came
  after it); G2 working time only
  when `working_time` is on, an acknowledged notice lists it and `now >= workingTimeStartsAt` (and never for days
  before that), turned off = queued working-time objects are dropped; G3 daily aggregates always once acknowledged;
  G4 a proposal only after `?confirm=1` on its preview; G5 pause holds everything. A kill switch holds everything but
  acks. Kinds outside `allowedKinds` are held.
- Outbox: `$OFFLOAD_HOME/sync/outbox/DAY.json.enc`, sealed with the brain day key of the day queued (no plaintext);
  purged after 7 days with a purge-log line `{day, deletedAt, events: 0, files, by: "sync-outbox"}` (expired ref maps:
  `by: "sync-refs"`). State (ids, seq,
  flags, acks, bindings; no secrets) in `sync/state.json`; measured review seconds in `sync/reviews.json`.
- Envelopes: RFC 8785 JCS body `{v: 1, deviceId, seq, sentAt, objects}` (<= 500 objects, <= 1 MiB), signed ES256 in
  `Offload-Signature: keyid=<deviceId>, sig=<b64url>`; `seq` is written before the request and strictly increases
  across restarts. Notice acks go first. Flush every `flushSeconds` (default 15 min) and after each run; network, 429
  and 5xx back off 15 min, 30 min, ... up to 6 h (at least `Retry-After`). Receipt: accepted and `duplicate` leave the
  outbox, `rate_limited` / `server_error` are retried after a backoff, everything else is dropped and logged.
- Device tokens: challenge -> ES256 over the nonce -> 15-minute token in memory, refreshed in its last minute. A
  401/403 from the token endpoints marks the device revoked: sync stops until it is connected again (new device id).
- A `run_outcome`'s object id is derived from its `runId` only (ADR 0111 §4): when the run changes (partial, then the
  rest sent), the new form is queued again under the same id and goes in a later envelope (higher `seq`).
- Only workflows bound to a company workflow (`SyncClient.bind`, a role workflow or a promoted proposal) produce run
  outcomes, review events, baselines and per-workflow daily rows.

Routes (bearer token as everywhere):
- `GET /sync/status` -> `SyncStatusDTO {state: not_configured|not_connected|connecting|connected|paused|revoked,
  controlUrl, configError, deviceId, personId, tenantId, enrolledAt, paused, seq, notice {required, acknowledged} |
  null, features | null, outbox {total, byKind}, boundWorkflows, lastFlushAt, nextFlushAt, failures, lastError}`.
- `POST /sync/connect` -> 202 `{state: "waiting", authorizeUrl}`: PKCE (S256) + a loopback listener on 127.0.0.1;
  opens `GET {control}/auth/login?client=offload-mac&redirect_uri=http://127.0.0.1:PORT/callback&state=&code_challenge=
  &code_challenge_method=S256` in the browser; the redirect brings the enrollment code, then `POST /v1/devices/enroll`
  with the public JWK (code_verifier in the `Offload-Code-Verifier` header). 409 when already connected or not
  configured.
- `POST /sync/pause`, `POST /sync/resume` -> `SyncStatusDTO`.
- `GET /sync/preview` -> `{envelope | null, body | null, held, queued}`: the exact next envelope (and its JCS text)
  the next flush sends at the same moment; it sends nothing. 409 before connect.
- `POST /sync/notice/ack {noticeVersionId}` -> 201 `{ack}` (a `notice_ack`, channel `mac_app`); 409 unless it names
  the notice the config requires.
- `POST /workflows/:id/share` -> `{confirmed: false, proposal}` (the exact `workflow_proposal` JSON, facts values and
  recipient-list cells redacted, contacts masked: addresses, links, phone numbers and any dotted host name, whatever its
  top-level domain); `?confirm=1&hash=<definitionHash>` -> 201 `{confirmed: true, proposal}` and queues it. The hash is
  required (400 without it): the confirm queues exactly what was previewed (409 when it no longer matches). 404 unknown
  workflow.

## Connections (s17)
Any app Composio supports (brain/CONNECTORS.md "Connect anything (s17)"). Nothing here sends: setup and test only
read; build ends in a dry run. Types: `ConnectionRowDTO`, `ConnectionsResponse`, `ConnectionDetailDTO`,
`ConnectionTestDTO`, `ConnectionBuildDTO`, `UniverseStatusDTO` in `src/api/types.ts`.
- `GET /connections?q=&limit=` -> `ConnectionsResponse { query, connections[], universe, note }`. Rows `{ id, name,
  toolkit, description, status: connected | needs_you | not_set_up, statusLine, verified, tools { read, commit,
  denied }, method }`. `id` is the catalog id when Offload maps the app, else `tk-<toolkit>`. Without `q`: the catalog
  first, then apps that are set up, then Composio's own order; with `q` (at most 80 characters, else 400): name and
  slug matches before description words. `limit` 1..300 (default 60). `note` says when the Composio list is not loaded.
- `GET /connections/universe` -> `UniverseStatusDTO { syncedAt, stale, complete, toolkits, tools, classes,
  cliVersion }`. `POST /connections/universe/refresh` -> the same plus `started` (real model only; the demo answers
  `started: false` and runs nothing).
- `GET /connections/:id` -> `ConnectionDetailDTO`: the row plus `methods[] { method: composio | api_key | mcp, title,
  detail, steps[], recommended }` (`api_key` when Composio lists key sign-in for the app, or when it is not known),
  `sample { read[], commit[] }`, `setup { method, startedAt, secretRef, server, test }`, `keychain { service, account }`
  (where the app saves the key) and `canBuild`. Unknown id 404.
- `POST /connections/:id/setup`: `{ "method": "composio" }` answers the s10e `ConnectLinkDTO` (poll
  `GET /connectors/:id/status`); `{ "method": "api_key", "secret": { "keychain": { "service":
  "offload.connection.<id>", "account": "api-key" } } | { "fromEnv": "NAME" }, "baseUrl"?, "healthPath"?, "header"? }`;
  `{ "method": "mcp", "url": "https://...", "headers"?: { name: reference } }` or `{ "method": "mcp", "command",
  "args"?, "env"?: { NAME: reference } }` (tested right away). Answers the detail. 400 for anything that carries a
  secret value, another Keychain item, plain http (except 127.0.0.1) or an unknown field; the message never echoes it.
- `POST /connections/:id/test` -> `ConnectionTestDTO { ok, detail, tools, testedAt }` (read-only; the demo reads and
  starts nothing).
- `POST /connections/:id/build {insightId?}` -> `ConnectionBuildDTO { workflow, dryRun { instances, commitTool,
  missing, sent: 0, warnings } }`: drafts the workflow for the given insight (or the top one whose task happens in
  that app; else 409 "Offload has not seen you work in Linear yet..."), records the connection as the person's pick for
  the step it fits (a universe tool is added to the commit step when no option is that app), fetches a universe tool's
  schema read-only, and runs the dry run. A universe tool's dry-run `commit` is `{ tool: "composio:<SLUG>", verb, fields,
  missing, review { rows[{ path, label, value, highlight, required, description }], warning } }`.
- The s10e link routes accept `tk-<toolkit>` ids (methods composio, api, computer).
