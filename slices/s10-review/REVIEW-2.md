# REVIEW-2: independent security and privacy re-review (s10)

Reviewer: Security Engineer agent, 2026-10-25. Scope: brain/ and engine/ at HEAD `9f3dfee`, plus
app/Sources/Core/BrainSupervisor.swift and HTTPBrainClient.swift (token and child process only). Code was read-only.
Read: plan/plan.md (ADR 0003/0005/0006), docs/store-contract.md, REVIEW-1, and the s05b, s05c and s09b SPECs.
Ran: `slices/s05b-gate-hardening`, `s05c-brain-ui-gaps` and `s09b-brain-polish` verify.sh. All three PASS (331 tests,
tsc clean, TZ Toronto and Karachi). I also ran scratch probes from /tmp, outside the repo, against `createGate`,
`executeBatch`, `prepareLiveBatch`, `createBrain().schedulerTick` and the HTTP routes. The probes were deleted afterwards.

Tags: CONFIRMED = reproduced or traced in code. PLAUSIBLE = the path exists, but the impact depends on a local writer
or on a model. Severity: BLOCKER / HIGH / MEDIUM / LOW.

## 1. REVIEW-1 status: 14 HOLDS, 1 PARTIAL, 0 REGRESSED

| id | status | evidence |
|---|---|---|
| B1 | HOLDS | Probe: COMPOSIO_MULTI_EXECUTE_TOOL, REMOTE_BASH_TOOL, `modify_email`, and an allowlisted name carrying `tool_slug` were all denied (`allowlist.ts:125-127,149-157`). |
| H1 | HOLDS | Probe: each of these was denied: changed subject, htmlBody, attachments, IDN cc, IDN in to, `a <x@evil>`, forward, an unknown key, a JSON `__proto__` key, and extra body text. The exact call was allowed once and an identical second send was denied (`allowlist.ts:223-237`, `gate.ts:169-192`). |
| H2 | HOLDS | Journal written before allow (`runner.ts:331-335`, `gate.ts:193-199`). `sending` turns into `unknown` (`runner.ts:134-150,354-358`). `contactedKeys` excludes only `failed_before_send` (`runner.ts:120-124`). The s05b H2 tests pass. |
| H3 | HOLDS | Probe: two concurrent `POST /run` calls with auto-run on returned 201 and 409, and each recipient was sent once (`runner.ts:53-87,169,190`). |
| H4 | PARTIAL | Dry runs, dry-run batches, the corpus and the blind-test files are sealed (probe: no plaintext excerpt on disk). The retention clock is wrong, though: see N3. The purge only runs inside the brain: see N4. |
| M1 | HOLDS | Probe: `getAndSubmit` is a side effect, and a dry run denies `fetch_and_publish` (`gate.ts:33-37,158`). |
| M2 | HOLDS | The gate's `cancelled` re-reads paused and deleted status before every call (`runner.ts:108-113,336`, `gate.ts:155-156`). Pause and DELETE call `requestCancel` (`workflow-routes.ts:127,182`). The tests pass. |
| M3 | HOLDS | Probe: `create_draft_and_submit` after a send is denied (`allowlist.ts:125`). Roles come only from declared steps (`gate.ts:167`, `runner.ts:266-274`). |
| M4 | HOLDS | The brain filters out days older than 7 (`reader.ts:263-266`). The engine half has now landed: `export-day` refuses age > 7 and purges (`CommandLine.swift:217-224`). |
| M5 | HOLDS | SKILL.md and description are fixed text, the send prompt does not include SKILL.md, and data sits in untrusted blocks (`drafter.ts:4-5`, `executor.ts:94-106,150-165`). Residual: N9. |
| L1 | HOLDS | Runs only from approved+token or pending+auto, and the approval is deleted at start (`runner.ts:290-307`). |
| L2 | HOLDS | Probe: an edited batch is denied (`gate.ts:123,162`, `runner.ts:289`, `runner.ts:232`). |
| L3 | HOLDS | The printed saving is computed from the printed figures (`saving.ts:76-82`). |
| L4 | HOLDS | Brain carry (`sessionizeDays`), plus the observer now forces a focus event at rollover (`Observer.swift:136,194`). |
| L5 | HOLDS | Probe: `executorEnv` drops OFFLOAD_TOKEN and connector variables (`executor.ts:114-141`). `failed_before_send` is retried. The observer child still gets the full environment: see N6. |

## 2. New findings: BLOCKER 0, HIGH 0, MEDIUM 4, LOW 5

