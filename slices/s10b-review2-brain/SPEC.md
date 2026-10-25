# s10b REVIEW-2 brain fixes

Owner: TS engineer. Paths: `brain/`, `slices/s10b-review2-brain/`. Source: `slices/s10-review/REVIEW-2.md` (N1-N9 and
the section 3 privacy inventory). The engine half (observer retention of `keys/brain-YYYY-MM-DD.key`, exit 3 for
expired wrap/unwrap, `wrap-key --import`) landed in engine 52b205b; the app half (show `autoRunPin` and
`keptFiles`, run `cli.ts purge` at launch, pass `serve --log-file`) is the UI engineer's. Types in
`brain/src/api/types.ts` change additively only.

## Acceptance (tag = test name prefix in `brain/tests/s10b-review2/`)
1. N1 auto-run pin (`workflows/autorun.ts`). `POST /workflows/:id/auto-run {enabled:true}` pins sha256 of every
   recipient row (keyed by sha256 of workflow + address, no address in workflow.json), of `facts.md`, of
   `tone/<bucket>.md` and of `SKILL.md`. Enabling again re-pins; disabling drops the pin. The run loop and
   `POST /run` (`dispatchAuto`) approve and send on their own ONLY items whose row is pinned and unchanged, drafted
   (per `draftedWith`) from the pinned files, in a batch drafted after the pin. New or changed rows are split into a
   pending batch with needs_you "3 new recipients need your review." / "1 changed recipient needs your review."; a
   changed file holds the whole batch ("facts.md changed since you turned on auto-run, so this batch of N waits for
   your review."). Auto-run on with no pin (edited by hand) treats every row as new. The executor's token-less auto
   path refuses anything not fully pinned and leaves it pending. DTO: `WorkflowSummaryDTO.autoRunPin`
   (`AutoRunPinDTO`: pinnedAt, recipients, pinnedRecipients, new/changed/removed counts, files with sha256 and
   `changed`); `RunResponse.held`.
2. N2 scheduler isolation (`api/scheduler.ts`). Each workflow runs in its own try. Any error other than a lock
   conflict marks the slot, stores `lastRunError {at, reason}` (scrubbed: no addresses, no quoted text) and shows
   needs_you "The last scheduled run did not finish: REASON. It tries again at the next scheduled time." No retry
   (and no model call) until the next slot. A corrupt workflow.json is skipped. `SchedulerTick.failed`.
3. N3 seal day = capture day. Dry runs, their history and their batch are sealed under the oldest
   `instances[].day` (`Batch.sealDay`); `sealText` accepts a day label. 10-16 captures written 10-19 read until
   10-23 and are refused and purged from 10-24.
4. N4 purge without a running brain: `serve` purges before the listener opens (and hourly), and
   `bun run brain/src/cli.ts purge --home DIR [--json]` runs the same purge (`store/retention.ts purgeAll`); the app
   runs it at launch. The observer purges expired brain keys too: its retention deletes `keys/brain-YYYY-MM-DD.key`
   older than 7 local days (engine 52b205b), so sealed brain files of that day cannot be opened even if the brain
   never runs again. `wrap-key` / `unwrap-key` of such a day exit 3; the brain treats exit 3 as "expired": the sealed
   file is deleted, never logged as a failure. A key piped to `wrap-key` (raw-key migration) passes `--import`.
5. N5 auto-run off and pause stop an in-flight auto batch before its next item: the gate's `cancelled` re-reads
   `autoRun` for auto runs (token-less, or approved by the run loop: `ApprovalRecord.auto`), and turning auto-run off
   aborts only an auto run (`requestCancel(..., {autoOnly})`). A batch you approved yourself keeps going.
6. N6 child environments. Observer children (status, pause, resume, wrap-key, unwrap-key, export-day, purge-now)
   get exactly PATH, HOME, OFFLOAD_HOME, OFFLOAD_KEYS (`observerChildEnv`). SDK children (executor and model,
   `executorEnv` / `modelQueryOptions`) keep their fixed allowlist: PATH, HOME, locale, TMPDIR, proxy and CA
   settings, and the Claude login variables the SDK needs to authenticate. Neither gets OFFLOAD_TOKEN, any other
   OFFLOAD_* setting or a connector secret.
7. N7 trust boundary: the position below.
8. N8 observed names: the generic template's name and `insight.name` leave workflow.json (fixed names
   "Investor outreach emails", "Scheduling replies", "Repeated task"; `insight.name` is ""). The observed label is
   sealed in `workflows/<id>/labels.json.enc` under the capture day of the task's oldest instance and purged with it;
   summaries show it until then, the fixed name after. The purge moves names out of older workflow.json files.
