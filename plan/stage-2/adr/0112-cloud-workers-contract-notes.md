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
lock `offload_workers_budget:<tenant>`, the per-worker sync advisory lock `offload_worker_sync:<worker>` (then
`offload_worker_provision:<tenant>` while provisioning), the runner's cloud-device advisory lock, then `worker_runs`, then `workers`,
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
- A recorded session whose first message was never sent (process stopped in between) gets it from recovery: the
  message is stored with the session id (`first_message`), `first_sent_at` marks it sent, and before sending,
  recovery checks the session's event log for a user.message so it is never sent twice.

## 13. Remote creates: serialized, never repeated blindly
The recorded contract has no idempotency key (`idempotencyKey` is a no-op in @anthropic-ai/sdk 1.3.0) and no list
calls for deployments, sessions, agents, environments or vaults. So every create is sent once (`maxRetries: 0`), and:
| create | serialized by | after an unanswered create / a crash before the id is recorded |
|---|---|---|
| deployments | `offload_worker_sync:<worker>`, held over the remote calls by every sync path (reconcile, kill sweep, auto-pause, `PATCH /v1/workers/:id`) | `deployments.create_key` is committed before the call and sent as metadata `offload_create_key`. A 4xx clears it (nothing made). No answer keeps it: no second create, ever; audit `worker.deployment_unconfirmed` and a log line, once. A person finds the deployment in the Console by that metadata, archives it (or records its id), then clears `create_key` and `create_alerted_at`. |
| sessions | one opener per run (`dispatchRun`), recovery skips runs being opened | a session without a recorded id never got its first message, so it is idle; recovery fails the run after 10 minutes and frees its budget |
| agents | worker sync lock + `offload_worker_provision:<tenant>` | the worker stays `provisioning`; the next reconcile creates another agent; the orphan is configuration only (no session runs on it) |
| environments | `offload_worker_provision:<tenant>` | the next reconcile creates another; the orphan is inert |
| vaults | `offload_worker_provision:<tenant>` | the next reconcile creates another; the orphan holds no credential (credentials are added after the vault is recorded) |
| vault credentials | `offload_worker_provision:<tenant>` | recorded one by one: at most the one in flight is created again in the same vault |
Gap (contract): an unconfirmed deployment is detected and flagged but cannot be found or paused automatically until the
contract offers a list or idempotent create; it is the one orphan that can schedule paid sessions.

## 14. A scheduled run passes the gates a manual run passes, and keeps passing them
| gate | manual run (route, `startRun`) | scheduled run, at admission (deployment polling) | active deployment / running session (every sweep, every actionable event) |
|---|---|---|---|
| kill switch (tenant, person, workflow) | 409 `kill_switch_active` | run stopped (`kill_switch_active`) | sweep interrupts sessions and pauses the worker and its deployment; events are not acted on |
| worker state `ready` | 409 | run stopped (`worker_not_ready`) | the sync pauses the deployment of a worker that is not ready |
| eligibility (`registry.isRunnableBy`: live version, identity runs it) | 409 | run stopped (`ineligible`), deployment held (`hold_reason = ineligible`) | sweep interrupts sessions of an ineligible worker and holds its deployment; released when eligible again; events are not acted on |
| tenant monthly cap | 409 `budget_exceeded` (admission lock) | run stopped (`budget_exceeded`), deployment held (`hold_reason = budget_exceeded`) | sweep holds the deployment while one more session would exceed the cap; released next month or on a raised cap |
| role session budget | at worker create / PATCH | fixed in the deployment's budget | the platform enforces `max_list_cost` |
| consent, overnight policy, approval, commit binding | the broker, at propose and before every call | the broker, same | the broker, same |
A stop is an interrupt requested with the run and confirmed on delivery (§12); a hold is `deployments.hold_reason`,
which the sync turns into a remote pause (desired vs remote, retried every tick).
Gap (contract): read credentials live in the job role's vault and the recorded contract has no credential delete, so
an ineligible worker's access is cut by pausing its deployment, interrupting its sessions and refusing admission;
the credentials are not revoked.