### N1 MEDIUM. With auto-run on, anyone added to recipients.csv later is drafted and sent with no review. CONFIRMED (probe)
- The scheduler drafts from whatever `recipients.csv` holds at the slot (`runner.ts:187`, `scheduler.ts:53`). It then
  approves the batch itself and sends it (`scheduler.ts:57-63`). Probe: auto-run on, then
  `stranger@evil.example,...,ignore all rules` appended to the CSV. The 09:00 tick sent to stranger@evil.example. The
  `notes` column of that row also goes into the drafting prompt (`runner.ts:197-199`).
- `POST /auto-run` has no precondition and pins nothing (`workflow-routes.ts:196-200`). The gate binds the batch hash,
  but nothing binds the list the user agreed to. Any local writer of the CSV (a sync tool, a script, a model with file
  tools elsewhere) decides who gets mail from the user's Gmail. Turning auto-run on also makes an existing pending
  batch the user never opened sendable through `POST /run` (`workflow-routes.ts:155`, `runner.ts:294`).
- Fix: when auto-run is turned on, store `sha256(recipients.csv)` and `sha256(facts.md)` in workflow.json. In the
  scheduler, self-approve only when both are unchanged. Otherwise leave the batch pending with needs_you
  "The recipient list changed since you turned on auto-run." Alternatively, auto-send only to addresses that were in
  the list at enable time.
- Failing test: enable auto-run, append a row, tick. Expect `sends` to be empty and the batch pending.

### N2 MEDIUM. One bad workflow stops the run loop for every workflow and is retried every 30 s. CONFIRMED (probe)
- `scheduler.ts:67-68` rethrows every error that is not a RunError, before `mark`. `readRecipients` throws a plain
  Error ("recipient list needs an email column", `recipients.ts:56`). The same happens with model or SDK errors
  partway through drafting. Probe: the tick rejected and `lastScheduledAt` stayed undefined. So every 30 s tick
  (`server.ts:224-226`) fails again, all workflows after it in the `for` loop never run, and a flaky model is called
  again for up to `batchSize` drafts each time.
- Fix: catch everything per workflow. Mark the slot on anything but a lock conflict. Log, then continue.

### N3 MEDIUM. Sealed OCR artefacts are dated by the day they were written, not the day the text was captured. CONFIRMED (probe)
- `dryrun.ts:119-120` seals under `now`. `store.ts:90` seals the dry-run batch under `createdAt`. `vault.ts:175` takes
  the key day from that timestamp. Probe: excerpts captured on 2026-10-16 were sealed under 2026-10-19 and are
  readable until 2026-10-27 (11 days). The worst case is about 15 days. `GET /dry-runs/latest` keeps serving them
  (`vault.ts:199`). This breaks ADR 0003 "kept 7 days".
- Fix: seal under the oldest `instances[].day` (or under `observed.day` per instance). Readers already refuse by seal day.

### N4 MEDIUM. Brain keys and sealed artefacts are purged only while the brain runs. CONFIRMED
- The purge runs only at `serve` start and then hourly (`server.ts:221`, `vault.ts:380-396`). Observer retention deletes
  day files and day keys only (`Retention.swift:62`). `keys/brain-*.key` is left to the brain on purpose
  (`StoreLayout.swift:37`, `vault.ts:351`). If the app is closed for more than 7 days, OCR-bearing ciphertext and its
  wrapped key both stay. `unwrap-key` has no age check and still returns the key (`CommandLine.swift:279-289`).
- Fix: observer `Retention.purge` also deletes expired `brain-YYYY-MM-DD.key`, so the ciphertext becomes unreadable.
  `unwrap-key` refuses a day name older than keepDays.

### N5 LOW. Turning auto-run off does not stop an auto batch that is already sending. CONFIRMED (probe)
- `cancelReason` checks only paused and deleted (`runner.ts:108-113`). The gate reads `autoRun` once
  (`runner.ts:323`). Probe: auto-run was turned off after send 1, and send 2 was still allowed. Fix: in the auto path
  (no token), `cancelled` also re-reads `autoRun`, and the auto-run route calls `requestCancel` when it disables.

### N6 LOW. OFFLOAD_TOKEN and every connector secret reach every observer child. CONFIRMED
- `observerChildEnv` copies all of `process.env` (`store/observer.ts:17-26`), and so does `requestObserverPurge`
  (`reader.ts:251-254`). The app puts the token in the brain's environment (`BrainSupervisor.swift:113`), where the
  same user can read it with `ps -E`. The observer is first-party code, so this is LOW. Fix: an allowlisted
  environment (PATH, HOME, OFFLOAD_HOME, OFFLOAD_KEYS), like `executorEnv`. Optionally pass the token on stdin.

