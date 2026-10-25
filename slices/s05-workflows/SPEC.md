---
id: s05-workflows
title: Workflows - tone pack, workflow drafter, dry run, approval gate, Agent SDK runner, dashboard data
depends_on: [s03-brain-core, s04-insights]
parallel_safe: true
human_gated: false
verify: bash slices/s05-workflows/verify.sh
paths_in_scope: [brain/**, slices/s05-workflows/**]
paths_out_of_scope: [engine/**, app/**, plan/**, packet/**, schemas/**, docs/**]
---

# s05-workflows

## Summary
Turns an Insight into a Workflow the user can review, dry-run on last week's real instances and approve. Pipeline
steps 9-12 of `adam/memory/research/10-harness-and-task-mining.md` (tone pack section 4, execution layer section 5).
ADR 0004: Claude Agent SDK + SKILL.md, Gmail MCP first, Composio for the long tail. ADR 0005: the model never produces
a time or saving figure (all numbers here are computed in code; drafts are checked for numbers not in the facts).
ADR 0006: every external action passes an approval gate enforced in code (`canUseTool`), not in a prompt.

All model calls go through the `Model` interface (`src/models/model.ts`). Tests use the deterministic `StubModel` and
never touch the network. Real calls use the Agent SDK (`@anthropic-ai/claude-agent-sdk`, the only runtime dependency).

## Acceptance criteria (each is a test in brain/tests/s05-*)
- AC-0 Idle backdate (`src/sessionize.ts`). The observer stamps `idle_start` when it detects idle, `IDLE_THRESHOLD_MS`
  (120 s, the threshold in docs/store-contract.md and engine `Observer.checkIdle`) after the last input. Sessionize
  moves the stop back by `idleBackdateMs` (default 120 s) and trims any segment that falls inside that window; a
  segment re-opened by `idle_end` and idle again before any input is dropped. `pause` is not backdated. The fixture
  generator writes idle like the observer. s03 tests pin `idleBackdateMs: 0` (raw timestamps).
- AC-0b Wrapped day keys (contract change 1198800, docs/store-contract.md). For a `.jsonl.enc` day whose key file is
  not 32 raw bytes (keychain mode: 64 bytes, "OKW1" + AES-GCM), the reader spawns
  `offload-observer export-day DAY --home DIR` (binary `engine/.build/offload-observer`, or `OFFLOAD_OBSERVER_BIN`)
  and validates its stdout lines. Raw 32-byte keys (`OFFLOAD_KEYS=file` fixtures) are decrypted in-process. A missing
  binary, a non-zero exit or a short export is a day error with every encrypted line marked bad; `OFFLOAD_KEYS=file`
  with a wrapped key is an error, not an export. Tests spawn a fake binary.
- AC-1 Connectors config (`src/connectors/config.ts`), file `$OFFLOAD_HOME/connectors.json`:
  `{ version: 1, servers: { <name>: { type: "stdio", command, args?, envFromEnv? } | { type: "http", url,
  headersFromEnv? }, catalog: [<catalog id>] } }`. Secrets are named by env var only: raw `env` / `headers` keys, env
  var names that are not `[A-Z_][A-Z0-9_]*`, and secret-looking strings (sk-…, long tokens, `Bearer …`) are rejected.
  A catalog id is `connected` when a server lists it and every env var it names is set, `missing_env` when a server
  lists it but an env var is unset, else `missing`. `toMcpServers` resolves env values in memory only.
  `GET /connectors` shows servers, catalog status and, per insight, each connector's status and `ready`.
  Setup guide: `brain/CONNECTORS.md` (Composio MCP via the `composio` CLI, or a Gmail MCP server).
- AC-2 Tone pack (`src/tone/*`). `MailSource` interface with `FixtureMailSource` (40 synthetic sent emails in
  `fixtures/sent-mail.ts`, one voice: short, direct, signs "Muhammad") and `McpMailSource` (calls a read tool on a
  connected MCP server). Clean: drop quoted replies (`>` lines, `On … wrote:`, forwarded headers), signatures after
  `--`, phone/title lines after the sign-off name. Bucket by kind (`investor_outreach | scheduling | follow_up |
  other`) with rules, or the cheap model constrained to that set (invalid answer = rules). Style card per bucket:
  measured section computed in code (length, sentences, greeting, close, asks), voice section written by the cheap
  model. Stored `$OFFLOAD_HOME/tone/<bucket>.md`; a card the user edited (hash differs from `tone/index.json`) is kept
  on rebuild unless forced. BM25 (k1 1.2, b 0.75, no deps) retrieves the 3-5 closest past emails. Blind test: hold
  back N emails (deterministic), build on the rest, draft each held-back one, report proxy metrics and write a shuffled
  A/B file for the human with the answer key in a separate file.
- AC-3 Workflow drafter (`src/workflows/drafter.ts`). For an insight writes `$OFFLOAD_HOME/workflows/<id>/` with
  `SKILL.md` (frontmatter name, description, connectors, gates; steps in plain words), `workflow.json` (typed steps
  `read | draft | approval_gate | send | log`, connector per step, schedule, trigger, `autoRun: false`), `facts.md`
  (editable facts; `--facts FILE` seeds it) and `scripts/` (deterministic parts: pick recipients from a CSV, CRM log).
  Investor outreach: read list → pick next N not yet contacted → draft each in tone (style card + retrieved examples
  + facts) → approval gate (batch review) → send via Gmail → log to the CRM sheet. The drafting prompt lives in
  `src/workflows/prompts/draft-email.md` (big picture first, then rules, no marketing copy).
- AC-4 Dry run (`src/workflows/dryrun.ts`, `POST /workflows/:id/dry-run`). Uses the insight task's real instances
  from the store (recipient and subject parsed from OCR text), newest first, default limit 5. Every side-effect step
  goes through the gate in `dry_run` mode and is denied and logged. Per instance: our draft, the observed OCR excerpt,
  observed minutes, review seconds and minutes saved (code arithmetic).
- AC-5 Approval gate (`src/workflows/gate.ts`). Tools are `read` only when their name has a read verb and no write
  verb; everything else, and every built-in (non-`mcp__`) tool, is a side effect (fail closed). A side effect is
  allowed only in `live` mode, for a `live` batch, when the run holds the approval token stored for that exact batch
  hash (or the workflow's `autoRun` flag is on, default off), the input matches one item of the batch (recipient set
  and body), and that item was not already done by that tool class. Every decision is appended to
  `workflows/<id>/gate-log.jsonl`. The runner (`src/workflows/runner.ts`) passes the gate as `canUseTool` and as a
  `PreToolUse` hook, with built-in tools off and no setting sources.
- AC-6 Models: drafting `claude-opus-5-5`, bucketing and style cards `claude-sonnet-5-5`; overridable by
  `$OFFLOAD_HOME/models.json` `{ draft, cheap }` or `OFFLOAD_MODEL_DRAFT` / `OFFLOAD_MODEL_CHEAP`.
- AC-7 Routes (additive to v1): `POST /workflows/draft {insightId}`, `GET /workflows`, `GET /workflows/:id`,
  `POST /workflows/:id/dry-run {limit?}`, `POST /workflows/:id/run`, `POST /workflows/:id/approve {batchHash}`,
  `POST /workflows/:id/pause`, `POST /workflows/:id/resume`, `DELETE /workflows/:id`, `GET /connectors`, and
  `GET /dashboard` with automations (state `drafting | ready_for_review | active | paused | needs_you`, estimated and
  measured hours saved). Measured = observed hours/week on the task on full days before activation minus full days
  after, from the store; null until both sides have a day. POST bodies are JSON, at most 64 KB.
- AC-8 CLI: `draft --insight N|ins_… --home DIR [--facts FILE]`, `dry-run (--workflow ID | --insight N) --home DIR
  [--limit N] [--model stub|claude]`, `tone build --home DIR [--source fixture|mcp] [--force]`, `tone test --home DIR
  --hold-back N`. Usage errors exit 2.

## Idle note
The idle fix (AC-0) is recorded here and in `brain/API.md` only; docs/store-contract.md is unchanged (it already says
the observer writes `idle_start` after 120 s with no input).

## Out of scope
UI (s08). Learning from user edits (lessons). Propose-Probe-Compose with two drafts. Keychain for connector secrets.

## Verify
`bash slices/s05-workflows/verify.sh`: runs all brain tests (>= 170, 0 failures), requires the gate tests by name,
runs `bunx tsc --noEmit`, then the real CLI end to end on the fixture week with the stub model (tone build, draft,
dry-run) and checks the output. Exits non-zero on any failure.
