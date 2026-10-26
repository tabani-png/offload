# broker + policies (S2-07)

The only component that commits (ADR 0105 §3, ADR 0106). Tables: `migrations/0700_policies_broker.sql`.

## Reaching it from another module
`deps.ports.broker` is the full broker once routes are mounted; `brokerOf(deps.ports)` returns it typed (`Broker` in
`broker.ts`). The frozen `BrokerPort` in `ports.ts` names only `revokeTokensOf` and `killSwitchActive`; the rest are
extra members of the same object:

| member | for | notes |
|---|---|---|
| `proposeBatch(tenantId, run, items)` | S2-09 `offload_propose_batch` | opens its own transaction; never throws for a policy refusal, returns `{ok:false, code, message, tripped}` |
| `approve(tx, principal, hash, req)` | `POST /v1/batches/:hash/approve` | returns the one-use token to the caller in process only |
| `commitApproved(tenantId, hash, token)` | after an approval | spends the token, schedules items, runs the due ones |
| `runDue(tenantId, hash?)` | job `broker.commit_due` | sends approved items whose send-window time has come |
| `reconcile(tenantId)` | job `broker.commit_due` | `sending` older than 10 min → `unknown` (never retried) |
| `policyChanged(tx, policyId, change)` | policies module (PATCH) | narrowing unlinks unsent policy approvals; widening makes tonight dry |
| `revokeTokensFor(tx, person)`, `stopRunsFor(tx, person)` | S2-10 offboarding | revoke unspent approvals; pause the person's overnight policies and workers |
| `reportNightSignals`, `reportRunResult` | S2-09 | bounce rate, negative replies, cost, consecutive failures → breakers |
| `killSwitchActive(tx, {personId?, workflowId?})` | everyone | an unscoped question (`{}`) fails closed (`true`); `tenantKilled(tx)` asks about the tenant switch alone |

## Items
A Stage 2 item is `{key, capability, fields}`. Fields map losslessly to a Stage 1 `BatchItem` (`stage1.ts`):
`to`, `subject`, `body` (required, once each), optional `verb`, and every other label is a commit field in order.
`key` is the lowercased recipient. The batch hash is the brain's `batchHash(workflowId, "live", items)`.

## Run context the orchestrator supplies (trusted code, never the model)
`connectionId` (the commit connection), `identity` + `runnerPersonId`, `inputRecipients` (ADR 0105 §7),
`templateHash`, `recipientTimezones`, `threadsStartedByIdentity`, `overnight` + `overnightPolicyId`.

## Executors
`ComposioCliExecutor` (`composio execute <SLUG> -d <json> --account <external_ref>`), `McpExecutor`, `ApiExecutor`,
each with an injected transport. None is configured by default: an approved item with no executor for its connection's
provider is `failed_before_send`. Wiring real transports is a deployment step (`broker.configure({executors})`).

## Scheduler (who calls `runDue` and `reconcile`)
This slice. The module declares `jobs: [commitDueJob]` (`broker.commit_due`, every minute): `reconcile`, then
`runDue`, once per tenant. `Job.run(deps)` carries no tenant, so the runner passes it as a second argument
(`commitDueJob.run(deps, tenantId)`); without one the job refuses. The core has no job runner yet: whoever runs module
jobs (S2-12 or ops) runs this one per tenant. S2-09 does not call `runDue` or `reconcile` (ADR 0112 §7).

## Wave B review rules (ADR 0112)
Pausing or narrowing a policy unlinks its unsent approvals, and execute refuses a policy token whose policy is not
active. Any trust-widening edit restarts the dry-run nights; fewer than 3 is an owner/admin decision; a tripped night
does not count. Duplicate recipients after normalisation are refused; an unreleased `unknown` in another batch holds
the recipient at execute too. Audit detail and item errors carry `itemRef` and a scrubbed reason, never an address
or domain. Migration 0701 makes item content and token use immutable for `offload_app`.
