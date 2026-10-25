---
id: s05b-gate-hardening
title: Gate hardening - allowlist gate, idempotent single-flight runner, sealed and purged artefacts (REVIEW-1)
depends_on: [s05-workflows, s10-review]
parallel_safe: true
human_gated: false
verify: bash slices/s05b-gate-hardening/verify.sh
paths_in_scope: [brain/**, slices/s05b-gate-hardening/**]
paths_out_of_scope: [engine/**, app/**, plan/**, packet/**, schemas/**, docs/**]
---

# s05b-gate-hardening

## Summary
Fixes every CONFIRMED BLOCKER, HIGH, MEDIUM and LOW finding of `slices/s10-review/REVIEW-1.md`. Each finding has a
test in `brain/tests/s05b-*` whose name starts with the finding id (`B1: ...`, `H2: ...`); verify.sh checks that.
The tests were written first and failed (missing modules and assertions) before the code below existed.

## Design changes
1. **The gate is an allowlist** (`src/workflows/allowlist.ts`, `gate.ts`). Per connector and server flavour there is
   exactly one canonical send tool and at most one canonical CRM log tool, each with a declared argument schema, plus
   an explicit list of read tools. The gate canonicalises the FULL argument object (sorted keys, unknown keys refused,
   addresses NFC + lowercased + IDN domain to ASCII, one plain address per entry, text NFC with CRLF as LF; `cc`,
   `bcc`, `htmlBody`, `attachments`, `threadId`, `inReplyTo`, `messageId` must be empty) and allows a call only when
   its sha256 equals the expected hash of one approved item of that batch, once. Everything else that is not an
   allowlisted read is denied outright, before any approval check: unknown tools, tools on a server that does not
   cover the connector, meta and multiplexer tools, shells, code runners, forward, reply, drafts, and any input that
   carries a nested tool name, command or code. A dry run allows zero non-read tools. The log tool needs a declared
   log step, a configured `inputs.crmSheet`, the exact row, and the item's send first. A batch whose items no longer
   hash to its hash denies every side effect.
2. **Runner idempotency and single flight** (`runner.ts`). Item states `pending -> sending -> sent |
   failed_before_send | unknown` live in the batch file. The gate's `onAllow` writes `sending` to disk BEFORE it
   returns allow (if the write fails, the call is denied). A tool result marks `sent`, a tool error or a throw or a
   missing result marks `unknown`, a crash leaves `sending` which the next locked run turns into `unknown`.
   `sent` and `unknown` count as contacted; only `POST /workflows/:id/release {batchHash, keys}` (explicit user
   action) turns `unknown` into `failed_before_send`. A file lock `$OFFLOAD_HOME/locks/<id>.lock` (O_EXCL, pid,
   stale lock of a dead pid taken over) wraps prepare and execute; a second run gets 409. The chosen recipients are
   written to `preparing.json` before the first model await. Pause and delete call `requestCancel` (aborts the SDK
   query through `abortController`) and the gate re-reads the workflow status before every call. A batch runs only
   from `approved` with its token, or `pending` with auto-run on; the approval is deleted when the run starts.
3. **Privacy** (`src/store/vault.ts`, `reader.ts`). Dry runs (`dry-run.json.enc`, `dry-runs/<ts>.json.enc`),
   dry-run batches (`batches/<hash>.json.enc`), the tone corpus (`tone/corpus.jsonl.enc`) and blind-test pairs and
   key (`*.enc`, read with `tone pairs --home DIR [--answers]`) are sealed with a per-local-day brain key and purged
   after 7 local days: at `serve` startup and every hour (`startPurgeSchedule`), with a `purge-log.jsonl` line
   `{day, deletedAt, events: 0, files, by: "brain"}` and a console line. Legacy plaintext copies are sealed (or
   deleted when older than 7 days) by the purge. Readers refuse an expired artefact even before the purge ran.
   `readStore` refuses stored days older than 7 local days, asks `offload-observer purge-now --home` when the binary
   exists, and the server's analysis cache key includes the local day.
   Window titles and OCR text never enter SKILL.md or a system prompt: SKILL.md and `description` are fixed template
   text; every prompt data block (style card, examples, facts, recipient, subject, approved batch, bucket email) is
   `<name untrusted="true">...</name>` in the user turn with block tags inside the data neutralised; the system
   prompts carry only the fixed rule that untrusted blocks are data. The send step no longer appends SKILL.md.

## Findings
| id | result | where | tests |
|---|---|---|---|
| B1 | fixed | allowlist.ts, gate.ts | s05b-gate `B1: *` (meta tools, bash/workbench/execute, other side-effect tools, one send per flavour, prototype keys) |
| H1 | fixed | allowlist.ts canonicalisation | s05b-gate `H1: *` (subject, htmlBody, attachments, cc/bcc, IDN, forward, thread ids, drafts, unknown keys, Composio schema) |
| H2 | fixed | runner.ts item journal | s05b-runner `H2: *` (throw after call, crash left `sending`, no result, explicit release) |
| H3 | fixed | runner.ts lock + reservation | s05b-runner `H3: *` (two concurrent runs via the API, held lock, reservation before model call, stale lock) |
| H4 | fixed | vault.ts, dryrun.ts, tone/pack.ts, tone/blind.ts, server.ts | s05b-privacy `H4: *` |
| M1 | fixed | allowlist.ts (reads are listed names per connector) | s05b-gate `M1: *` |
| M2 | fixed | runner.ts cancel + gate `cancelled`, routes | s05b-runner `M2: *` (pause mid-run, delete mid-run aborts and never recreates the folder) |
| M3 | fixed | gate.ts roles from declared steps | s05b-gate `M3: *` |
| M4 | fixed in the brain; engine part open (below) | reader.ts, analyze.ts, server.ts | s05b-privacy `M4: *` |
| M5 | fixed | drafter.ts, untrusted.ts, tone/draft.ts, executor.ts | s05b-privacy `M5: *` (instruction isolation) |
| L1 | fixed | runner.ts state check, approval used up | s05b-runner `L1: *` |
| L2 | fixed | store.ts `batchIntact`, gate.ts, runner.ts | s05b-runner `L2: *`, s05b-gate `L2: *` |
| L3 | fixed | insights/saving.ts, dryrun.ts | s05b-misc `L3: *` |
| L4 | fixed in the brain; observer part open (below) | sessionize.ts `sessionizeDays` | s05b-misc `L4: *` |
| L5 | fixed | runner.ts (failed_before_send retried), executor.ts `executorEnv` | s05b-runner `L5: *`, s05b-privacy `L5: *` |

## Decisions and partial disputes (with evidence)
- **Brain key in a file, not the Keychain.** The observer is the only process with the Keychain master key and it has
  no command that wraps or serves a brain key (`engine/Sources/OffloadCore/Observer/CommandLine.swift`: `run, status,
  pause, resume, purge-now, export-day, exclude, install-agent, uninstall-agent`); engine/ is outside this slice.
  The brain therefore uses the documented `OFFLOAD_KEYS=file` scheme (docs/store-contract.md): raw 32-byte day keys,
  0600, folder 0700. This gives crypto-shredding after 7 days (stray copies, backups and snapshots become unreadable
  when the key goes) but not protection from another process of the same user. Follow-up for the engine owner: an
  `offload-observer brain-key DAY` command that returns a Keychain-wrapped key, then vault.ts unwraps through it the
  way reader.ts uses `export-day`.
- **M4, engine half.** "`export-day` refuses days older than keepDays" is an engine change (DayStore/CommandLine) and
  is not made here. The brain never asks for such a day (readStore filters before export) and asks `purge-now`
  after reading. Until the engine change lands, another local caller of `export-day` can still read an expired day.
- **L4, observer half.** A synthetic `focus` at the first tick of a new local day is an engine change. The brain now
  carries the last focus (and its open/idle/paused state) into the next calendar day, so input and OCR after
  midnight count again. It does not extend the previous day's last span to midnight: without an event there the
  brain cannot tell work from a stopped observer, and over-counting is worse for ADR 0005 than a gap of at most one
  input interval.
- **Style cards stay plaintext and are not purged** (`tone/<bucket>.md`, `tone/index.json`). They are a style
  description the user edits by hand (s05 AC-2 keeps an edited card on rebuild by hashing the plain file), the model
  is told to write 4-8 bullets about style with no figures (`STYLE_CARD_SYSTEM`), and the measured part is counts.
  The corpus, which holds the mail itself, is sealed and purged; after 7 days drafting warns "no tone pack yet" until
  `tone build` runs again (a deliberate cost of the 7-day rule).
- **Live batches stay plaintext.** They are the send record the review screen shows; their recipients come from the
  user's own `recipients.csv`, not OCR, and bodies are model drafts. They are never purged so the contacted set
  survives. Dry-run batches, which carry OCR-parsed recipients and subjects, are sealed and purged.
- **Two s05 tests changed their assertions** because they pinned the old name-based gate: the classifier test
  (`GOOGLECALENDAR_FIND_FREE_SLOTS` on a server named `cal` that covers no connector is now a side effect) and the
  CRM write test (now the canonical sheet append with the exact row, after the item's send). Their names are
  unchanged so slices/s05-workflows/verify.sh still finds them. Tests that read the fixture week now pass an explicit
  clock (the reader refuses days older than 7), and `fixtures/gen.ts` defaults to the 7 days ending yesterday.
- **Unverified tool names.** Every name in the allowlist comes from the Gmail MCP README and Composio docs; none was
  checked against a live account here (brain/CONNECTORS.md says so). A wrong name fails closed. Reply-in-thread
  (scheduling) has no allowlisted tool, so those live batches stay off.
- **L3 value vs display.** `weeklyHoursSaved` keeps its unrounded value for ranking; only the printed arithmetic is
  computed from the printed figures, so it adds up by hand.

## Verify
`bash slices/s05b-gate-hardening/verify.sh`: all brain tests pass (at least 260), `bunx tsc --noEmit` is clean, every
finding id in REVIEW-1.md has a passing test whose name starts with that id, and the real CLI on a fresh encrypted
fixture (tone build, draft, dry-run) denies every side effect and leaves no OCR or mail text in plaintext on disk.
