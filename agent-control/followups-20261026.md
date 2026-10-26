# Follow-ups from wave B/C fixes (2026-10-26)

Found while fixing and reviewing PRs in waves B and C. Security items fold into S2-12.

| # | Item | Source PR | Area | Owner | Status |
|---|---|---|---|---|---|
| 1 | Frozen slice verify.sh scope checks diff from a fixed BASE; after merging main into a branch they flag main's files. Use merge-base with origin/main. | #17, #21, #22 | tooling | manager | open |
| 2 | Agents share /tmp log names; one overwrote another's verify log. Use unique log names. | n/a | tooling | manager | open |
| 3 | Shared Postgres test DB used by parallel control suites gives one-off "tuple concurrently updated" flakes. Use a per-agent DB or schema. | n/a | tooling | manager | open |
| 4 | Brain-wide: no pattern secret redaction outside builder (executor tool errors, CRM log lines, router steps/ledger, tone pack, context store, dry-run batches). | n/a | security/S2-12 | manager | open |
| 5 | Brain-wide subprocess spawns inherit full env or have no timeout: vision/claude.ts security cmd, sync/client.ts `open <url>` (check https-only), observer-route no timeout, osa-driver, MCP stdio no timeout. | n/a | security/S2-12 | manager | open |
| 6 | workflow-routes.ts:89 NaN Content-Length (low). | n/a | security/S2-12 | manager | open |
| 7 | Brain sync: Connect while a sign-in is pending returns the old URL without reopening. | #22 | correctness | manager | open |
| 8 | Outbox purge after 7 days paused/offline deletes queued notice_ack / workflow proposal; never re-queued. | #15 | correctness | manager | open |
| 9 | s13: MCP probe never serves app targets (Granola, Linear); computer use advertises only `sends`, not `logs`. | n/a | correctness | manager | open |
| 10 | Product decision: deleting a workflow also deletes its contacted ledger (do-not-contact-twice memory). | n/a | product | operator | open |
| 11 | s20 key-mode marker is sticky (plain home stays on file keys even if observer is later installed). | n/a | correctness | manager | open |
| 12 | s23 contract F1-F4 interpretations need an operator taste check (human-queue). | n/a | product | operator | open |
| 13 | No disconnect / withdraw-consent route in brain sync or app (employee right to withdraw). Needs brain route + app control. | #22 | product | manager | open |
| 14 | s13 connectors/targets.ts static catalog hosts (Zendesk `.zendesk.com`, Salesforce): OsaDriver.open tries `https://.zendesk.com/`; chain executor computer use uses static hosts. | #15 | correctness | manager | open |
| 15 | S2-07: revokeTokensOf/For, stopRunsFor, policyChanged flush audits (take audit lock) before returning; S2-10 offboarding must take its row locks BEFORE calling them (lock order step 10). Document in README/ports.ts. | #27 | correctness | manager | open |
| 16 | BEFORE enabling live batches for plan workflows: bind computer-use commits to the target bundle id / frontmost app (executor.ts ~149, osa-driver.ts 109); commit hash binds only {verb, fields}. Also parallel send+log in one turn lets log through while send is 'sending'. | #15 | security/S2-12 | manager | open |
| 17 | S2-05 P3s: small_baseline anomaly per version uses workflow-level listed() (hours.ts:107-111), pass version-level behind; topWorkflows cross-workflow differencing (company total minus listed WFs = long-tail WFs incl. <floor) needs complementary suppression across workflows or ADR acceptance; ADR sentence on single-sender baseline edge case. | #9 | correctness | manager | open |
