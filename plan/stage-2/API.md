# Control plane API (Stage 2, v1)

Status: proposed 2026-10-25, frozen for S2 builders. Schemas: `schemas/stage2/` (`$id` prefix `offload/stage2/`).
Decisions: ADR 0101-0110. Implemented by `control/`; the permission matrix below is implemented once, as data, in
`control/src/rbac/permissions.ts` (S2-01) and tested row by row.

## Conventions
- Base path `/v1`. JSON only (`application/json; charset=utf-8`), UTF-8. Timestamps are epoch ms (`common#tsMs`),
  days are `YYYY-MM-DD` in the tenant's reporting timezone. Money in USD cents. Durations in whole seconds.
- Every request body and response is validated against its schema (Ajv 2020-12, `additionalProperties: false`).
  An unknown field is `400 validation_failed`.
- Errors: `error.schema.json` with `code` from its enum. Status map: 400 validation_failed, 401 unauthorized,
  403 forbidden / feature_disabled / consent_missing, 404 not_found (also for resources outside your scope: we do not
  reveal existence), 409 conflict / forbidden_binding / hash_mismatch / token_used / kill_switch_active,
  422 group_floor, 429 rate_limited (with `Retry-After`), 500 server_error.
- Lists: `?cursor=&limit=` (limit 1..200, default 50; outside that range is `400 validation_failed`). Every endpoint
  written `→ x[]` below answers `{ "items": x[], "page": common#/$defs/page }`; `page.nextCursor` is opaque and `null`
  on the last page. (Decided 2026-10-25 with S2-04.)
- Tenant comes only from the credential. No endpoint takes a tenant id from the client.
- Every mutation and every per-person read writes an `audit-event` in the same transaction (ADR 0108 §5).
- Idempotency: mutations accept `Idempotency-Key` (ULID); repeats within 24 h return the first response.

## Authentication
| credential | how | used by |
|---|---|---|
| Web session | `GET /auth/login` → WorkOS AuthKit → `GET /auth/callback` sets `__Host-offload_session` (httpOnly, Secure, SameSite=Lax). Mutations need header `X-CSRF-Token` = value from `GET /auth/session`. `POST /auth/logout`. | admin web, self-view |
| Device token | `POST /v1/devices/challenge` → nonce; `POST /v1/devices/token` with ES256 signature over the nonce → JWT (15 min, aud `device`) as `Authorization: Bearer`. Sync bodies also carry `Offload-Signature: keyid=<deviceId>, sig=<b64url ES256 over JCS body>`. | Mac brain sync client |
| WorkOS webhook | `WorkOS-Signature` header verified with the tenant-independent webhook secret. | directory sync |
| Service | in-process only (worker orchestrator → broker); no HTTP credential exists. | S2-09 |
| Digest link | signed single-purpose URL (HMAC, 24 h, one use) for kill switch and open-digest only. | email digest |

## RBAC matrix
Columns: O owner, A admin, L dept_lead, M member, U auditor, D device. Cells: `T` whole tenant, `Dp` own departments
only, `S` self only, `F:x` only when sensitive feature x is enabled for the subject's jurisdiction (otherwise 403
feature_disabled, or the cell is suppressed), `-` denied. Group floor (ADR 0103 §5) applies to every aggregate
regardless of role.

### Auth, devices, sync
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /auth/session | → `{person: person, csrfToken}` | S | S | S | S | S | - |
| POST /v1/devices/enrollment-codes | → `{code, expiresAt}` | S | S | S | S | - | - |
| POST /v1/devices/enroll | device-enrollment#request → #response (code is the credential) | - | - | - | - | - | code |
| POST /v1/devices/challenge | `{deviceId}` → device-enrollment#challenge | - | - | - | - | - | key |
| POST /v1/devices/token | device-enrollment#tokenRequest → #tokenResponse | - | - | - | - | - | key |
| GET /v1/devices | → device[] | T | T | - | S | - | - |
| DELETE /v1/devices/:id | revoke | T | T | - | S | - | - |
| GET /v1/sync/config | → device-config | - | - | - | - | - | S |
| POST /v1/sync/batches | sync-envelope → sync-receipt | - | - | - | - | - | S |

### Self-view (any signed-in person, about themselves only)
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/me/data | → self-view | S | S | S | S | S | - |
| GET /v1/me/access-log | → audit-event[] where subject = me | S | S | S | S | S | - |
| POST /v1/me/notices/:id/ack | → notice-ack | S | S | S | S | S | - |
| GET /v1/me/export | → self-view (download) | S | S | S | S | S | - |
| POST /v1/me/correction-requests | `{field, message}` → `{id}` | S | S | S | S | S | - |
| GET /v1/me/digest?day= | → digest | S | S | S | S | - | - |
| POST /v1/me/baselines/:workflowId/:version/estimate | `{seconds}` (grade C user estimate) | S | S | S | S | - | - |