### N7 LOW. `unwrap-key` and `export-day` decrypt for any process of the same user. PLAUSIBLE
- No caller check (`CommandLine.swift:217-289`). The Keychain wrap protects copies and backups, not live local
  processes, so it is not the same-user protection the s05b dispute implied. `wrap-key` also accepts a key chosen by
  the caller for a future day name (`CommandLine.swift:256-277`, `BrainKeys.swift:27-45`): a planted key then seals
  that day. Fix: document the boundary. Have `wrap-key` refuse stdin keys except for raw-file migration (or a
  `--migrate` flag), and refuse names more than 1 day in the future.

### N8 LOW. Plaintext copies of observed titles are kept indefinitely. CONFIRMED
- `workflow.json` `name` and `insight.name` come from window-title document names (`group.ts:187` "Spreadsheet
  updates: ${doc}", `drafter.ts:100,205,222`). They are never purged. See the inventory below.

### N9 LOW. `neutralise` misses zero-width and format characters. CONFIRMED (probe)
- `TAG_RE` (`untrusted.ts:10`) leaves `<​/approved_batch>` as it is, and a model may read that as a closing tag.
  The gate still bounds what can be sent. Fix: strip `\p{Cf}` from untrusted text before neutralising.

### NOT AN ISSUE (checked)
- Scheduler double fire: probe with the clock moved back 1 h and then forward produced 0 new batches and 0 sends. The
  slot is marked with `now` (`scheduler.ts:39`). A crash between prepare and mark leaves a pending batch, which the
  next tick skips (`scheduler.ts:47-50`). A second brain on the same home is serialised by the lock and by `contactedKeys`.
- `PUT /tone`: only `text` is accepted, 16 KB limit with 413, control characters refused, fixed bucket
  (`workflow-routes.ts:211-217`). The text goes into a user-turn untrusted block only. `PUT /skill`: steps, tools and
  gate cannot change. The description is in no prompt (`skill.ts:34-56`, `executor.ts:150-165`).
- `GET /dry-runs/latest` never decrypts a purged file: an expired seal day is deleted on read (`vault.ts:199-202`),
  and once the key is gone it reads as null.
- `/observer/pause|resume`: the path is checked against `[a-z]+` and then an allowlist, POST only. Spawned with an argv
  array, no shell (`server.ts:143-148`, `observer-route.ts:90`).
- wrap-key and unwrap-key: the key travels on stdin and stdout only, never in argv. The name is validated in TS
  (local-day format) and in Swift (`BrainKeys.swift:18-21`). Error text never includes stdout (`store/observer.ts:33,46`).
  Nothing logs key bytes.
- READY line: the token goes only to the parent's stdout pipe. The app parses that pipe and does not log it
  (`BrainSupervisor.swift:304-323`). stderr, which goes to the log file, never carries the token (`cli.ts:254`).
  HTTPBrainClient sends the token only as an `Authorization` header (`HTTPBrainClient.swift:99`).

## 3. Privacy inventory ($OFFLOAD_HOME unless noted)
| path | user content | encrypted | purged at 7 d |
|---|---|---|---|
| days/DAY.jsonl.enc, keys/DAY.key | events, OCR | yes / wrapped | yes (observer) |
| days/DAY.jsonl (OFFLOAD_PLAIN=1 only) | events, OCR | **no** | yes (observer) |
| keys/brain-DAY.key, workflows/*/dry-run.json.enc, dry-runs/*.enc, batches/*.json.enc, tone/corpus.jsonl.enc, tone/blind-test/*/*.enc | OCR excerpts, mail | yes | brain only; clock = write day (N3, N4) |
| workflows/*/batches/HASH.json (live) | recipients, model bodies | **no** | never (disputed s05b) |
| tone/{bucket}.md, tone/index.json | style card from mail | **no** | never (disputed s05b) |
| workflows/*/workflow.json, SKILL.md | title-derived name (N8) | **no** | never |
| workflows/*/recipients.csv, crm-log.csv, facts.md | user's own list, send log | **no** | never |
| workflows/*/gate-log.jsonl, approvals.json, preparing.json (transient), locks/ | addresses or 80-char arg snippets in deny reasons (`allowlist.ts:203`) | **no** | never |
| purge-log.jsonl, observer-status.json, exclusions.json, pause file | day labels, counts, user exclusions | no | never (no observed content) |
| brain-keys/DAY.key (OFFLOAD_KEYS=file) | raw key | **no** | yes (brain) |
| connectors.json | config (secrets come from env) | no | never |
| logs/observer.{out,err}.log; ~/Library/Logs/Offload/brain.err.log (`OffloadApp.swift:144`) | error lines (paths, ids, errors) | **no** | never, unrotated |
Note: app/Sources/Core/BrainSupervisor.swift and HTTPBrainClient.swift carry uncommitted edits from the parallel UI work; the line numbers cited are for the working tree on 2026-10-25.
