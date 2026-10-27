# 0103 Sync protocol: Mac to control plane

Date: 2026-10-25. Status: proposed. Extends ADR 0003 (metadata-first privacy) to the company setting.

## Context
Operator: raw activity never leaves the employee's Mac; only aggregates, workflow definitions and run outcomes sync.
Monitoring law (research 02) requires notice before monitoring, and per-person or working-time data only when the
tenant enabled it with safeguards.

## Decision
### 1. Closed set of sync objects
A device may send only these kinds (schemas in `schemas/stage2/`). Anything else is rejected by the server and cannot
be produced by the client (the projector has no code path for other data).

| kind | schema | contents (exhaustive) | never contains |
|---|---|---|---|
| `notice_ack` | notice-ack | notice version id, acknowledged at, jurisdiction, features listed in that notice | — |
| `run_outcome` | run-outcome | workflow id + version, run id, runtime `mac`, started/ended at, outcome, item counts by state, batch hash, policy id or approver kind, cost cents, error code | recipients, subjects, bodies, tool arguments, titles, URLs |
| `review_event` | review-event | run id, review seconds, edit seconds, fix seconds, items edited count, decision | the edits themselves |
| `baseline_sample` | baseline-sample | workflow id + version, window start/end, list of `{instanceRef, activeSeconds, day}` | span titles, apps, hosts, OCR, frame notes |
| `daily_aggregate` | daily-aggregate | person-day: per workflow runs, successes, saved seconds (computed on device for self-view only, recomputed server-side), active workflows count | anything per minute or per app |
| `working_time_aggregate` | working-time-aggregate | person-day: active minutes, first/last active hour (rounded to 15 min) | per-app or per-span data |
| `workflow_proposal` | workflow-definition | typed steps, gates, connector capabilities, SKILL.md text after masking, facts template keys (not values) | facts values, recipient lists, tone examples, sent mail |

`instanceRef` is `HMAC-SHA256(deviceEvidenceKey, localInstanceId)` hex, truncated to 32 chars. The Mac keeps the
key and the mapping, so evidence links resolve to real instances only on that Mac (self-view); the control plane can
count and sum but cannot correlate refs across devices.

### 2. Consent gates (client AND server)
- G1: nothing but `notice_ack` is sent until the person acknowledged the tenant's current notice version.
- G2: `working_time_aggregate` only if `working_time` is enabled for the person's jurisdiction, the person
  acknowledged a notice version that lists it, and `now ≥ enabledAt + noticePeriodDays`.
- G3: `daily_aggregate` per person is always sent (it feeds the person's own self-view and team totals), but is
  readable per person by others only when `per_person_views` is enabled (ADR 0108); otherwise the server only uses it
  inside group-floor aggregates.
- G4: `workflow_proposal` only after an explicit user action with a preview of the exact JSON to be sent.
- G5: the user can pause sync; paused means the outbox holds objects locally (encrypted, 30-day purge like brain files (ADR 0016)).
- The server re-checks G1-G2 from its own records and rejects with `consent_missing` / `feature_disabled`.

### 3. Envelope, signing, encryption
- `SyncEnvelope { v: 1, deviceId, seq, sentAt, objects[] (≤ 500, ≤ 1 MiB) }`, serialized with RFC 8785 JCS.
- Signature: ES256 (P-256, SHA-256) over the JCS bytes, sent as `Offload-Signature: keyid=<deviceId>, sig=<b64url>`.
  Device private key: 32 bytes, wrapped by the observer (`offload-observer wrap-key --name device-signing`, store
  contract unchanged), held in memory only while the brain runs. Secure Enclave keys are a later hardening.
- Transport: HTTPS, TLS 1.2+ (1.3 preferred), HSTS. Authorization: device access token (ADR 0102).
- Replay: `seq` strictly increases per device; `sentAt` within ±10 min of server time; object `id`s are ULIDs and
  ingest is idempotent on `(tenant_id, device_id, object_id)`.
- Encryption: TLS in transit; at rest, Postgres volume encryption plus per-tenant data key for any free-text column
  (SKILL.md text in proposals). No application-layer payload encryption to our own key: the same server decrypts it,
  so it adds keys to manage without a new boundary. Revisit if a proxy we do not control terminates TLS.

### 4. Cadence and delivery
- Outbox flush every 15 min and on run completion; exponential backoff to 6 h; objects older than 30 days (ADR 0016) are dropped
  locally with a purge-log line (same rule as the brain store).
- `SyncReceipt` lists accepted ids and rejected `{id, code}`; rejected objects are not retried unless the code is
  retryable (`rate_limited`, `server_error`).

### 5. Group floor for team aggregates
Any aggregate over people (team, department, company, job role) is shown only if it covers at least 5 distinct
people with data in the period. Complementary suppression: within a parent, if exactly one child is suppressed, the
smallest other child is also suppressed, so `parent − Σ visible children` never reveals a group under 5. Suppressed
cells return `{ suppressed: true, reason: "group_floor" }` and no numbers. The floor is tenant-configurable upward only.

## Consequences
- The control plane can never show content, because it never has it; this is the main answer to admin snooping.
- Evidence drill-down for admins stops at run lists and duration samples; content drill-down is self-view on the Mac.
- A stale or modified client cannot push disabled data: the server rejects it.
