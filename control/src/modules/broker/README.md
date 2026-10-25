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
| `runDue(tenantId, hash?)` | scheduler, per tenant | sends approved items whose send-window time has come |
| `reconcile(tenantId)` | scheduler / startup | `sending` older than 10 min → `unknown` (never retried) |
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
