# Brain local API (v1)

TypeScript types: `brain/src/api/types.ts` (the source of truth; this page explains them). `API_VERSION = 1`.
Changes inside v1 are additive only.

## Connection
- Base URL `http://127.0.0.1:<port>/`. The listener binds 127.0.0.1 only.
- Start: `bun run brain/src/cli.ts serve --home "$OFFLOAD_HOME" [--port P]`. It prints `brain listening on <url>`.
- Auth: every request needs `Authorization: Bearer <token>`. The token is `OFFLOAD_TOKEN` (at least 32 chars) or, when
  unset, a fresh 256-bit token printed once as `OFFLOAD_TOKEN=<token>`. The app passes its per-launch token in the env.
- Host must be `127.0.0.1` or `localhost` (any port). An `Origin` header, if sent, must equal `http://<host>`.
- GET (and HEAD) everywhere; POST and DELETE only on `/workflows…` (s05). POST bodies are `application/json`,
  at most 64 KB. No CORS. Every response is `cache-control: no-store`, `x-content-type-options: nosniff`.

| status | body `error` | when |
|---|---|---|
| 400 | `bad_request` | malformed `day` or `reviewSeconds`, bad JSON body or field |
| 401 | `unauthorized` | missing or wrong bearer token |
| 403 | `forbidden` | foreign Host or Origin |
| 404 | `not_found` | unknown path, insight id, workflow id, batch hash, or a day not in the store |
| 405 | `method_not_allowed` | a method the path does not take, OPTIONS preflight |
| 409 | `conflict` | not allowed in the current state (run before activation, paused, batch not pending, connector missing) |
| 413 | `payload_too_large` | body over 64 KB |
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

## Workflows (s05)
A workflow is a folder `$OFFLOAD_HOME/workflows/<id>/`: `SKILL.md`, `workflow.json`, `facts.md` (the only facts drafts
may state), `recipients.csv`, `crm-log.csv`, `scripts/`, `batches/<hash>.json` (live) or `<hash>.json.enc` (dry run,
sealed), `approvals.json`, `gate-log.jsonl`, `dry-run.json.enc`, `dry-runs/<ts>.json.enc`. Files holding OCR or mail
text (dry runs, dry-run batches, `tone/corpus.jsonl.enc`, blind-test pairs) are sealed with a per-day brain key in
`$OFFLOAD_HOME/brain-keys/` and purged after 7 local days, at `serve` startup and hourly, with a
`purge-log.jsonl` line `{day, deletedAt, events: 0, files, by: "brain"}` (s05b). Days older than 7 local days are
never read, even when their files exist; the brain asks `offload-observer purge-now` to delete them.
States: `drafting` → `ready_for_review` → (approve the dry-run batch) → `active` ⇄ `paused`; `needs_you` is shown on
top of `active` when a batch waits or a connector is missing. Auto-run is off by default.

| route | body | returns |
|---|---|---|
| `POST /workflows/draft` | `{ insightId }` | `WorkflowDetailDTO` (201 new, 200 existing) |
| `GET /workflows` | | `WorkflowsResponse` |
| `GET /workflows/:id` | | `WorkflowDetailDTO` (steps, SKILL.md, facts, batches, `pendingItems` for review) |
| `POST /workflows/:id/dry-run` | `{ limit? 1..50 }` | `DryRunResponse` |
| `POST /workflows/:id/run` | | `RunResponse` (201): the next live batch, pending your review (409 until active) |
| `POST /workflows/:id/approve` | `{ batchHash }` | `ApproveResponse`: dry-run hash → `activated`; live hash → `sending` |
| `POST /workflows/:id/pause` / `resume` | | `WorkflowSummaryDTO`. Pause also stops a running batch before its next item |
| `POST /workflows/:id/release` | `{ batchHash, keys[] }` | `{ batch }`: you confirm these `unknown` sends did not go out; they can be drafted again (s05b) |
| `POST /workflows/:id/auto-run` | `{ enabled }` | `WorkflowSummaryDTO` |
| `DELETE /workflows/:id` | | `{ deleted }`. Stops a running batch first |

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

## GET /connectors → `ConnectorsResponse`
Servers from `$OFFLOAD_HOME/connectors.json` (`configErrors` when it is invalid), every catalog id with
`connected | missing_env | missing`, and per insight its connectors' status and `ready`. Setup: `brain/CONNECTORS.md`.