### Org
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/tenant | → tenant | T | T | T | T | T | - |
| PATCH /v1/tenant | partial tenant (groupFloor upward only, retention downward only) | T | T (not identityAddon, not budget) | - | - | - | - |
| GET /v1/departments | → department[] | T | T | T | T | T | - |
| POST /v1/departments, PATCH/DELETE /v1/departments/:id | department | T | T | - | - | - | - |
| GET /v1/people | → person[] (name, department, access role, state only for L) | T | T | Dp | - | T | - |
| GET /v1/people/:id | → person | T | T | Dp | S | T | - |
| PATCH /v1/people/:id | `{accessRole?, departmentId?, deptLeadOf?, jobRoleIds?, jurisdiction?, leavingOn?}`; owner role only by O; last owner 409 | T | T (not owner) | - | - | - | - |
| POST /v1/people/invite | `{email, displayName, departmentId, jurisdiction}` → person | T | T | - | - | - | - |
| GET /v1/job-roles, POST, PATCH /v1/job-roles/:id | job-role | T | T | Dp (read; write own dept) | read | read | - |
| GET/POST /v1/role-identities, PATCH/DELETE /:id | role-identity | T | T | Dp read | - | read | - |
| POST /v1/support-grants | `{hours ≤ 72, readOnly}` | T | - | - | - | - | - |
| POST /webhooks/workos | WorkOS event → 204 | webhook signature | | | | | |

### Connections and policies
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/connections | → connection[] (no secrets ever) | T | T | Dp | S | T | - |
| POST /v1/connections | `{kind, ownership, label, jobRoleId?}` → `{connection, linkUrl}` (Composio/WorkOS-hosted OAuth) | T | T | - | S (personal-allowed only) | - | - |
| PATCH /v1/connections/:id | `{ownership?, label?, jobRoleId?}`; `linkedin_personal` can never become `company` | T | T | - | S (label) | - | - |
| DELETE /v1/connections/:id | | T | T | - | S | - | - |
| GET /v1/policies/job-roles/:id | → role-policy | T | T | Dp | read own job roles | T | - |
| PUT /v1/policies/job-roles/:id | role-policy | T | T | Dp | - | - | - |
| GET /v1/overnight-policies?workflowId= | → overnight-policy[] | T | T | Dp | S | T | - |
| POST /v1/overnight-policies, PATCH /:id | overnight-policy (mode preapproved needs templateHash) | T | T | Dp (role identities) | S (own runs) | - | - |

### Workflow registry
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/workflows?state=&jobRoleId=&departmentId= | → workflow[] | T | T | Dp | role workflows of my job roles + my proposals | T | - |
| GET /v1/workflows/:id | → workflow | T | T | Dp | same | T | - |
| GET /v1/workflows/:id/versions/:v | → workflow-definition | T | T | Dp | same | T | - |
| POST /v1/workflows/:id/promote | promote-request → workflow (409 forbidden_binding) | T | T | Dp (target dept) | - | - | - |
| POST /v1/workflows/:id/decline | `{reason}` → workflow | T | T | Dp | - | - | - |
| POST /v1/workflows/:id/versions | workflow-definition → workflow (new immutable version) | T | T | Dp | - | - | - |
| POST /v1/workflows/:id/retire | → workflow | T | T | Dp | - | - | - |
| GET /v1/workflows/:id/versions/:v/sop?format=md\|pdf | → text/markdown or application/pdf | T | T | Dp | same as GET | T | - |

Proposals arrive only through `POST /v1/sync/batches` (kind `workflow_proposal`).

### Batches, approvals, kill switch (broker)
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/batches?state=pending | → batch[] I may approve | per role-policy approvers | | Dp | S | - | - |
| GET /v1/batches/:hash | → batch (item fields visible only to the runner and approvers) | T (no fields) | T (no fields) | Dp | S | - (no fields) | - |
| POST /v1/batches/:hash/approve | approval#request → approval#response (409 hash_mismatch, token_used, kill_switch_active) | role-policy approvers only | | Dp | S | - | - |
| POST /v1/batches/:hash/reject | `{reason}` → batch | approvers | | Dp | S | - | - |
| POST /v1/batches/:hash/release | `{keys[]}`: confirm `unknown` items did not go out | approvers | | Dp | S | - | - |
| GET /v1/kill-switches | → kill-switch[] | T | T | Dp | S | T | - |
| POST /v1/kill-switches | `{scope, targetId, reason}` → kill-switch | T | T | Dp (workflow, person in dept) | S (own person, own workflows) | - | - |
| DELETE /v1/kill-switches/:scope/:targetId | clear | T | T (not tenant scope set by O) | Dp | S (own, if set by self) | - | - |
| POST /v1/digest-links/:token | signed link action (`kill` or `open`) | link | | | | | |

Owner/admin do not approve other people's batches unless the role policy names them; seeing a batch's item fields
(recipients, bodies) is limited to the runner and the approvers, and each view is an audit event.

