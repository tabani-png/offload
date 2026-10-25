---
id: S2-01-control-core
title: Control plane core - scaffold, Postgres + RLS, org model, WorkOS auth + directory sync, RBAC, audit log
depends_on: []
parallel_safe: true
starts: immediately (wave A)
human_gated: false
verify: bash slices/S2-01-control-core/verify.sh
paths_in_scope: [control/package.json, control/bun.lock, control/tsconfig.json, control/docker-compose.yml, control/README.md, control/src/app.ts, control/src/server.ts, control/src/config.ts, control/src/ports.ts, control/src/db/**, control/src/schema/**, control/src/auth/**, control/src/rbac/**, control/src/audit/**, control/src/modules/org/**, control/migrations/01*.sql (0100-0199), control/tests/helpers/**, control/tests/S2-01/**, slices/S2-01-control-core/**]
paths_out_of_scope: [brain/**, engine/**, app/**, web/**, packages/**, packet/**, schemas/** (frozen), plan/** , control/src/modules/* other than org, other migration ranges]
---

# S2-01 control core

## Summary
Create the `control/` Bun package every later control slice adds modules to. ADRs 0101 (RLS), 0102 (identity, RBAC),
0108 §5 (audit chain), 0110 (stack). API: `plan/stage-2/API.md` sections Auth/devices (not `/v1/sync/*`), Org,
and the full RBAC matrix.

## Shared surfaces this slice writes ONCE (later slices only add files)
- `control/src/app.ts`: Hono app; loads every `control/src/modules/*/index.ts` exporting
  `ModuleDef { name, routes(app, deps), syncHandlers?: Record<kind, SyncHandler>, jobs?: Job[], provides?: Partial<Ports> }`.
  Missing ports get the defaults below. No module is imported by name.
- `control/src/ports.ts` (interfaces + safe defaults): `AuditPort` (real, this slice), `ConsentPort` (default: only
  `notice_ack` allowed), `FeaturePort` (default: sensitive features off), `RegistryPort`, `BrokerPort`,
  `WorkersPort`, `ContinuityPort` (default: `freeze` records a pending freeze and revokes sessions/devices itself).
- `control/src/rbac/permissions.ts`: the whole matrix of API.md as data (`{method, path, roles: {owner: "T"|"Dp"|"S"|"F:x"|"-", ...}}`)
  including endpoints implemented by later slices; `authorize(principal, action, resource, features)`.
- `control/src/schema/`: Ajv 2020-12 loading every `schemas/stage2/*.schema.json` by `$id`; request/response
  validation middleware; response validation on in tests.
- `control/src/db/`: `Bun.sql` pool, `withTenant(ctx, fn)` (transaction + `SET LOCAL app.tenant_id / principal_id /
  principal_person_id / access_role`), migration runner (numbered files, checksum table), roles `offload_migrator`
  and `offload_app`.
- `control/tests/helpers/`: `testDb()` (fresh schema per test file), `seedTenant()`, fake WorkOS (JWKS, AuthKit
  callback, directory webhooks), `asPrincipal()`; read-only for later slices.
- `control/docker-compose.yml`: `postgres:17-alpine`, port 54329, db `offload_test`, tmpfs data.

## Behaviour
- Tables (0100-0199): tenants, departments, department_group_mappings, people, job_roles, job_role_holders,
  role_identities, connections (refs only), sessions, devices, enrollment_codes, device_nonces, support_grants,
  audit_events. All tenant tables RLS-forced (ADR 0101).
- Auth: AuthKit login/callback/logout, session cookie + CSRF, idle/absolute timeouts per access role; enrollment codes
  (10 min, single use); device enroll (P-256 JWK), challenge, token (ES256 JWT 15 min); device revoke.
- Directory sync webhook: user created/updated/deleted, group membership → people, departments (via mappings), access
  role (never owner); deactivation → `ContinuityPort.freeze`.
- Org endpoints per API.md (tenant, departments, people, invite, job roles, role identities, support grants); last
  owner protection; groupFloor upward only; retention downward only.
- Audit: `AuditPort.write(tx, event)` hash chain per tenant; `GET /v1/audit-log`, `/verify`.

## Acceptance (tag = test name prefix in control/tests/S2-01/)
- RLS: every tenant table has RLS enabled + forced + isolation policy (catalog scan); a connection without
  `app.tenant_id` reads 0 rows and cannot insert; tenant A cannot read or update tenant B rows through any repo fn.
- TENANT: tenant id never taken from body/path (request with another tenant's ids → 404).
- AUTH: callback creates session; CSRF required on mutations; idle and absolute expiry; logout revokes.
- DEVICE: enroll with valid code once; reused/expired code 401; challenge/token signature checks; revoked device 401.
- RBAC: every row of permissions.ts is exercised for every access role (allowed → not 403; denied → 403/404).
- AUDIT: mutations write events in the same transaction (rollback removes both); chain verify detects a tampered row;
  `offload_app` has no UPDATE/DELETE on audit_events.
- DSYNC: webhook signature checked; deactivation calls ContinuityPort.freeze and revokes sessions and devices.
- ORG: last owner 409; IdP never grants owner; dept_lead sees only own departments.
- SCHEMA: unknown field → 400 validation_failed; every response in tests validates.
- LOADER: a module dropped in `modules/` is mounted without editing app.ts; defaults apply for missing ports.

## Done-signal
`verify.sh`: typecheck; suite ≥ 90 tests; every tag passing; schemas frozen; no `BYPASSRLS`/`SECURITY DEFINER` in
migrations; tests never call real WorkOS (`api.workos.com` absent from tests).
