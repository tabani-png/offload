# Stage 2 wave B review: PRs #7, #8, #9, #10, #11, #12

Reviewer: independent review and integration, 2026-10-25. Judged on code, tests and evidence only, not on the builders' notes.
Environment: macOS, Bun 1.3.12, Postgres 17 (verify-lib container on 127.0.0.1:54339), origin/main = 38a8e15.
Each PR was checked out as a detached worktree with fresh `node_modules` (so the committed lockfile was exercised),
then verified with `S2_BASE=origin/main bash slices/<id>/verify.sh`. Code review was static, done by four independent
readers. I re-checked the top finding of each PR against the code myself. No PR was pushed, merged, closed or edited.
The integration is on branch `integration-wave-b`, which is not merged to main.

## Summary

| PR | verdict | verify.sh on the PR branch | top reason |
|---|---|---|---|
| #8 S2-06 registry | MERGE (follow-ups listed) | PASS: typecheck ok, 100 tests, PROPOSAL 14, PROMOTE 14, VERSION 12, BINDING 12, STRIP 6, SOP 11, RBAC 14, AUDIT 9 | only MEDIUM issues |
| #9 S2-05 ingest + metrics | FIX FIRST | PASS: typecheck ok, 108 tests, every tag passing (PERSON 10, EVIDENCE 8, RECOMPUTE 8, RLS 9, ...) | complementary suppression can be undone by asking for a scope directly |
| #10 S2-08 compliance | FIX FIRST | FAIL, 1 check: `S2-01 suite regressed` (LOADER test, see below). Suite itself: typecheck ok, 159 tests, every tag passing | retention cannot delete S2-05 rows; self-view misses wave-B person tables |
| #12 S2-07 policies + broker | FIX FIRST | PASS: typecheck ok, 134 tests, every tag passing (KILL 9, LINKEDIN 4, RBAC 7, AUDIT 3, ...) | pausing a policy does not stop approved sends; recipient addresses in audit detail |
| #7 s18 name masking | FIX FIRST (small) | PASS: 62 s18 tests, every tag passing; measured FP 0/291 = 0%, FN 1/83 = 1.2%; full brain suite 1095 pass, 5 skip, 0 fail | placeholder injection can put recipient A's name in B's draft; a leftover placeholder is only a warning |
| #11 s19 messaging playbook | FIX FIRST | PASS: 71 s19 tests, every tag passing; full brain suite 1203 pass, 5 skip, 0 fail; founder fixture ok | sentence-initial names pass the playbook masker and the leak check |

Frozen files: `git diff origin/main...origin/<branch>` on `slices/S2-common/**`, `schemas/**` and the S2 slices'
`SPEC.md`/`verify.sh` is empty for all four S2 PRs. #7 and #11 add their own `slices/<id>/SPEC.md` and `verify.sh`.
Those slices did not exist on main, so the builder wrote the contract in the same PR (see "Contract notes").
No secrets: `git grep` for `sk-ant|AKIA|ghp_|api.workos.com` over `control/` on the four control branches finds nothing.
No real email or account writes in tests: the broker tests use the fake Composio runner, and the brain tests use
`StubModel`.

Path overlap: none between the four control slices (each stays in its module, migration range and test folder). The
exception is #9, which edits `control/tests/S2-01/device.test.ts` (2 lines, `/v1/sync/config` 404 -> 200), outside its
`paths_in_scope`. The edit is correct and minimal. #7 and #11 overlap on `brain/src/tone/draft.ts`,
`brain/src/workflows/{dryrun,runner}.ts`, `brain/src/models/{model,router}.ts` and `brain/API.md`, all additive. The
conflicts are resolved on the integration branch.

Branch freshness: the four S2 branches and #11 are 2 commits behind main (docs only). #7 is 21 behind
(`BASE=f203a59` in its verify.sh is stale). It still merges and passes on the integration branch.

## Ranked issues (all PRs)