Clearing a kill switch (S2-07 follow-up): nobody clears a person switch that targets themselves, whatever their role;
a switch an owner or admin set is cleared only by an owner or admin (a tenant switch an owner set, only by an owner);
a dept lead clears only switches set by a dept lead or member of their department (or by themselves), inside their
scope; a member clears only switches they set. A person switch also stops that person's approvals: their unspent
approvals are revoked and execute refuses an approval whose approver is switched off.

Open question (S2-07 follow-up, not decided): several overnight policies may name the same workflow version (one per
owner today; nothing stops one owner creating two). A run names the policy it uses (`overnightPolicyId`), so caps,
budget and breaker state are per policy, not per workflow version: two policies of one owner double the night cap.
Options: one active policy per (owner, workflow, version), or caps summed per workflow version. Needs a product call.

### Cloud workers
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/workers | → worker[] | T | T | Dp | of my job roles | T | - |
| POST /v1/workers | `{workflowId, version, identityId, schedule?, sessionBudgetCents}` → worker | T | T | Dp | - | - | - |
| PATCH /v1/workers/:id | `{schedule?, sessionBudgetCents?}` (cron in 01:00-03:59 local → 400) | T | T | Dp | - | - | - |
| POST /v1/workers/:id/pause, /resume, /retire | → worker | T | T | Dp | - | - | - |
| POST /v1/workers/:id/runs | `{inputs?}` → worker-run (manual run) | T | T | Dp | job role holders | - | - |
| GET /v1/workers/:id/runs, GET /v1/worker-runs/:id | → worker-run | T | T | Dp | job role holders | T | - |

### Metrics
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/metrics/hours-saved?scope=company\|department:<id>\|job_role:<id>&from=&to= | → hours-saved-report | T | T | Dp | - | T | - |
| GET /v1/metrics/hours-saved?scope=person:<id> | → hours-saved-report | F:per_person_views | F:per_person_views | Dp + F:per_person_views | S (always) | - | - |
| GET /v1/metrics/hours-saved/evidence?workflowId=&version=&from=&to= | → hours-saved-evidence (runs of people outside scope are counted, not listed; a workflow whose job role or department has fewer people than the group floor answers `422 group_floor`, except for the caller's own runs under S) | T | T | Dp | S | T | - |
| GET /v1/metrics/adoption?scope= | → adoption-report | T | T | Dp | - | T | - |
| GET /v1/metrics/working-time?scope=company\|department:<id> | → working-time-report | F:working_time | F:working_time | Dp + F:working_time | - | - | - |
| GET /v1/metrics/working-time?scope=person:<id> | → working-time-report | F:working_time + F:per_person_views | same | same + Dp | S (when working_time is on for me) | - | - |

No endpoint sorts or ranks people. Person scope reads write `person.read` audit events.

### Continuity
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| POST /v1/people/:id/offboard | offboarding-request → person (state leaving or frozen) | T | T | - | - | - | - |
| GET /v1/handovers?state= | → handover[] | T | T | Dp | - | T | - |
| POST /v1/handovers/:id/assign | `{successor, inFlight, inboxStep}` → handover (successor person must hold the job role and accept) | T | T | Dp | - | - | - |
| POST /v1/handovers/:id/accept | successor accepts → handover | - | - | - | S (named successor) | - | - |
| POST /v1/handovers/:id/close | → handover | T | T | Dp | - | - | - |

### Compliance
| method path | body → response | O | A | L | M | U | D |
|---|---|---|---|---|---|---|---|
| GET /v1/compliance/features | → feature-enablement[] | T | T | T | T | T | - |
| POST /v1/compliance/features/:feature/enable | feature-enablement (without enabledBy/At/effectiveAt/disabledAt) → feature-enablement | T | - | - | - | - | - |
| POST /v1/compliance/features/:feature/disable | → feature-enablement (effective immediately; data for the feature stops syncing on next config pull) | T | T | - | - | - | - |
| GET /v1/compliance/notices | → notice[] | T | T | T | T | T | - |
| POST /v1/compliance/notices | `{template, title, markdown, features, jurisdictions}` → notice (draft) | T | T | - | - | - | - |
| POST /v1/compliance/notices/:id/publish | → notice | T | T | - | - | - | - |
| GET /v1/compliance/notices/:id/acks | → `{personId, acknowledgedAt}[]` | T | T | Dp | - | T | - |
| GET /v1/compliance/templates | → `{id, title, jurisdictions}[]` from `compliance/templates/` | T | T | - | - | T | - |
| GET /v1/audit-log?action=&subjectPersonId=&from=&to= | → audit-event[] | T | T | - | - | T | - |
| GET /v1/audit-log/verify | → `{ok, brokenAt?}` (chain check) | T | - | - | - | T | - |

## Rate limits
Per device: 60 sync requests/hour. Per session: 600 requests/10 min. Exports: 5/day per person.
