# 0112 Cloud workers (S2-09): contract notes where ADR 0105/0106 and the frozen schemas are silent

Date: 2026-10-26. Status: proposed (S2-09 builder; for the coordinator). Amends nothing frozen: every point below fits
`schemas/stage2/*` and `API.md` as they are; it records the choices S2-09 made where they were silent.

## 1. Read connectors are MCP servers with a URL
A read step runs in the cloud only through an `mcp_toolset`. Its binding's connection must hold the MCP server URL
in `connections.external_ref` (`https://...`); anything else fails provisioning (`worker.state = failed`, reason in
the audit event). The server is named after the connection kind (`gmail`, `google_workspace_shared` → `gmail`,
`composio_org` → `composio`, others `c_<8 hex of the connection id>`) and maps to the Stage 1 catalog ids
(`gmail` → `[gmail]`, `composio` → `[gmail, google-sheets, google-calendar]`, others `[]`), so the Stage 1 read
allowlist (`brain/src/workflows/allowlist.ts`, read entries only) answers every confirmation. A server with no catalog
ids has no read tool: every call on it is denied. `allowed_hosts` = the URL hosts of the read connections.

## 2. Toolsets expose read tools only
Each `mcp_toolset` has `default_config: {enabled: false, permission_policy: always_ask}` and one enabled
`always_ask` config per Stage 1 read tool of its server. A commit tool is therefore not in any toolset; a confirmation
for a tool outside the list (or a Composio meta tool, `^COMPOSIO_`, multi-execute, workbench, remote bash, proxy) is
still answered `deny` with a plain `deny_message`.

## 3. Vault credentials
The control plane never holds connection secrets (plan threat model). A vault per job role is created empty; its read
credentials are added by an injected `CredentialSource` (deployment wiring: the tenant's OAuth / KMS path). Without
one, no credential is created and the MCP server must authenticate on its own. Commit connections are never asked for.

## 4. Provisioning runs outside the request
`POST /v1/workers` stores the worker as `provisioning` and returns it; the orchestrator creates the environment,
vault, agent and deployment right after (and the `workers.reconcile` job retries). While provisioning,
`externalRefs` are `{agentId: "", agentVersion: 1, environmentId: "", deploymentId: null}` (the frozen schema
requires `agentVersion >= 1`).

## 5. Cloud run outcomes reach the metrics tables through the S2-05 sync handler
`run_outcomes` is keyed by a device. Each person who runs cloud workers gets one device row named
"Offload cloud" in state `revoked` (no usable key, so it can never authenticate); cloud outcomes are stored through
the metrics module's `syncHandlers.run_outcome` as that device with `runtime: "cloud"`. Run states map to outcomes:
`done` and `waiting_approval` → `success`, `capped` → `capped`, `failed` → `failed`, `interrupted` → `cancelled`.

## 6. Template hash for cloud runs
A cloud version has no facts values or tone card (stripped at promotion), so its overnight `templateHash` is
`sha256(SKILL.md)` of the version. An overnight policy pins that value.

## 7. Schedules and money
- A cron is 5-field POSIX; any hour in 1-3 is rejected (`400 validation_failed`), so 01:00-03:59 local never fires.
  Next-run: the first local wall-clock match after now; a skipped local time (DST gap) is skipped, a repeated one
  fires once (the first instant).
- A deployment run fails if its session could not be created or ended `failed`; two in a row pause the deployment
  and the worker, and each result is reported to the run's overnight policy (`reportRunResult`).
- Tenant monthly cap: a new session is refused (`409 budget_exceeded`) when this month's cloud cost (tenant reporting
  timezone) plus the session budget would exceed `tenants.monthly_worker_budget_cents`; 0 means no cloud sessions.
- A session budget may not exceed the job role's `sessionBudgetCents`.

## 8. Kill switch reaches the cloud through a sweep
The broker's kill route calls `WorkersPort.pauseFor` for person scope. Every scope (tenant, person, workflow) is also
enforced by the orchestrator: before handling each session event and on the `workers.kill_sweep` job it asks
`BrokerPort.killSwitchActive` for each running run and active deployment, sends `user.interrupt` and pauses the
deployment. Queued batches are left as they are (the broker revokes their tokens).

## 9. Morning digest window
`GET /v1/me/digest?day=D` covers runs started from 12:00 on D-1 to 12:00 on D (tenant reporting timezone) where the
person is the runner. `waiting` lists every batch of the person's cloud runs that is still `pending`, whatever its
age. `trips` are the breaker trips the orchestrator observed in that window. `suggestions` is empty until the Mac
sends them. Sending the digest email is out of scope; `digestText()` renders the template.

## 10. A person worker sends through the person's own connection
The broker sends as a person only through that person's own personal-allowed connection, and a role workflow binds
company connections only, so a worker whose identity is a person never commits through the workflow's commit binding.
`POST /v1/workers` takes an optional `commitConnectionId` for a person identity: one of the person's own
personal-allowed sending connections (not `linkedin_personal`). Omitted, the person's only such connection is used;
none or several is `409`. A role identity sends through its own connection, so naming one there is `400`.

## 11. Lock order
Worker rows are step 9 of the broker's lock order (broker.ts header). Within it: the tenant's run-admission advisory
lock `offload_workers_budget:<tenant>`, the runner's cloud-device advisory lock, then `worker_runs`, then `workers`,
then `deployments`, rows of one table in id order; audit events after the last row lock. Broker calls made inside
worker transactions only read and queue no audit event. The monthly cap's check and its reservation (the run insert)
run under the admission lock, for manual starts (the run route takes it before its worker row) and for scheduled runs
the platform started (deployment polling).

## 12. Durable intent, confirmed delivery, restart recovery
- Nothing is marked done before the remote call succeeded. An interrupt is requested in the deciding transaction
  (`worker_runs.interrupt_sent_at`: kill sweep, `WorkersPort.pauseFor` in the caller's transaction, monthly cap on a
  scheduled run, a run ended because its stream was lost) and confirmed by `interrupt_delivered_at` once Managed
  Agents accepted the `user.interrupt` (or the session no longer exists). Every sweep retries due undelivered
  interrupts (30 s doubling, at most 15 min). While an interrupt is requested no event of the run is acted on.
- A run whose session is not recorded yet is interrupted by delivering the interrupt instead of the first message.
- `workers.recover` (every minute, so also the first minute after a start, and at the start of every reconcile tick)
  re-attaches a consumer to every unfinished run with a recorded session, fails a run whose session id is still
  unrecorded 10 minutes after it started (`session_not_recorded`; such a session never got its first message, so it
  is idle) which releases its reserved budget, delivers pending interrupts and reports ended runs whose result has
  not reached their overnight policy (`policy_reported_at`; act then mark, so a crash can only report twice).
- Stopping the process never ends a run: consumers stop, the sessions keep running, recovery re-attaches.
- One orchestrator process per tenant (event handling is exactly-once per process via `session_events`).
- Residual: a deployment created on Managed Agents whose id was not recorded (crash between create and record) is not
  found again; the recorded contract has no list-deployments call. Environments, vaults and agents left the same way
  are inert.