9. N9 `neutralise` strips Unicode format characters (`\p{Cf}`: zero-width, bidi overrides and isolates, BOM, soft
   hyphen) before neutralising tags.
10. PRIV (privacy inventory), file by file:
    - `workflows/*/batches/HASH.json.enc` (live): sealed under the day drafted, purged at 7 days. Before a send is
      allowed the address goes to `contacted.ledger` as `contacted <sha256(workflow, address)>` (`released` when you
      release an unknown send), so nobody is written to twice after the batch is purged. Plain batch files from
      before s10b are journalled, then sealed in place.
    - `tone/<bucket>.md` you did not edit: deleted with the corpus they came from (7 days after the build). A card
      you edited is your file. `tone/index.json` holds hashes and counts only.
    - `recipients.csv`, `facts.md`, `crm-log.csv` (your send record) and tone cards you edited: user files, kept until
      you delete them, listed in `GET /observer` `keptFiles` (`KeptFileDTO`) for the app's "Observing" section.
    - `gate-log.jsonl`: no content on disk (items are `itemRef` hashes, reasons scrubbed), rotated at 5 MB keeping 2.
    - `preparing.json`: transient reservation (addresses from your list), deleted when drafting ends or fails.
    - `approvals.json`, `locks/`, `purge-log.jsonl` (rotated at 5 MB): no content.
11. LOG: the brain log (`serve --log-file FILE`, else stderr) is scrubbed (addresses, quoted text, control and format
    characters removed; 500 chars a line; errors as name, message and 3 frames) and rotates at 5 MB keeping 2.

## N7 position: the same-user trust boundary
On macOS the trust boundary is the user account. Any process running as the same user can read every file in
`$OFFLOAD_HOME`, read the Keychain item the observer reads, run `offload-observer unwrap-key` or `export-day`, call
the brain's loopback API with the token from its environment (`ps -E`), and attach to our processes. There is no
caller check and we do not pretend there is one; the Keychain wrap protects copies of the home (backups, another
account, another Mac), not a live process of this user.

We defend:
- time: everything holding observed or mail text is sealed with a per-day key and purged by the capture day of its
  oldest data, in the brain (start, hourly, `cli.ts purge`) and in the observer (expired day keys and brain keys);
- copies: sealed files and wrapped keys are useless off this account or Mac;
- mistakes and drift by local writers: auto-run sends only to what it pinned, a changed batch file is refused, a
  changed list, facts, tone card or SKILL.md waits for review, approvals are single-use and hash-bound;
- injected text: observed and mail text stays in untrusted blocks, never in a system prompt or SKILL.md, and cannot
  close its block (tags and format characters neutralised); the gate bounds what any model can send;
- leaks by us: children get minimal environments, logs carry no content and are bounded.

We do not defend:
- a malicious process running as the same user: it can read the store while it is kept, unwrap keys, rewrite
  workflow.json and the pin, plant a key with `wrap-key --import`, or drive the API with the token;
- a compromised account, an unlocked and unattended Mac, or malware with the user's privileges;
- what the user's own MCP servers and Gmail do with an email once the gate allowed it.

## Done signal
`slices/s10b-review2-brain/verify.sh` exits 0: all brain tests pass (at least 360), `tsc --noEmit` clean, every
REVIEW-2 brain id (N1-N9 and PRIV, LOG) has passing tests, and the suite passes under TZ=America/Toronto and
TZ=Asia/Karachi.
