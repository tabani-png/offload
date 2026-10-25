import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { createHarness, type Harness } from "../helpers/harness.ts";
import { withLookup, withTenant } from "../../src/db/tenant.ts";
import { personById, selectPeople } from "../../src/db/people.ts";
import { MIGRATIONS_DIR } from "../../src/db/migrate.ts";

let h: Harness;
let tables: Array<{ name: string; hasTenantId: boolean; rls: boolean; forced: boolean }>;
const GLOBAL_ALLOWLIST = ["tenants", "schema_migrations"];

beforeAll(async () => {
  h = await createHarness();
  tables = (await h.db.migrator`select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as "hasTenantId"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${h.db.schema} and c.relkind in ('r', 'p') order by 1`) as typeof tables;
});
afterAll(() => h.close());

const tenantTables = () => tables.filter((t) => t.hasTenantId).map((t) => t.name);

describe("RLS", () => {
  test("RLS: every tenant table has RLS enabled, forced and a tenant_isolation policy", async () => {
    expect(tenantTables().length).toBeGreaterThanOrEqual(13);
    for (const t of tables) {
      if (!t.hasTenantId) {
        expect(GLOBAL_ALLOWLIST).toContain(t.name);
        continue;
      }
      expect({ table: t.name, rls: t.rls, forced: t.forced }).toEqual({ table: t.name, rls: true, forced: true });
      const [p] = await h.db.migrator`select qual, with_check from pg_policies
        where schemaname = ${h.db.schema} and tablename = ${t.name} and policyname = 'tenant_isolation'`;
      expect(p, `policy on ${t.name}`).toBeTruthy();
      expect(p!.qual).toContain("app.tenant_id");
      expect(p!.with_check).toContain("app.tenant_id");
    }
  });

  test("RLS: the S2-01 tables all exist and are tenant tables", () => {
    for (const t of ["departments", "department_group_mappings", "people", "job_roles", "job_role_holders", "role_identities",
      "connections", "sessions", "devices", "enrollment_codes", "device_nonces", "support_grants", "audit_events"]) {
      expect(tenantTables()).toContain(t);
    }
  });

  test("RLS: tenants itself is RLS-forced so a tenant sees only its own row", async () => {
    const t = tables.find((x) => x.name === "tenants")!;
    expect(t.rls && t.forced).toBe(true);
    const rows = await withTenant(h.db.app, { tenantId: h.a.id }, (tx) => tx`select id from tenants`);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([h.a.id]);
  });

  test("RLS: offload_app is not superuser, cannot bypass RLS and owns no table", async () => {
    const [r] = await h.db.migrator`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'offload_app'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = await h.db.migrator`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${h.db.schema} and pg_get_userbyid(c.relowner) = 'offload_app'`;
    expect(owned.length).toBe(0);
  });

  test("RLS: the server's pool really connects as offload_app", async () => {
    const [r] = await h.db.app`select current_user as u`;
    expect(r!.u).toBe("offload_app");
  });

  test("RLS: a connection without app.tenant_id reads zero rows from every tenant table", async () => {
    for (const t of [...tenantTables(), "tenants"]) {
      const rows = await h.db.app.unsafe(`select count(*)::int as n from ${t}`);
      expect({ t, n: rows[0].n }).toEqual({ t, n: 0 });
    }
    // The migrator sees the seeded rows, so zero above is isolation, not emptiness.
    const [n] = await h.db.migrator`select count(*)::int as n from people`;
    expect(n!.n).toBeGreaterThan(0);
  });

  test("RLS: a connection without app.tenant_id cannot insert", async () => {
    const err = await h.db.app`insert into departments (tenant_id, name) values (${h.a.id}, 'Sneaky')`.catch((e) => e);
    expect(String(err)).toMatch(/row-level security/);
  });

  test("RLS: the app role cannot switch row security off", async () => {
    const err = await h.db.app.begin(async (tx) => {
      await tx`set local row_security = off`;
      return tx`select count(*) from people`;
    }).catch((e) => e);
    expect(String(err)).toMatch(/row-level security|row_security/i);
  });

  test("RLS: tenant A cannot read tenant B rows through repo functions", async () => {
    const out = await withTenant(h.db.app, { tenantId: h.a.id }, async (tx) => ({
      bOwner: await personById(tx, h.b.people.owner.id),
      everyone: await selectPeople(tx, tx`true`),
    }));
    expect(out.bOwner).toBeNull();
    const ids = out.everyone.map((p) => p.id);
    expect(ids).toContain(h.a.people.owner.id);
    for (const p of Object.values(h.b.people)) expect(ids).not.toContain(p.id);
  });

  test("RLS: tenant A cannot update or delete tenant B rows", async () => {
    const r = await withTenant(h.db.app, { tenantId: h.a.id }, async (tx) => ({
      upd: (await tx`update people set display_name = 'pwned' where id = ${h.b.people.member.id}`).count,
      del: (await tx`delete from departments where id = ${h.b.departments.finance}`).count,
      tenant: (await tx`update tenants set name = 'pwned' where id = ${h.b.id}`).count,
    }));
    expect(r).toEqual({ upd: 0, del: 0, tenant: 0 });
    const [p] = await h.db.migrator`select display_name from people where id = ${h.b.people.member.id}`;
    expect(p!.display_name).toBe("member");
  });

  test("RLS: tenant A cannot insert a row labelled with tenant B", async () => {
    const err = await withTenant(h.db.app, { tenantId: h.a.id }, (tx) =>
      tx`insert into departments (tenant_id, name) values (${h.b.id}, 'Planted')`,
    ).catch((e) => e);
    expect(String(err)).toMatch(/row-level security/);
  });

  test("RLS: composite foreign keys stop a row in A pointing at B's rows", async () => {
    const err = await h.db.migrator`update people set department_id = ${h.b.departments.sales} where id = ${h.a.people.member.id}`.catch(
      (e) => e,
    );
    expect(String(err)).toMatch(/foreign key/);
  });

  test("RLS: pre-auth lookups are read-only and limited to the looked-up row", async () => {
    const [dev] = await h.db.migrator`insert into devices (tenant_id, person_id, name, app_version, public_key_jwk, enrolled_at)
      values (${h.b.id}, ${h.b.people.member.id}, 'Mac', '1', '{}'::jsonb, now()) returning id`;
    const seen = await withLookup(h.db.app, "lookup_device_id", dev!.id, async (tx) => ({
      device: (await tx`select id from devices`).length,
      people: (await tx`select id from people`).length,
      tenants: (await tx`select id from tenants`).length,
    }));
    expect(seen).toEqual({ device: 1, people: 0, tenants: 0 });
    const err = await withLookup(h.db.app, "lookup_device_id", dev!.id, (tx) =>
      tx`update devices set state = 'revoked' where id = ${dev!.id}`,
    ).catch((e) => e);
    expect(String(err)).toMatch(/read-only/);
  });

  test("RLS: settings are transaction-local and do not leak to the next use of a pooled connection", async () => {
    const single = new SQL({ url: h.db.appUrl, max: 1, connection: { search_path: h.db.schema } });
    await withTenant(single, { tenantId: h.a.id }, (tx) => tx`select 1`);
    const [r] = await single`select count(*)::int as n from people`;
    expect(r!.n).toBe(0);
    await single.close();
  });

  test("RLS: offload_app has no DELETE on people, sessions, devices or audit_events", async () => {
    for (const t of ["people", "sessions", "devices", "audit_events"]) {
      const [r] = await h.db.migrator`select has_table_privilege('offload_app', ${`${h.db.schema}.${t}`}, 'DELETE') as d`;
      expect({ t, d: r!.d }).toEqual({ t, d: false });
    }
  });

  test("RLS: migrations never use BYPASSRLS or SECURITY DEFINER", () => {
    for (const f of readdirSync(MIGRATIONS_DIR)) {
      expect(readFileSync(join(MIGRATIONS_DIR, f), "utf8")).not.toMatch(/BYPASSRLS|SECURITY DEFINER/);
    }
  });
});