| # | sev | PR | file:line | issue |
|---|---|---|---|---|
| 1 | HIGH | #9 | control/src/modules/metrics/hours.ts:20-23, :36-49 | Complementary suppression is per report, so `scope=department:C` read directly builds a fresh report with C as root and is never complementary-suppressed. Example: departments A=10, B=4, C=8. The company report hides B and C, then company minus A minus C (each read directly) recovers B. The same differencing works between job_role and department cuts. |
| 2 | HIGH | #10 + #9 | control/src/modules/compliance/retention.ts:20-27; control/migrations/0501_metrics.sql:210 | Retention deletes from S2-05's per-person tables, but S2-05 grants `offload_app` only SELECT, INSERT, UPDATE, so on the integrated tree the first DELETE fails and the whole pass rolls back. Retention also guesses table names (`person_daily_aggregates` does not exist; `baseline_sample_instances`, `daily_aggregate_workflows` are missed) and treats a missing table as "skipped" (fail open). |
| 3 | HIGH | #10 (integration) | control/src/modules/compliance/selfview.ts:33-71 | The catalog guard fires on the integrated tree: 16 person-id columns from S2-05/06/07 are not registered. S2-05's `run_outcomes`, `daily_aggregates`, `working_time_aggregates` and related tables are real data about the employee and belong in the `runs`, `dailyAggregates` and `workingTime` fields of `self-view.schema.json`, which S2-08 currently returns empty. |
| 4 | HIGH | #12 | control/src/modules/policies/index.ts:138-168; control/src/modules/broker/broker.ts:945-1015 | PATCH `state: "paused"` (or tightening the allowlist, window, caps or template) only updates the row. `executeItem` never re-reads the policy, so policy-approved items already scheduled for the next window still send after the owner pauses. |
| 5 | HIGH | #12 | broker.ts:464, :653, :950; stage1.ts:64 | Reject and deny reasons embed `item.key` (the recipient address) and brain allowlist messages that quote the address, and are written into audit `detail` (`batch.propose_rejected`, `batch.item_denied`) and `batch_items.error`. Owner, admin and auditor read the audit log, which breaks ADR 0111 §6. The brain gate scrubs these (`scrubLogText`); the broker does not. |
| 6 | HIGH | #12 | broker.ts:1107-1108, :565-572 | `reportNightSignals` inserts the night's counter row with `dry_run=false` (`on conflict do nothing`), and `nightRow` returns an existing row unchanged. If a cost or signal is reported before the night's first `proposeBatch`, a dry-run night runs live. |
| 7 | HIGH | #11 | brain/src/playbook/mask.ts:41, :46, :133-138, :184; leak.ts:39 | The masker keeps a capitalised word at sentence start unless it is already in the identity set, and the identity set only collects mid-sentence words. So "Priya is an engineer at Ramp" goes to Haiku as "Priya is an engineer at [name]", and `CLAIM_RE` (`is an? [a-z]`) can lift it into `coreClaim`, `message` and template text. `TOKEN_RE` (`[A-Za-zÀ-ÿ]`) never tokenises names such as Łukasz or any non-Latin name. The leak check only flags words already in the identity sets, so it cannot catch any of these. |
| 8 | MEDIUM | #7 | brain/src/privacy/names.ts:50, :369; brain/src/workflows/runner.ts (shared run map) | Placeholder-shaped text in input (`<person:2>` in a recipient `notes` cell or an inbound message) is passed through unmasked. If the model echoes it, `unmask` restores whatever real name that placeholder holds in the run-wide map, so recipient B's draft can carry recipient A's name, or `<person:me>` can expand to the user's name. |
| 9 | MEDIUM | #7 | brain/src/tone/draft.ts (`unrestoredPlaceholders`), brain/src/plan/text-step.ts | A literal `<person:N>` left in a draft is only a warning. `autorun.ts` does not consult warnings, so an auto-run workflow can send it. |
| 10 | MEDIUM | #7 | brain/src/privacy/names.ts:123-146; tests/s18-name-masking/rates.ts | Names outside the embedded lexicon with no cue ("CV - Wanjiru Kamau.pdf") are not masked. The FP/FN gate is measured on a hand-written corpus whose names are in the lexicon or carry a cue, so 1.2% FN says little about real mail. ADR 0010 admits the first point; the UI and the API docs do not. |
| 11 | MEDIUM | #9 | control/src/modules/metrics/adoption.ts:48, :109 | Adoption and working time have no complementary suppression at all. A suppressed department is recovered as company minus the visible departments. |
| 12 | MEDIUM | #9 | control/src/modules/sync/ingest.ts:83-84 | The 1 MiB envelope cap is checked after `arrayBuffer()` has read the whole body, and there is no `bodyLimit` in app.ts. An authenticated device can make the server buffer arbitrarily large bodies. |
| 13 | MEDIUM | #9 | control/src/modules/metrics/store.ts:42-44 (called :68, :79, :94); recompute.ts:37-45 | `markStale` updates every snapshot row of the tenant for every run_outcome, review_event and baseline_sample object, inside the ingest transaction. Concurrent envelopes serialise on these rows, with deadlock risk against the nightly `for update`. Recompute also reads its inputs before it locks the snapshot, so an ingest committing in between is marked final, which causes a false `recompute_mismatch` the next night. |
| 14 | MEDIUM | #12 | broker.ts:461-465 | The "an unknown or sending item blocks new batches to that recipient until release" rule is checked only at propose and edit. A batch proposed before the other batch went `unknown` is approved and sent anyway. |
| 15 | MEDIUM | #12 | broker.ts:447; stage1.ts:64 | The duplicate-recipient check uses `to.toLowerCase()`, while the brain's `normaliseAddress` also trims and applies NFC and punycode. `"bob@x.com"` and `" bob@x.com"` both pass, and both send. |
| 16 | MEDIUM | #12 | policies/index.ts:153; migration 0700 (CHECK on dry_run_nights) | Only a templateHash change resets `dryRunNightsDone`. Widening recipients, mode or window does not reset it. `dryRunNights` may be 0, so a member who owns a policy can skip the dry run. A night counts even if it tripped, though ADR 0106 says "successful" nights. |
| 17 | MEDIUM | #12 | (no caller) | Nothing calls `runDue` or `reconcile`. Items scheduled into a later window never run unless `commitApproved` is called again, and `sending` rows stuck after a crash never become `unknown`. Confirm which slice owns the scheduler (S2-09?). |
| 18 | MEDIUM | #10 | control/src/modules/compliance/retention.ts:92-99 | The retention job throws unless a `tenantId` is passed, but `Job.run(deps)` carries none. A scheduler calling it would fail every night. |
| 19 | MEDIUM | #10 | selfview.ts:104-106 | The access log returns whole `person.list` / `notice.acks_read` events, whose `detail.ids` names every other person read in that call. Redact to the caller's id. |
| 20 | MEDIUM | #10 | notices.ts:132-181 | A template-based notice can be published with unfilled `{{field}}` placeholders. Employees could acknowledge "{{how}}". |
| 21 | MEDIUM | #11 | brain/src/playbook/build.ts:93-94 | With no tone pack (expired), identity comes from facts.md only. The notes edit and the promotion re-check then skip the name check while reporting "re-checked". |
| 22 | MEDIUM | #11 | brain/src/playbook/read.ts:305; synth.ts:302 | Any model error aborts the build with a 500 (it fails closed and writes nothing). The comment says the baseline stands when the wording fails. There is one sequential Haiku call per message, with no cap. |
| 23 | MEDIUM | #8 | control/src/modules/registry/strip.ts:13 | Strip masks only the host of a scheme-less URL: `linkedin.com/in/jane-doe` becomes `[host]/in/jane-doe`, and `josé@x.com` becomes `é@[host]`. This is the server-side backstop for devices that skipped masking. |
| 24 | MEDIUM | #8 | control/src/modules/registry/store.ts:51-60; routes.ts:243-246 | A dept lead sees proposals only from their own department (proposer_department_id), while API.md says promote is "Dp (target dept)". A lead of department B cannot promote a proposal from department A that targets B. Decide which is intended; the test encodes the current behaviour. |
| 25 | MEDIUM | #7 + #11 | plan/adr/0010-name-masking.md, plan/adr/0010-messaging-playbook.md | Two different ADRs are both numbered 0010, and code comments in both slices cite "ADR 0010". Renumber s19's to 0011 (file name, its own comments, `brain/API.md` s19 heading, the s19 verify.sh scope line). |
| 26 | LOW | #9 | store.ts:97-124; migration 0501 PK | Working-time and daily rows are unique per (device, object_id), not per person-day, so a person with two devices is counted twice in the medians. |
| 27 | LOW | #9 | ingest.ts:51-71 | `siblingHandlers` is resolved lazily and caches a rejected promise forever (every later batch returns 500). It reloads from `import.meta.dir/..` and ignores `createApp({modulesDir})`. |
| 28 | LOW | #9 | load.ts:99-120 | `loadRuns` dedupes by `run_id` across devices. Dedupe per (device_id, run_id). |
| 29 | LOW | #12 | policies/index.ts:97-113; routes.ts:31-34 | Allowlist emails are shown to admin, auditor and dept_lead. The batches list and detail disagree on the runner's visibility under `dept_lead` policies. |
| 30 | LOW | #12 | migration 0700 | No DB immutability for `batch_items.fields`, `item_hash`, token `used_at`/`revoked_at` (all UPDATE-able by `offload_app`). Integrity is app-level only. |
| 31 | LOW | #8 | sync.ts:22-27; store.ts:123-126 | Raw (unstripped) proposals are stored and shown to auditors and dept leads while `proposed`. Strip runs only at promote. Probably intended by ADR 0104; confirm. |
| 32 | LOW | #8 | golden/sop-investor-outreach-v2.md; template.ts:66-79 | The SOP golden has a "- company_name: [fact]" rule bullet lifted from a stripped fact line. Filter lines ending in `[fact]`. |
| 33 | LOW | #10 | 0800_compliance.sql (end); selfview.ts:201-206 | `correction_requests` has an unrestricted UPDATE grant. The 5-exports-per-day limit is check-then-act with no lock. |
| 34 | LOW | #11 | playbook/store.ts | `readPlaybook` does a raw `JSON.parse`, so a corrupt playbook.json throws on dry run and on run. |

