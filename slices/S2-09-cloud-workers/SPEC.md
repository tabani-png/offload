---
id: S2-09-cloud-workers
title: Cloud workers on Claude Managed Agents + overnight scheduling + morning digest
depends_on: [S2-06-registry (RegistryPort), S2-07-policies-broker (BrokerPort)]
parallel_safe: true
starts: wave C
human_gated: false
verify: bash slices/S2-09-cloud-workers/verify.sh
paths_in_scope: [control/src/modules/workers/**, control/migrations/09*.sql (0900-0999), control/tests/S2-09/**, control/package.json + control/bun.lock (add @anthropic-ai/sdk 1.3.0 pinned, same as brain; Scope changes note), slices/S2-09-cloud-workers/**]
paths_out_of_scope: [control/src/modules/{broker,policies,registry}/** (use ports), control core files, brain/**, web/**, schemas/** (frozen)]
---

# S2-09 cloud workers + overnight

## Summary
ADR 0105, ADR 0106 §4-7. Provides `WorkersPort` (`pauseFor(person|workflow)`, `interruptAll(scope)`).

## Design
- `managed-agents.ts`: narrow interface `ManagedAgentsApi` over `client.beta.{agents,environments,vaults,sessions,
  deployments}` (beta `managed-agents-2026-04-01`, set by the SDK); `FakeManagedAgents` for tests records every
  request and replays scripted event streams. The real client is created only when `OFFLOAD_CMA_REAL=1` (never in
  verify).
- Provisioning (`POST /v1/workers`): environment per tenant (`networking.type = "limited"`, `allowed_hosts` from the
  version's read connectors, `allow_mcp_servers: true`, package managers off); vault per job role with read
  credentials only; agent per workflow version: system prompt from SKILL.md + untrusted-content rules; tools:
  `agent_toolset_20260401` (`bash` always_ask, web tools disabled unless capability `web.research`, then
  `allowed_domains`), one `mcp_toolset` per read connector with `permission_policy: always_ask`, custom tools
  `offload_propose_batch`, `offload_report`, `offload_need_human`. No commit tool exists.
- Sessions: stream opened before the first event; `budget: {type: "limit", max_list_cost: {amount, currency: "USD"}}`
  from the role policy; MCP confirmations: `allow` only for Stage 1 read-allowlisted tools, else `deny` with
  `deny_message`; `offload_propose_batch` → `BrokerPort.proposeBatch` → custom tool result `{batchHash, state}`;
  `budget_reached` → run `capped`; lossless reconnect; cost from `session.usage`; run outcome row emitted to the
  metrics tables via the S2-05 handler interface (outcomes with `runtime: cloud`).
- Deployments: cron + IANA timezone; reject 01:00-03:59 local; pause after 2 consecutive failed runs; kill switch →
  `user.interrupt` to running sessions + pause deployments.
- Digest: `GET /v1/me/digest` assembles ran / waiting / auto-committed / trips / costs / suggestions (suggestions come
  from the person's devices later; v1 returns those stored by the Mac in a future kind, empty list now); digest email
  sending is out of scope (template only).
- Retention: delete sessions 30 days after run end (job).
- Tables (0900-0999): workers, worker_runs, deployments, session_cursors.

## Acceptance (tag = test name prefix in control/tests/S2-09/)
- PROVISION: recorded create requests match the expected shapes (limited networking, allowed_hosts, always_ask MCP,
  custom tools present, no commit-capable tool name in any toolset, budget present).
- SESSION: stream-first ordering; reconnect without duplicate handling; run state transitions.
- CONFIRM: read-allowlisted MCP tool allowed; any other MCP tool denied with plain reason; Composio meta tools denied.
- CUSTOM: propose_batch reaches the broker and returns its hash; nothing is committed without approval.
- BUDGET: budget_reached → capped outcome, broker untouched beyond approved items; tenant monthly cap blocks new sessions.
- SCHEDULE: valid cron accepted; 02:30 local rejected; DST-safe next-run; auto-pause after 2 failures.
- KILL: interrupt sent to every running session in scope; deployments paused; queued batches remain.
- INJECTION: scripted session where fetched content asks to email a new address → broker rejects
  `recipient_not_allowed`, breaker trips, digest shows the trip.
- DIGEST: digest validates against schema; costs sum.
- HERMETIC: no `new Anthropic(` outside managed-agents.ts; OFFLOAD_CMA_REAL never set in tests.

## Done-signal
`verify.sh`: typecheck, ≥ 70 tests, tags, hermetic greps, migration range, S2-01/S2-07 suites green.
