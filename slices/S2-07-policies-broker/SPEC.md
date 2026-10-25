---
id: S2-07-policies-broker
title: Role policies, overnight policy evaluator, commit broker (Stage 1 hash, tokens, item journal), kill switch
depends_on: [S2-01-control-core; brain s05b/s13 gate code (read-only import)]
parallel_safe: true
starts: wave B (after S2-01 merges)
human_gated: false
verify: bash slices/S2-07-policies-broker/verify.sh
paths_in_scope: [control/src/modules/policies/**, control/src/modules/broker/**, control/migrations/07*.sql (0700-0799), control/tests/S2-07/**, slices/S2-07-policies-broker/**]
paths_out_of_scope: [brain/** (read-only import of pure functions; no edits), control/src/{app.ts,ports.ts,rbac,db,auth,audit,schema}/** (read-only), other modules, web/**, schemas/** (frozen)]
---

# S2-07 policies + commit broker

## Summary
ADR 0105 §3 and ADR 0106. The only component that commits. Provides `BrokerPort` (`proposeBatch`, `approve`,
`commitApproved`, `revokeTokensFor(person)`, `stopRunsFor(person)`, `killSwitchActive(scope)`).

## Behaviour
- Reuse: import the brain's batch-hash, canonical-argument-hash and allowlist schema functions read-only by relative
  path (`../../../../brain/src/workflows/...`). If any is not pure, copy it into `broker/stage1/` with a parity test
  over the brain fixtures and note it under "Scope changes".
- Tables (0700-0799): role_policies, overnight_policies, overnight_counters, batches, batch_items (journal),
  approval_tokens (one-use, hashed at rest), contacted_ledger, kill_switches, breaker_trips.
- `proposeBatch(run, items)`: validate each item against the role policy (`allowedCapabilities`, max items) and the
  allowlist schema of its capability; reject `linkedin_personal` commits and personal-forbidden bindings; compute
  `batchHash`; store `pending`; evaluate overnight policy per item (`evaluateOvernight` pure fn) when the run is
  overnight: `allow` mints a token with `approverKind: policy`, `queue` leaves pending, `trip(reason)` pauses the
  policy and queues the rest.
- `approve`: only approvers named by the role policy; edits produce a new hash (the old batch becomes `rejected`
  with reason `edited`); token one-use, 24 h expiry; kill switch blocks approval and execution.
- Executor: deterministic per connection kind (Composio CLI fake runner, direct API, company MCP) through the Stage 1
  gate semantics: `sending` + ledger written before the call, `unknown` never retried, `failed_before_send` re-draftable,
  `release` for unknown items. Send window: items scheduled into the policy window, not sent outside it.
- Policies endpoints, batches endpoints, kill switch endpoints per API.md.

## Acceptance (tag = test name prefix in control/tests/S2-07/)
- HASH: broker and brain produce byte-identical batch hashes for the s05/s13 fixtures.
- TOKEN: one use; expired; wrong hash; token for edited batch only.
- ITEM: journal transitions; crash between sending and result → unknown, never retried; release flow.
- EXEC: fake Composio runner receives exactly the approved arguments; changed field or extra cc → denied.
- POLICY: capability outside allowedCapabilities → rejected; max items; budgets stored and returned.
- OVERNIGHT: table-driven evaluateOvernight (allowlist hit/miss, template hash mismatch, caps per night and per
  recipient-week, send window in recipient tz, attachments, dry-run nights) and breaker trips pause the policy.
- KILL: tenant/person/workflow scopes block approve and execute; clearing rules per API.md.
- LINKEDIN: any commit on linkedin_personal rejected at propose and at execute.
- RBAC: approvers only; item fields hidden from owner/admin/auditor unless approver; field views audited.
- AUDIT: approve, reject, release, kill, trip events.

## Done-signal
`verify.sh`: typecheck, ≥ 80 tests, tags, no edits under brain/, migration range respected, S2-01 suite green.
