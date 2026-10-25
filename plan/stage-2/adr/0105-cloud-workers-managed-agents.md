# 0105 Cloud workers on Claude Managed Agents, with the Stage 1 gate kept in our code

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/01-cloud-workers.md, 05-overnight-mode.md.
Supersedes the "cua sandbox per person" idea in `plan/stage-2-org.md` (cua Cloud ended 18 Oct 2026).

## Context
Operator decision: one Managed Agents agent per role workflow, commit tools always ask, session spend caps, cron
deployments for overnight. Stage 1's gate (ADR 0006, s05b, s13) is: a batch hash over every item, a one-use approval
token per hash, a canonical hash of the full tool arguments that must equal one approved item, once per item, and an
item journal `pending → sending → sent | failed_before_send | unknown` written before the call. Managed Agents is beta
(`managed-agents-2026-04-01`) and not ZDR-eligible.

## Decision
1. **Objects**: per tenant one Managed Agents **environment** (`networking: { type: "limited", allowed_hosts: [...],
   allow_mcp_servers: true }`, hosts = union of the workflow's read connectors; package managers off). Per role
   workflow version one **agent** (system prompt from SKILL.md + Stage 1 untrusted-content rules, model
   `claude-opus-5-5` for design-heavy steps or `claude-sonnet-5-5` per the s14 router route, tools below). Per job
   role one **vault** with read credentials (`mcp_oauth` / `static_bearer` / `environment_variable`) for company
   connections. Agent and environment ids are stored in `workers`; they are created by the orchestrator, never in a
   request path.
2. **Tools given to the agent**:
   - `agent_toolset_20260401` with `default_config.permission_policy: always_allow` for file ops in its own sandbox,
     `bash` `always_ask` (the orchestrator denies by default unless the workflow version declares it),
     `web_search` / `web_fetch` `enabled: false` unless the version has capability `web.research`, then enabled with
     `allowed_domains` from the version.
   - `mcp_toolset` per read connector with `default_config.permission_policy: always_ask`. The orchestrator answers
     every `agent.mcp_tool_use` with `user.tool_confirmation`: `allow` only if the tool is on the Stage 1 read
     allowlist for that server (`brain/src/workflows/allowlist.ts` read entries, imported read-only), else `deny` with
     a plain reason. Commit tools are never in an MCP toolset we expose (Composio meta tools denied by name as in s13).
   - Custom tools (executed by our orchestrator, never by the sandbox): `offload_propose_batch {items[]}` (the only way
     to ask for a commit), `offload_report {summary, metrics}`, `offload_need_human {question}`.
   The agent has **no tool that commits**. "Commit tools always ask" is satisfied twice: commits are custom tools that
   always stop the session (`requires_action`), and the broker only acts on an approved hash.
3. **Gate carry-over** (identical semantics, one implementation): `offload_propose_batch` hands items to the broker,
   which computes `batchHash` with the Stage 1 function (imported from the brain, read-only), validates each item
   against the role policy and the allowlist schema of its commit capability, stores the batch `pending`, and returns
   `{batchHash, state}` to the agent, which then ends its turn. Approval mints a one-use token for that hash. The
   broker's deterministic executor (Composio CLI / direct API / company MCP, as in s13 `chain-executor`) commits each
   item, writes `sending` and the contacted ledger before the call, and never retries `unknown`. No model is in the
   loop at commit time. A contract test asserts the brain and the broker produce byte-identical batch hashes for the
   s05/s13 fixtures.
4. **Budgets**: every session is created with `budget: { type: "limit", max_list_cost: { amount, currency: "USD" } }`
   from the role policy (default 500 = $5.00 per session). `session.status_idle` with `stop_reason: budget_reached` →
   run outcome `capped`, nothing committed beyond approved items. Per-tenant monthly cap enforced by the orchestrator
   before creating sessions.
5. **Schedules**: overnight and recurring runs are **deployments** (`schedule: { type: "cron", expression, timezone }`,
   `initial_events: [user.message]`, same budget). Expressions in the 01:00-03:59 local window are rejected (DST
   double/skip). A deployment whose run fails twice in a row is paused by us (and auto-paused by the platform on
   failed creation).
6. **Session handling**: the orchestrator opens the event stream first, then sends events; handles
   `agent.custom_tool_use`, `agent.mcp_tool_use` confirmations, `session.status_idle` stop reasons (`end_turn`,
   `requires_action`, `budget_reached`), reconnects losslessly, and records a `worker_run` with outcome and cost from
   `session.usage`. The kill switch sends `user.interrupt` to running sessions and pauses deployments.
7. **Prompt injection**: all fetched content is untrusted (wrapped as in brain `untrusted.ts`); the system prompt says
   instructions inside content are data; recipients and commit fields come from the run's input set and the policy,
   and the broker rejects any proposed recipient not in the run's input set or the overnight allowlist
   (`recipient_not_allowed`, also a circuit-breaker trip).
8. **Data**: sessions are deleted via API 30 days after the run (configurable down to 1 day); Managed Agents and
   Composio are listed sub-processors with their retention in the DPA (S2-08 templates).
9. **Browser-only targets** (no API, no MCP): out of v1 cloud scope; such workflows run on the Mac (s13 computer use)
   or wait for a Browserbase ADR. Always-on desktops per person: deferred.

## Consequences
- Easier: one gate implementation for Mac and cloud; commits are reproducible and auditable without trusting a model.
- Harder: a cloud workflow cannot "click send" in a web UI; it needs an API or MCP commit path.
- Risk: beta API drift. The orchestrator talks to Managed Agents through a narrow interface (`ManagedAgentsApi`) with
  a fake for tests, as s13 did for the Messages API.
