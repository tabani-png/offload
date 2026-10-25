import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";
import { withTenant } from "../../src/db/tenant.ts";
import { chainHash, verifyChain, writeAudit, type AuditEvent } from "../../src/audit/audit.ts";

let h: Harness;
let admin: Client;
let owner: Client;
beforeAll(async () => {
  h = await createHarness();
  admin = await asPrincipal(h, "admin");
  owner = await asPrincipal(h, "owner");
});
afterAll(() => h.close());

const SYSTEM = { type: "system" as const, id: null, accessRole: null };

describe("AUDIT", () => {
  test("AUDIT: a mutation writes its audit event with the actor", async () => {
    const r = await admin.post("/v1/departments", { name: "Legal" });
    expect(r.status).toBe(201);
    const [ev] = await h.db.migrator`select actor_type, actor_id, actor_role, resource_id from audit_events
      where tenant_id = ${h.a.id} and action = 'department.create' and resource_id = ${r.json.id}`;
    expect(ev).toEqual({ actor_type: "person", actor_id: h.a.people.admin.id, actor_role: "admin", resource_id: r.json.id });
  });

  test("AUDIT: rolling back a mutation removes both the change and its audit event", async () => {
    const before = await h.db.migrator`select count(*)::int as n from audit_events where tenant_id = ${h.a.id}`;
    const err = await withTenant(h.db.app, { tenantId: h.a.id }, async (tx) => {
      await tx`insert into departments (tenant_id, name) values (${h.a.id}, 'Doomed')`;
      await writeAudit(tx, { actor: SYSTEM, action: "department.create", resource: { type: "department", id: null } }, h.clock.now());
      throw new Error("boom");
    }).catch((e) => e);
    expect(String(err)).toContain("boom");
    const after = await h.db.migrator`select count(*)::int as n from audit_events where tenant_id = ${h.a.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const [d] = await h.db.migrator`select count(*)::int as n from departments where name = 'Doomed'`;
    expect(d!.n).toBe(0);
  });

  test("AUDIT: a request that fails after writing rolls its audit event back", async () => {
    await admin.post("/v1/departments", { name: "Taken", directoryGroups: ["grp-taken"] });
    const before = await h.db.migrator`select count(*)::int as n from audit_events where tenant_id = ${h.a.id}`;
    // Inserts the department, then the group mapping conflicts: 409 and nothing persists.
    const r = await admin.post("/v1/departments", { name: "Clash", directoryGroups: ["grp-taken"] });
    expect(r.status).toBe(409);
    const after = await h.db.migrator`select count(*)::int as n from audit_events where tenant_id = ${h.a.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const [d] = await h.db.migrator`select count(*)::int as n from departments where name = 'Clash'`;
    expect(d!.n).toBe(0);
  });

  test("AUDIT: events form a per-tenant hash chain", async () => {
    await admin.post("/v1/departments", { name: "Chain" });
    const rows = await h.db.migrator`select id, prev_hash, hash from audit_events where tenant_id = ${h.a.id} order by seq`;
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]!.prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    const list = await owner.get("/v1/audit-log?limit=200");
    for (const e of list.json.items as AuditEvent[]) {
      const { hash, ...rest } = e;
      expect(chainHash(rest)).toBe(hash);
    }
  });

  test("AUDIT: verify reports ok for an intact chain", async () => {
    const r = await owner.get("/v1/audit-log/verify");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const auditor = await asPrincipal(h, "auditor");
    expect((await auditor.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
  });

  test("AUDIT: verify detects a tampered row", async () => {
    const t = h.b;
    const ownerB = await asPrincipal(h, "owner", t);
    for (const name of ["One", "Two", "Three"]) await ownerB.post("/v1/departments", { name });
    const rows = await h.db.migrator`select id from audit_events where tenant_id = ${t.id} order by seq`;
    const victim = rows[1]!.id;
    await h.db.migrator`update audit_events set detail = '{"name":"Forged"}'::jsonb where tenant_id = ${t.id} and id = ${victim}`;
    const r = await ownerB.get("/v1/audit-log/verify");
    expect(r.json).toEqual({ ok: false, brokenAt: victim });
    // Tenant A's chain is independent and still verifies.
    expect((await owner.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
  });

  test("AUDIT: verify detects a deleted row", async () => {
    const ownerB = await asPrincipal(h, "owner", h.b);
    // Start tenant B's chain afresh (the migrator can; offload_app cannot).
    await h.db.migrator`delete from audit_events where tenant_id = ${h.b.id}`;
    expect(await withTenant(h.db.app, { tenantId: h.b.id }, (tx) => verifyChain(tx))).toEqual({ ok: true });
    for (const name of ["Four", "Five", "Six"]) await ownerB.post("/v1/departments", { name });
    expect((await ownerB.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
    const rows = await h.db.migrator`select id from audit_events where tenant_id = ${h.b.id} order by seq`;
    await h.db.migrator`delete from audit_events where tenant_id = ${h.b.id} and id = ${rows[1]!.id}`;
    expect((await ownerB.get("/v1/audit-log/verify")).json).toEqual({ ok: false, brokenAt: rows[2]!.id });
  });

  test("AUDIT: offload_app has no UPDATE or DELETE on audit_events", async () => {
    const [p] = await h.db.migrator`select has_table_privilege('offload_app', ${`${h.db.schema}.audit_events`}, 'UPDATE') as u,
      has_table_privilege('offload_app', ${`${h.db.schema}.audit_events`}, 'DELETE') as d,
      has_table_privilege('offload_app', ${`${h.db.schema}.audit_events`}, 'INSERT') as i`;
    expect(p).toEqual({ u: false, d: false, i: true });
    const upd = await withTenant(h.db.app, { tenantId: h.a.id }, (tx) => tx`update audit_events set detail = '{}'::jsonb`).catch((e) => e);
    expect(String(upd)).toMatch(/permission denied/);
    const del = await withTenant(h.db.app, { tenantId: h.a.id }, (tx) => tx`delete from audit_events`).catch((e) => e);
    expect(String(del)).toMatch(/permission denied/);
  });

  test("AUDIT: concurrent writers keep one unbroken chain", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withTenant(h.db.app, { tenantId: h.a.id }, (tx) =>
          writeAudit(tx, { actor: SYSTEM, action: "test.concurrent", resource: { type: "test", id: String(i) } }, h.clock.now()),
        ),
      ),
    );
    expect((await owner.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
  });

  test("AUDIT: the log filters by action and subject and pages with a cursor", async () => {
    const byAction = await owner.get("/v1/audit-log?action=test.concurrent&limit=5");
    expect(byAction.status).toBe(200);
    expect(byAction.json.items.length).toBe(5);
    expect(byAction.json.items.every((e: AuditEvent) => e.action === "test.concurrent")).toBe(true);
    const next = await owner.get(`/v1/audit-log?action=test.concurrent&limit=5&cursor=${byAction.json.page.nextCursor}`);
    const last = await owner.get(`/v1/audit-log?action=test.concurrent&limit=5&cursor=${next.json.page.nextCursor}`);
    const all = [...byAction.json.items, ...next.json.items, ...last.json.items].map((e: AuditEvent) => e.id);
    expect(new Set(all).size).toBe(12);
    expect(last.json.page.nextCursor).toBeNull();
    await admin.get(`/v1/people/${h.a.people.member.id}`);
    const bySubject = await owner.get(`/v1/audit-log?subjectPersonId=${h.a.people.member.id}&action=person.read`);
    expect(bySubject.json.items.length).toBeGreaterThan(0);
    expect(bySubject.json.items.every((e: AuditEvent) => e.subjectPersonId === h.a.people.member.id)).toBe(true);
  });

  test("AUDIT: the log never shows another tenant's events", async () => {
    const r = await owner.get("/v1/audit-log?limit=200&action=department.create");
    const [b] = await h.db.migrator`select id from audit_events where tenant_id = ${h.b.id} limit 1`;
    expect(r.json.items.map((e: AuditEvent) => e.id)).not.toContain(b!.id);
  });

  test("AUDIT: reading another person writes person.read; reading yourself does not", async () => {
    const member = await asPrincipal(h, "member");
    const count = async () =>
      (await h.db.migrator`select count(*)::int as n from audit_events where tenant_id = ${h.a.id} and action = 'person.read'
        and subject_person_id = ${h.a.people.member.id}`)[0]!.n as number;
    const n0 = await count();
    expect((await member.get(`/v1/people/${h.a.people.member.id}`)).status).toBe(200);
    expect(await count()).toBe(n0);
    const auditor = await asPrincipal(h, "auditor");
    expect((await auditor.get(`/v1/people/${h.a.people.member.id}`)).status).toBe(200);
    expect(await count()).toBe(n0 + 1);
  });

  test("AUDIT: members and dept leads cannot read the audit log; admins cannot run verify", async () => {
    expect((await (await asPrincipal(h, "member")).get("/v1/audit-log")).status).toBe(403);
    expect((await (await asPrincipal(h, "lead")).get("/v1/audit-log")).status).toBe(403);
    expect((await admin.get("/v1/audit-log/verify")).status).toBe(403);
  });
});
