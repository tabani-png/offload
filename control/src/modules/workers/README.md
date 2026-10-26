# workers (S2-09)

Cloud workers on Claude Managed Agents (ADR 0105, ADR 0106 §4-7, ADR 0112). Tables: `migrations/0900_workers.sql`.
It drafts; it never commits. Every commit is a broker action over a batch approved by hash.

| file | what |
|---|---|
| `managed-agents.ts` | `ManagedAgentsApi`, the narrow interface over `@anthropic-ai/sdk` 1.3.0 `client.beta.*`; the only `Anthropic` client construction. Real API only with `OFFLOAD_CMA_REAL=1` and `ANTHROPIC_API_KEY`. |
| `fake-managed-agents.ts` | `FakeManagedAgents`: the API faked at the HTTP boundary (the real SDK runs over its `fetch`), checked against `cma-contract.json`, scripted event streams. Tests only. |
| `tools.ts` | environment / agent request bodies, the custom tools, the MCP confirmation rule (Stage 1 read allowlist, brain, read-only). |
| `orchestrator.ts` | provisioning, deployments, sessions and the SSE consumer, custom tools → broker, kill sweep, retention, run outcomes. |
| `cron.ts` | 5-field cron, the 01:00-03:59 rule, DST-safe next run. |
| `routes.ts`, `digest.ts` | `/v1/workers*`, `/v1/worker-runs/:id`, `/v1/me/digest`. |

## Reaching it from another module
`deps.ports.workers` is the full orchestrator once routes are mounted; `workersOf(deps.ports)` returns it typed. The
frozen `WorkersPort` names only `pauseFor(tx, personId)`; `interruptAll(tenantId, scope)`, `sweep(tenantId)` and the
rest are members of the same object.

## Jobs (once per tenant: `job.run(deps, tenantId)`)
`workers.reconcile` (*/5), `workers.poll_deployments` (every minute), `workers.kill_sweep` (every minute; also retries undelivered interrupts),
`workers.recover` (every minute: re-attaches unfinished sessions after a restart, ADR 0112 §12),
`workers.session_retention` (04:40 UTC, sessions deleted 30 days after the run ended; `configure({retentionDays})`
down to 1).

## Wiring for a deployment
`workersOf(deps.ports).configure({ api, credentials })`: `api` defaults to `managedAgentsFromEnv()`; `credentials`
(read credentials for a job role's vault) defaults to none.