## 15. Admitted values are snapshots; remote objects are drained before they are forgotten
Values fixed at admission and used later come from the run, not from the worker as it is now:
| value | fixed at | used later by |
|---|---|---|
| session budget | `worker_runs.budget_cents` (manual: the worker's at admission; scheduled: the deployment's, `remote_deployments.budget_cents`) | session create, monthly cap, scheduled admission |
| model, tools, MCP servers | the agent version pinned at provisioning (`workers.agent_version`, `mcp_servers`) | every session of the worker |
| identity, commit connection | immutable worker columns | broker proposals |
| overnight policy | `worker_runs.overnight_policy_id` at insert | broker; the policy's own state (paused, tripped) is read live on purpose: a stricter state applies at once |
| bash permission | the version's bindings, read when the consumer attaches | tool confirmations of that consumer |
Remote objects that may still act are tracked until they cannot: every deployment Offload made is a
`remote_deployments` row, polled until it is drained (archived on the platform, listed at least once after the
archive, every session it started imported as a run and ended). Kill sweeps, recovery and retention act on those
runs. Sessions are tracked as runs until retention deletes them; environments, vaults and agents do not act on
their own (§13).
The default digest day is `digestDayOf`: the local calendar day, or the next one from local noon on, the same rule as
`windowOf` (DST-safe, including changes at midnight).

## 16. A stopped run sends nothing; a lost session stays reserved; catch-up uses no time cursor
- Every user event Offload sends to a session (first message, tool confirmation, custom tool result) goes through
  `sendUnlessStopped`: the run's row lock is held across the send, and the send is skipped when the run has ended or
  its interrupt is requested. Every interrupt request updates that row, so a request is either seen before the send or
  waits for it and is delivered after it. `user.interrupt` itself is the only event sent without the check.
- A run ended because Offload lost its session (`stream_lost`, `stream_unavailable`, `orchestrator_error`) is
  `session_unsettled` (migration 0905): `monthSpent` keeps its whole budget reserved until `settleLost` (each sweep
  and recovery) confirms the session stopped (terminated, deleted, or idle after the interrupt was delivered) and
  records its final cost.
- Session catch-up lists the whole event log and skips handled event ids. The list filter `created_at[gte]` compares
  `processed_at` (SDK 1.3.0 docs), and an event processed late can sort before one already handled, so no time cursor
  is safe. Deployment runs are polled `created_at[gte]` the newest `created_at` seen (the field that filter compares)
  and deduplicated by `deployment_run_ref`.

## 17. A settled cost reaches every consumer once; imported runs keep the platform start time
- `settleLost` writes the final cost, re-emits the run's outcome (metrics keep the latest seq per run) and adds the
  cost the run's overnight policy has not counted (`policy_cost_cents`, migration 0906) to that policy's night counter,
  all in one transaction. `reportPolicy` records the cost it reported in its mark and adds any growth in the same
  transaction. The counter increment is written here, not through `reportNightSignals`: the broker port cannot join
  the transaction that moves the mark, and that cost path evaluates no breaker.
- A scheduled run imported by `pollDeployments` starts at the deployment run's `created_at` (never later than now),
  so its digest window, its month and its outcome follow the platform's start.
- `offload_report` says the summary is recorded with the run (the run DTO shows it); the digest schema has no field
  for it.

## 18. Worker questions reach a person (operator-approved schema change, 2026-10-26)
The operator approved adding `questions` to two frozen Stage 2 schemas on 2026-10-26 (PR #19, Codex on 86d4dd0):
- `worker-run.schema.json`: `questions`, a list of `{question, askedAt}` (at most 20, oldest first).
- `digest.schema.json`: `questions`, a list of `{runId, workflowId, question, askedAt}`: every question the person's
  workers asked in the digest window, by the time asked (a run still running included), at most 200.
Both are optional properties (`additionalProperties` stays false), so earlier fixtures stay valid; the control plane
always sends them. Each item carries its run, workflow, text and time so a chat surface can show it as a message.
The time is `worker_runs.question_asked_at` (migration 0907), written by the same statement as `questions`, in the
same order. `offload_need_human` tells the agent a person will see the question only after that statement stored it;
the 21st question of a run is not stored and the agent is told so (`limit_reached`).

## 19. No trusted recipients is the empty set (fail closed)
Every run has a recipient input set, never a missing one: a manual run's is its `inputs.recipients` or `[]`, a
scheduled run's is `[]` (its overnight allowlist, if a policy is active, is the only other source). `propose` always
passes it to the broker, and `worker_runs.input_recipients` is `NOT NULL DEFAULT '[]'` (migration 0908). The broker
skips its recipient check when `ProposeRun.inputRecipients` is undefined (broker.ts, out of S2-09's scope), so a
missing set would let a worker propose an address it read in fetched content. Broker-side follow-up: make that field
required, or treat a missing set as empty.
