# control: Offload Stage 2 control plane

Bun + TypeScript (strict) + Hono + `Bun.sql` + Postgres 17 with forced row-level security (ADR 0101, 0102, 0108 §5,
0110). Hosted, multi-tenant. Built by slice S2-01; later control slices add `src/modules/<name>/`, a migration range
and `tests/<slice>/` and never edit the shared files below.

## Run the tests
```
docker compose up -d --wait          # postgres:17-alpine on 127.0.0.1:54329, db offload_test, tmpfs data
bun install --frozen-lockfile
bun test tests/S2-01                 # or: bash ../slices/S2-01-control-core/verify.sh
```
`OFFLOAD_PG_URL` may point at another *local* Postgres 17 instead (its user must be able to create schemas and alter
the `offload_app` role). Each test file migrates a fresh schema and drops it afterwards. Tests never call WorkOS: they
use `tests/helpers/fake-workos.ts`.

## Layout (shared files are S2-01's; later slices only add files)
| path | what |
|---|---|
| `src/app.ts` | Hono app, RBAC gate, module loader (`src/modules/*/index.ts` exporting a `ModuleDef`), handler helpers |
| `src/ports.ts` | `AuditPort`, `ConsentPort`, `FeaturePort`, `RegistryPort`, `BrokerPort`, `WorkersPort`, `ContinuityPort` + safe defaults |
| `src/rbac/permissions.ts` | the whole API.md matrix as data, `matchPermission()`, `authorize()` |
| `src/schema/` | Ajv 2020-12 over every `schemas/stage2/*.schema.json` by `$id`, inline request/response schemas, JSON/error helpers, JCS + ULID |
| `src/db/` | `Bun.sql` pool, `withTenant()` / `withLookup()`, migration runner (numbered files, checksums), person repo |
| `src/auth/` | AuthKit login/callback/logout + sessions, device enrollment/challenge/token, WorkOS adapter, Directory Sync webhook |
| `src/audit/` | per-tenant hash chain, `GET /v1/audit-log`, `/verify` |
| `src/modules/org/` | tenant, departments, people, invite, job roles, role identities, support grants |
| `migrations/01xx_*.sql` | S2-01's range (0100-0199) |
| `tests/helpers/` | `testDb()`, `seedTenant()`, fake WorkOS, `createHarness()`, `asPrincipal()`, device helpers (read-only for later slices) |

## Writing a module (later slices)
```ts
// src/modules/<name>/index.ts
import type { ModuleDef } from "../../app.ts";
import { reply, tenantTx } from "../../app.ts";
const mod: ModuleDef = {
  name: "<name>",
  routes(app, deps) {
    app.get("/v1/<path from the matrix>", async (c) =>
      reply(c, deps, 200, await tenantTx(c, deps, async (tx, p) => ({ /* ... */ })), "offload/stage2/<x>.schema.json"));
  },
  provides: { /* optional port implementations */ },
};
export default mod;
```
Every request is matched against `PERMISSIONS` before any handler runs: no row → 404, no credential → 401, a `-` cell
→ 403, a session mutation without `X-CSRF-Token` → 403. Handlers do resource-level checks with `authorize()` (out of
scope → 404) and feature checks via `deps.ports.features`. Every mutation and per-person read calls
`deps.ports.audit.write(tx, ...)` inside the same `tenantTx` transaction.

## Database roles
- `offload_migrator` owns every table and runs migrations. In the test container it is the bootstrap superuser.
- `offload_app` (created by `0102`) is what the server connects as: not owner, cannot bypass RLS, no `DELETE` on
  people, sessions, devices or audit_events. Migrations create it `NOLOGIN`; deployment grants `LOGIN` out of band
  (tests do it in `testDb()`).
- Every request runs in one transaction with `SET LOCAL app.tenant_id / principal_id / principal_person_id /
  access_role`. Pre-authentication lookups (WorkOS org or directory → tenant, device id → device) use read-only
  `withLookup()` transactions and narrow `FOR SELECT` policies keyed by that one value.
- `offload_anchor` (created by `0103`) runs the audit anchoring job and verify-chain: it reads audit_events and tenant
  ids and is the only role that may insert into `audit_anchors` (append-only for everyone, owner included, by trigger).

## Server
`bun run src/server.ts` with `OFFLOAD_PG_URL` (migrator), `OFFLOAD_APP_PG_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_REDIRECT_URI`, `WORKOS_WEBHOOK_SECRET`, `WORKOS_ISSUER` (the `iss` of the environment's AuthKit access tokens),
optional `WORKOS_AUDIENCE`, `OFFLOAD_DEVICE_SIGNING_JWK` (private ES256 JWK). No slice deploys it.

Mac enrollment (ADR 0111 §1): `GET /auth/login?client=offload-mac&redirect_uri=http://127.0.0.1:<port>/callback&state=…
&code_challenge=…&code_challenge_method=S256` → AuthKit → redirect to the loopback with `code` and `state` (or `error`);
`POST /v1/devices/enroll` with `Offload-Code-Verifier`. Admin-issued codes stay as a fallback without PKCE.

## Audit anchors
- `bun run audit:anchor [--every <minutes>]` (env `OFFLOAD_ANCHOR_PG_URL` as offload_anchor, `OFFLOAD_ANCHOR_SIGNING_JWK`,
  `OFFLOAD_ANCHOR_DIR`): appends each moved chain head to `audit_anchors` (never over a broken chain) and writes a signed
  `checkpoint-<ms>.json`. Run it as its own process; ship the directory to append-only storage.
- `bun run audit:verify-chain [--checkpoint <file>]` (env `OFFLOAD_ANCHOR_PG_URL`, `OFFLOAD_ANCHOR_PUBLIC_JWK` for a
  checkpoint): exit 1 when a chain is truncated, rewritten or has a bad link, or a checkpoint signature is bad.
