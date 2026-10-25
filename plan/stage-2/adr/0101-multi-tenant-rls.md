# 0101 Multi-tenant control plane with Postgres row-level security

Date: 2026-10-25. Status: proposed.

## Context
Operator: the control plane is hosted by us and shared by all customers. A single missed `WHERE tenant_id = ...`
must not leak one company's data to another. Stage 1 had no server.

## Decision
1. One Postgres 17 database, shared schema. Every tenant-owned table has `tenant_id uuid NOT NULL` as the first
   column of its primary key or a unique index, and a foreign key to `tenants`.
2. RLS on every tenant table: `ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY;`
   policy `tenant_isolation USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (same)`.
   `current_setting(..., true)` returns NULL when unset, so a connection without a tenant sees zero rows and writes fail.
3. Roles: `offload_migrator` owns tables and runs migrations; `offload_app` is used by the server, is not owner, has no
   `BYPASSRLS`, and has only `SELECT, INSERT, UPDATE` (no `DELETE` on audit and sync tables). No `SECURITY DEFINER`
   functions except in migrations reviewed by S2-12.
4. Every request runs in one transaction opened by `withTenant(ctx, fn)`: `SET LOCAL app.tenant_id`,
   `SET LOCAL app.principal_id`, `SET LOCAL app.access_role`. Tenant id comes only from the verified session or device
   token, never from the request body or path.
5. Defense in depth for per-person tables (`person_daily_aggregates`, `working_time_aggregates`, `baseline_samples`,
   `run_outcomes` with a `person_id`): a second policy `person_visibility USING (person_id =
   current_setting('app.principal_person_id', true)::uuid OR current_setting('app.person_read', true) = 'on')`.
   `app.person_read` is set to `on` only by the metrics/compliance read path after `authorize()` allowed a per-person
   read and the audit event was written in the same transaction. Aggregate queries run through views owned by the
   migrator that apply the group floor and do not expose `person_id`.
6. Secrets are never stored in clear: company connection secrets live in Composio / Managed Agents vaults; the
   database stores references. Any secret we must hold is encrypted with a per-tenant data key wrapped by KMS
   (local tests: a fixed test key).
7. A test (S2-01) lists every table in the `public` schema and fails if one has `tenant_id` without both RLS flags and
   the isolation policy, or lacks `tenant_id` and is not on the global allowlist (`tenants`, `schema_migrations`).
8. Migration numbers are ranges per slice (S2-01 0100-0199, S2-05 0500-0599, ..., S2-10 1000-1099).

## Consequences
- Easier: isolation does not depend on every query being right; cross-tenant tests are one assertion.
- Harder: background jobs must set a tenant per unit of work; cross-tenant jobs (billing, nightly recompute) iterate
  tenants explicitly. Pooled connections must use transactions (no session-level `SET`).
- Rejected: schema per tenant and DB per tenant (operational cost, migration fan-out) until a customer needs data
  residency or dedicated hosting; that can be a later ADR without changing the contract.