## PR #8 S2-06 registry: MERGE

Evidence: `verify.sh` PASS. Typecheck is ok. 100 tests, every tag passing. Migrations are in range 0600-0699, with no
BYPASSRLS or SECURITY DEFINER. S2-01 stays green. Untouched paths hold.

What is solid:
- **Immutability:** versions and bindings have row triggers plus statement-level TRUNCATE triggers, and no UPDATE or
  DELETE grant. The proposal fields are frozen by trigger.
- **Version numbering:** a `FOR UPDATE` lock on the workflow row is taken before `latest_version + 1`, with the primary
  key as backstop.
- **definitionHash:** JCS over exactly the fields the SPEC lists.
- **Promote and new-version binding checks:** they need a `company` connection, re-read the stored connection, require
  a kind match, and check both the verb regex and `class=commit`.
- **RLS and audit:** RLS is forced on all four tables, with composite tenant FKs. All five audit events are written, and
  a refused promote writes nothing.
- **SOP:** output is byte-stable (no clock, no ids, no locale).

Follow-ups (not blocking; a cloud builder can take them in a later pass):
1. `control/src/modules/registry/strip.ts`, HOST_RE.
   - Problem: the path after a scheme-less host survives, and non-ASCII local parts of emails survive.
   - Expected: `linkedin.com/in/jane-doe` becomes `[link]` (or `[host]` with no path), and `josé@x.com` becomes `[email]`.
   - Change: consume `(?:[/:?#][^\s)\]>"'`]*)?` after the host, and use `\p{L}` in the email local part.
   - Tests: add STRIP tests for both cases.
2. `store.ts:51-60` and `routes.ts:243-246`.
   - Problem: a dept lead cannot see or promote a proposal from another department that targets their own department.
   - Expected: the coordinator decides. Either `Dp` sees proposals whose target department is theirs (API.md "Dp
     (target dept)"), or API.md is narrowed to "proposer's dept".
   - Change: adjust the test to match the decision.
3. `template.ts:66-79`.
   - Problem: a stripped fact line is lifted into the SOP rules.
   - Change: skip rule lines that end in `[fact]`, then regenerate the golden.

## PR #9 S2-05 ingest + metrics: FIX FIRST

Evidence: `verify.sh` PASS. Typecheck is ok, 108 tests, every tag passing.

What is solid:
- **Envelope verification:** ES256 is verified over the exact received bytes before parsing. Only raw 64-byte
  signatures are accepted, the algorithm is fixed, keyid must equal the token's deviceId, and the device must be active.
- **Body checks:** the body must equal `jcs(parsed)`, with `sentAt` within ±10 minutes.
- **seq handling:** strictly increasing under `FOR UPDATE`, and not advanced when the whole envelope fails.
- **Per object:** each object runs in a savepoint, schema validation comes before storage, and duplicates are
  idempotent.
- **run_outcome:** the upsert keeps the latest seq, per ADR 0111 §4.
- **Fail closed:** with the default ports, metric kinds get `consent_missing` and working time gets `feature_disabled`.
- **Hours math:** all of it goes through `packages/hours-saved`. The floor counts distinct people with runs.
- **Person reads:** the order is authorize, then audit `person.read`, then RLS widening, all in one transaction.

Fix list:
1. **(HIGH) `control/src/modules/metrics/hours.ts`, `groupInput`/`hoursSaved`.**
   - Problem: a direct read of `department:X` or `job_role:Y` is computed as its own root, so a cell that is
     complementary-suppressed in the parent's report is returned in full.
   - Expected: for `department:X`, build the company report (children = departments) and return X's cell exactly as
     `suppress()` leaves it. The same applies to `job_role:Y` inside its department's report. If X is suppressed there,
     the direct read is suppressed too, with the same reason.
   - Test: departments A=10, B=4, C=8 with data. Company hides B and C. `scope=department:C` is suppressed, and no
     combination of reads reveals B's seconds.
2. **(MEDIUM) `metrics/adoption.ts:48, :109`.**
   - Problem: there is no complementary suppression.
   - Expected: apply the same `suppress()` over the parent tree to `peopleWithActiveWorkflow`/`peopleTotal` and to the
     working-time `people`/minutes, so a below-floor department cannot be recovered by subtraction.
   - Test: add one.
3. **(MEDIUM) `sync/ingest.ts:83-84`.**
   - Problem: the size cap is checked after the full read.
   - Expected: reject `Content-Length > MAX_ENVELOPE_BYTES` with 413/400 before reading. Read the body as a stream with
     a running byte cap, or mount Hono `bodyLimit` on `POST /v1/sync/batches`.
   - Test: an oversize body without Content-Length is rejected without buffering it all.
4. **(MEDIUM) `metrics/store.ts:42-44`.**
   - Problem: `markStale` runs per object over every snapshot row.
   - Expected: at most one stale-marking statement per ingest transaction, ideally a single `(tenant_id, month)` dirty
     row.
   - Also in `metrics/recompute.ts:37-45`: take the snapshot lock (or a tenant advisory lock) before `groupInput`
     reads the inputs, so a concurrent ingest is never marked final.
5. **(LOW) `metrics/store.ts`, adoption working-time queries.**
   - Problem: rows are not unique per person-day.
   - Expected: dedupe per (person_id, day), keeping the latest seq, before medians are computed.
6. **(LOW) `sync/ingest.ts:51-71`.**
   - Problem: handler resolution is lazy, cached even when it fails, and ignores `modulesDir`.
   - Expected: resolve the handlers from the modules `createApp` actually loaded, or at least evict the cache on failure.
7. **(LOW) `metrics/load.ts:99-120`.** Expected: dedupe runs per (device_id, run_id).
8. **(integration, already applied on `integration-wave-b`) test fixes.**
   - `control/tests/S2-05/helpers.ts`: `modulesWith` must copy only `org`, `sync` and `metrics`. Copying every module
     drags in compliance's `notice_ack` handler (a clash with the fake) and the broker's `ajv` import, which does not
     resolve from a temp dir.
   - `control/tests/S2-05/config.test.ts`: with S2-07 mounted, `killSwitch` is read from the table, so expect `false`.
   - Rebase onto main after #12 and #10 merge and carry these two edits.

## PR #10 S2-08 compliance: FIX FIRST

Evidence: `verify.sh` FAIL, 1 check (`S2-01 suite regressed`). The S2-08 suite itself passes: typecheck ok, 159 tests,
every tag passing (HIDDEN 5, TEMPLATES 30, RETENTION 8, ...).

The S2-01 failure is `LOADER: a module dropped into modules/ is mounted without editing app.ts`.
`control/tests/S2-01/loader.test.ts:70` asserts that `/v1/compliance/features` is 404 in the app built from the real
modules folder. That stops being true once S2-08 is real. The file is outside S2-08's scope. It is fixed on
`integration-wave-b` by asserting the fake module's body is absent instead of the 404, which keeps the negative control.

What is solid:
- **Enablement rules:** owner-only enable and immediate disable. The notice period is 1 day for NY, CT and US-DE.
  German `DE`/`DE-*` is kept apart from Delaware and needs a works agreement. CA-QC needs its ack, and unknown
  jurisdictions are refused.
- **Overlap and effective time:** the overlap check runs under an advisory lock, and `effectiveAt` is enforced by a DB
  CHECK.
- **Consent:** G1 and G2 are forward-only and fail closed. No published notice means only `notice_ack`.
- **Acks:** bound to the principal's own person. They are idempotent, and the web and Mac paths share the same code.
- **History:** kept with triggers and no DELETE grant.
- **Templates:** all 11 carry the counsel disclaimer.

Wave A item 11 (what `requiredNotice: null` means) is answered by this server: null means no notice applies, and only
`notice_ack` is allowed. The Mac side must not treat null as satisfied (S2-02 follow-up).

Fix list:
1. **(HIGH) Retention against the real S2-05 tables.**
   - Files: `control/src/modules/compliance/retention.ts:20-27`, plus a new `control/migrations/08xx_*.sql`.
   - Problem: `offload_app` has no DELETE on S2-05's tables, so retention fails on the integrated tree.
   - Expected:
     - Add a 08xx migration that grants DELETE on `run_outcomes`, `review_events`, `baseline_samples`,
       `baseline_sample_instances`, `daily_aggregates`, `daily_aggregate_workflows` and `working_time_aggregates` to
       `offload_app`. Check that their RLS policies admit the delete under the retention job's settings.
     - Replace the guessed list with these exact names and their real time columns.
     - Make a missing listed table a failure, not a skip.
   - Tests: on the integrated schema, insert rows past retention into each table and assert they are deleted.
     `tests/S2-08/retention.test.ts` currently creates its own `daily_aggregates` and similar tables, and fails with
     "relation already exists" once S2-05 is present. Use the real tables.
2. **(HIGH) Self-view registry.**
   - File: `control/src/modules/compliance/selfview.ts:33-71`.
   - Problem: the catalog guard fails on the integrated tree for 16 columns.
   - Expected, per column:
     - Show in the self-view: S2-05 `run_outcomes.person_id` -> `runs`; `daily_aggregates.person_id` and
       `daily_aggregate_workflows.person_id` -> `dailyAggregates`; `working_time_aggregates.person_id` -> `workingTime`.
       Fill those self-view fields from the tables, not with empty arrays. Add `baseline_samples.person_id`,
       `baseline_sample_instances.person_id` and `review_events.person_id` with a section or a reason.
     - Register as acts with a reason: S2-06 `workflows.proposed_by`, `workflows.promoted_by`,
       `workflow_versions.created_by`, `proposals_declined.declined_by`. A member's own proposals arguably belong in the
       view, so decide that.
     - Register with a reason: S2-07 `batches.runner_person_id`, `overnight_policies.owner_person_id`,
       `kill_switches.set_by`, `role_policies.updated_by`.
   - Test: both SELFVIEW catalog tests pass on the integrated tree.
3. **(MEDIUM) `retention.ts:92-99`.**
   - Problem: `run` needs a tenantId that `Job.run(deps)` does not pass.
   - Expected: the job enumerates tenants itself (migrator or system role, then `withTenant` per tenant), or the Job
     signature changes through an ADR.
4. **(MEDIUM) `selfview.ts:104-106`.**
   - Problem: the access log leaks co-subjects.
   - Expected: for list-style events, return `detail` with `ids` reduced to the caller's id. Match on `detail->'ids'`
     generally rather than two hard-coded action names.
5. **(MEDIUM) `notices.ts:132-181`.**
   - Problem: placeholders can survive into a published notice.
   - Expected: publish of a non-`custom` template notice fails with 422 while any `{{field}}` remains or a template
     `requiredFields` entry is empty.
6. **(LOW) `0800_compliance.sql`.** Restrict the `correction_requests` UPDATE grant to the state columns. Make the
   export limit atomic (count under a lock, or a unique per-day counter).

## PR #12 S2-07 policies + broker: FIX FIRST

Evidence: `verify.sh` PASS. Typecheck is ok, 134 tests, every tag passing.

What is solid:
- **Brain reuse:** `batchHash`, `canonicalArgs`, `expectedHash`, the allowlist and the address normaliser are imported
  from the brain, with nothing copied. Parity is proven.
- **Tokens:** stored as sha256, 24 h TTL, bound to the hash, consumed under `FOR UPDATE`, and the plaintext is never
  returned or logged.
- **Journal:** `sending` and the ledger row commit before the external call. Throw or timeout becomes `unknown`, which
  is never retried; only `release` clears it.
- **Field visibility:** non-approvers see an `itemRef`, never the key. Field views are audited.
- **Migration:** RLS is forced on all 9 tables, with no DELETE grant and no SECURITY DEFINER.
- **Composio runner:** takes an argv array (no shell string).

Fix list:
1. **(HIGH) `policies/index.ts:138-168`, `broker.ts:945-1015`.**
   - Problem: pause and tightening do not stop approved sends.
   - Expected:
     - Any PATCH that sets `state != active` or narrows the allowlist, window, caps, attachments or template unlinks
       that policy's unsent policy-approved items. Do it the same way `tripPolicy` does: revoke their tokens and return
       the items to `pending`.
     - `executeItem` fails closed when the token has a `policy_id` and that policy is not `active`.
   - Test: approve via policy, schedule for the next window, pause, and run the window: nothing is sent.
2. **(HIGH) `broker.ts:464, :653, :950`, `stage1.ts:64`.**
   - Problem: recipient addresses and keys are written into audit `detail` and `batch_items.error`.
   - Expected: audit `detail` carries `itemRef` and a reason code, never an address or key. Run free text through the
     brain's `scrubLogText` before storing it.
   - Test: propose a batch with a disallowed recipient, and assert that the audit row and the item error contain
     neither the address nor its domain.
3. **(HIGH) `broker.ts:1107-1108`, `:565-572`.**
   - Problem: an early signal report turns a dry-run night live.
   - Expected: `reportNightSignals` only updates an existing row. Alternatively, `nightRow` decides dry-run from
     `dry_run_nights_done` whenever the row has not been evaluated yet (add an `evaluated` flag).
   - Test: report a signal, then propose on a policy with dry-run nights left. The night is dry.
4. **(MEDIUM) `broker.ts` executeItem prepare transaction.**
   - Problem: the unknown/sending ledger check is missing at execute.
   - Expected: refuse (leave pending) when the ledger has an unreleased `sending` or `unknown` row for the same
     (workflow, recipient) from another batch.
5. **(MEDIUM) `broker.ts:447` validate.**
   - Problem: duplicate recipients after normalisation are allowed.
   - Expected: reject a batch in which two items have the same `normaliseAddress(recipientOf(item))`.
6. **(MEDIUM) `policies/index.ts:153`, migration 0700.**
   - Problem: the dry-run counter resets only on a template change.
   - Expected: reset `dryRunNightsDone` on any trust-widening edit (recipients, mode, window, caps up). A minimum of 3
     dry-run nights unless an owner or admin sets it lower. Count a night only if it did not trip.
7. **(MEDIUM) Scheduler.** State in the README which slice calls `runDue` and `reconcile` (S2-09 or S2-12). If it is
   this slice, add the job (`jobs: [...]` on the module).

## PR #7 s18 name masking: FIX FIRST (small)

Evidence: `verify.sh` PASS. 62 s18 tests, every tag passing (DETECT, NONNAME, PERSONAS, ROUNDTRIP, NOTES, SPANS,
ROUTER, EGRESS, REVIEW, SELF). Measured FP 0/291 = 0%, FN 1/83 = 1.2%. The masker imports no model or network code.
The full brain suite on the branch is 1100 tests: 1095 pass, 5 skip, 0 fail.

What is solid:
- **Router coverage:** every `Model.complete` caller reaches `ModelRouter.complete`, which masks the system and user
  turns before any backend.
- **Name map:** in memory only (`toJSON` returns a count). Restore runs only for the draft, step, style_card and explain
  roles. Other roles collapse to `<name>`.
- **Approved text:** real text, so `batchHash` covers what is sent.
- **Own name and stored text:** the own name is masked by default, and stored text gets `<name>`.

Fix list:
1. **(MEDIUM) `brain/src/privacy/names.ts`.**
   - Problem: placeholder injection.
   - Expected: before masking, any `<person:...>` text already present in input is neutralised (escaped, or replaced
     by `<name>`), so only placeholders the map wrote can be restored. Alternatively, use a per-run random nonce in the
     placeholder (`<person:k3f9:2>`).
   - Test: a recipient's notes contain `<person:1>`, and the model echoes it. B's draft must not contain A's name.
2. **(MEDIUM) `brain/src/tone/draft.ts`, `brain/src/plan/text-step.ts`, `brain/src/workflows/autorun.ts`.**
   - Problem: a leftover `<person:N>` is only a warning.
   - Expected: the item is excluded from auto-send (or the draft fails), and the review UI shows the warning.
3. **(MEDIUM) `slices/s18-name-masking/SPEC.md`, `plan/adr/0010-name-masking.md`, `brain/API.md`.**
   - Problem: limits are not stated.
   - Expected: state that names outside the lexicon with no cue are not masked. State the three model paths that
     bypass the router (screenshot captioning, the computer-use planner, and the approved batch to the executor, by
     design).
   - Tests: add a held-out rates set of names that are not in the lexicon and have no cue, and report its FN rate
     separately from the tuned corpus.
4. **(LOW) `slices/s18-name-masking/verify.sh`.** `BASE=f203a59` is 21 commits behind main. Rebase and update BASE. The
   ported s05b idempotency fix is already on main and should drop out.

## PR #11 s19 messaging playbook: FIX FIRST

Evidence: `verify.sh` PASS. 71 s19 tests, every tag passing (MASK, READ 7, KNOWN 7, OUTCOME 5, PLAYBOOK 7, LEAK 7,
NUMBERS 6, ROUTER 2, SUCCESSOR 7, DRYRUN 6, API 11). The full brain suite is 1208 tests: 1203 pass, 5 skip, 0 fail.
The founder fixture end to end gives: `ok playbook v1: 24 messages, 12 replied / 6 no reply; dry run verdicts
yes,yes,yes,yes,yes`. No new dependencies.

What is solid:
- **Counts:** stats are pure code (no rates, lower median, ties sorted), and render is byte-stable.
- **Leak check:** runs on every write path.
- **Successor drafts:** use the current user's tone pack, never the author's examples.
- **Pin:** the auto-run pin covers `playbook.json`.
- **Routes:** model routes are consistent (Haiku for label, Opus for synthesis).

Fix list:
1. **(HIGH) `brain/src/playbook/mask.ts`.**
   - Problem: sentence-initial and non-Latin names pass.
   - Expected:
     - Tokenise with `\p{L}` (`/\[[a-z_]+\]|\{[a-z_]+\}|\p{L}[\p{L}'’-]*/gu`), and test capitals with `\p{Lu}`.
     - Mask a sentence-initial capitalised word unless it is in `GENERIC` or a small common-word list.
     - Restrict `coreClaim` so that it cannot start with an unmasked capitalised token.
   - Tests:
     - "Priya is an engineer at Ramp." never reaches the model or the playbook with "Priya".
     - "Łukasz" and a Cyrillic name are masked.
     - A name the model adds that is in none of the identity sets is caught by `findTextLeaks` (add a capitalised-word
       heuristic for words outside the playbook's own vocabulary).
2. **(MEDIUM) `brain/src/playbook/build.ts:93-94`.**
   - Problem: with no tone pack, the identity set is thin.
   - Expected: persist an identity digest (hashed name set) at build time and check later edits and promotion against
     it. Alternatively, refuse the notes edit and `playbookForPromotion` with a clear 409 when no pack is available.
3. **(MEDIUM) `read.ts:305`, `synth.ts:302`.**
   - Problem: one model error aborts the build.
   - Expected: on an Opus failure, keep the deterministic baseline with a warning. On a Haiku failure for one message,
     fall back to the rule read for that message. Cap the per-message calls.
4. **(LOW) `playbook/store.ts`.** `readPlaybook` returns null with a warning on corrupt JSON, instead of throwing in the
   dry run and the run.
5. **(MEDIUM, coordination) ADR numbering.** Rename `plan/adr/0010-messaging-playbook.md` to `0011-messaging-playbook.md`
   and update its references (s19 comments, `brain/API.md` s19 heading, the SPEC, and the verify.sh scope line).
   s18 keeps 0010.

## Contract notes
- #7 and #11 wrote their own `SPEC.md` and `verify.sh` (the slice folders are new in the PR). The contracts are
  reasonable, but they were not frozen before the build. The s18 FN gate is measured on a corpus the masker was tuned
  on, and the s19 suite has no non-Latin or sentence-initial cases. For later brain slices, have the coordinator freeze
  the contract first, as for S2.
- `deviceConsent` (S2-08) and `GET /v1/sync/config` (S2-05) both describe device consent. On the integrated tree,
  config reads the ports, which compliance now provides. A device-config test with the real compliance module is worth
  adding at S2-13.

## Integration: branch `integration-wave-b`

Built from origin/main 38a8e15 with `git merge --no-ff`, in this order:
1. S2-06 (616aa0a)
2. S2-07 (a26ad59)
3. S2-05 (45adb38)
4. S2-08 (990ca7b)
5. s18 (eca3557)
6. s19 (aebde66)

Then one integration commit (ce1a1e3). The branch is pushed to origin and not merged to main. No PR was closed.

### Conflicts and how they were resolved
- **s18 merge, `brain/API.md`.** Main's "Company sync (S2-02)" section and s18's "s18: person names" section were
  appended at the same spot. I kept both, main's first.
- **s19 merge, `brain/src/tone/draft.ts`.**
  - The request type kept both optional fields, `names?: NameMap` (s18) and `playbook?: Playbook | null` (s19).
  - The body takes s19's successor-voice pack and playbook system prompt. The `complete()` call keeps s18's
    `...(req.names === undefined ? {} : { names: req.names })`.
- **s19 merge, `brain/src/workflows/dryrun.ts` and `runner.ts`.** Both import sets are kept. Both the `names` map and
  the `playbook` read are kept, and every `draftInTone({...})` call passes `names, playbook`. `bunx tsc --noEmit` in
  `brain/` is clean after the resolution.
- **No textual conflicts among the four control PRs.** They did have semantic conflicts, where tests assumed later
  modules were absent. Three of these are fixed in ce1a1e3, test files only:
  - `control/tests/S2-01/loader.test.ts:70`: asserts the fake module's body is absent, instead of a 404 on
    `/v1/compliance/features`, which S2-08 now serves.
  - `control/tests/S2-05/helpers.ts`: `modulesWith` copies only `org`, `sync` and `metrics`. Copying every module
    brought in compliance's `notice_ack` handler (a duplicate-kind clash with the fake) and the broker's `ajv` import,
    which does not resolve from a temp dir.
  - `control/tests/S2-05/config.test.ts`: `killSwitch: false`, because S2-07's broker reads the kill-switch table and
    no switch is set.
- **Left red on purpose:** S2-08 SELFVIEW (2 tests) and RETENTION (1 test). These are real cross-slice gaps, not test
  artefacts, and fixing them takes S2-08 code and a grant migration. See #10 fix list items 1-2.

### Verify results on integration-wave-b (ce1a1e3)
- **`scripts/verify-all.sh` (Stage 1 plus s18 and s19): 27/27 slices pass.**
  - Includes s01 through s17, `s18-name-masking` (62 tests, founder 17/17 masked) and `s19-messaging-playbook` (71
    tests, founder fixture ok).
- **Brain suite** (as run by the s18 and s19 verify scripts): 1279 tests across 107 files, 1274 pass, 5 skip, 0 fail.
  Main had 1038, the s18 branch 1100 and the s19 branch 1208.
- **Control suites, each run on its own with `bun test tests/<id>`:**

  | suite | pass | fail | note |
  |---|---|---|---|
  | S2-01 | 245 | 0 | |
  | S2-05 | 108 | 0 | |
  | S2-06 | 100 | 0 | |
  | S2-07 | 134 | 0 | |
  | S2-08 | 149 | 3 | SELFVIEW catalog scan x2; retention.test "relation daily_aggregates already exists" |

  Running every control suite in one `bun test` process gives 724 pass and 8 fail. The 5 extra failures are
  cross-file harness interference, and they go away when the suites run separately as verify.sh does.
- **`scripts/verify-all.sh S2-`: 0/13 slices pass. This is expected, and it is not a regression.**
  - Every S2 verify.sh checks "migrations in my range only" and "out-of-scope paths untouched" against
    `S2_BASE...HEAD`. On a branch that carries six PRs, each slice therefore sees the others' migrations and paths.
  - The protected paths are in fact untouched: `git diff origin/main -- control/src/{app.ts,ports.ts,rbac,db,auth,audit,schema} control/tests/helpers schemas slices/S2-common engine web packages app` is empty.
  - S2-09 to S2-13 are not built yet.
  - Typecheck is ok, and each S2 suite is at least its minimum:

    | slice | tests |
    |---|---|
    | S2-01 | 245 |
    | S2-02 | 99 |
    | S2-03 | 108 |
    | S2-04 | 82 |
    | S2-05 | 108 |
    | S2-06 | 100 |
    | S2-07 | 134 |
    | S2-08 | 152 (3 failing, as above) |

  - Per-slice verify.sh on each PR branch alone is the real done-signal. The Summary table gives those results.

### Suggested merge order to main
1. #8 S2-06.
2. #12 S2-07, after its fix list.
3. #9 S2-05, after its fix list, carrying the two S2-05 test edits from ce1a1e3.
4. #10 S2-08, after its fix list, which must be done on top of S2-05/06/07. Carry the S2-01 loader edit.
5. #7 s18.
6. #11 s19, rebased onto s18, carrying the `names, playbook` resolution and the ADR renumbering.
