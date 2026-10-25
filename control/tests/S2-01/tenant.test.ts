import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asDevice, asPrincipal, createHarness, enrollDevice, type Client, type Harness } from "../helpers/harness.ts";
import { signJwt } from "../../src/auth/jwt.ts";

let h: Harness;
let ownerA: Client;
let adminA: Client;
beforeAll(async () => {
  h = await createHarness();
  ownerA = await asPrincipal(h, "owner");
  adminA = await asPrincipal(h, "admin");
});
afterAll(() => h.close());

describe("TENANT", () => {
  test("TENANT: another tenant's person id in the path is 404", async () => {
    expect((await ownerA.get(`/v1/people/${h.b.people.member.id}`)).status).toBe(404);
    expect((await ownerA.patch(`/v1/people/${h.b.people.member.id}`, { jurisdiction: "GB" })).status).toBe(404);
    const [p] = await h.db.migrator`select jurisdiction from people where id = ${h.b.people.member.id}`;
    expect(p!.jurisdiction).toBe("CA-ON");
  });

  test("TENANT: another tenant's department, job role and role identity ids are 404", async () => {
    expect((await adminA.patch(`/v1/departments/${h.b.departments.sales}`, { name: "Mine" })).status).toBe(404);
    expect((await adminA.del(`/v1/departments/${h.b.departments.finance}`)).status).toBe(404);
    expect((await adminA.patch(`/v1/job-roles/${h.b.jobRoles.sdr}`, { name: "Mine" })).status).toBe(404);
    const [ri] = await h.db.migrator`insert into role_identities (tenant_id, job_role_id, label, connection_id)
      values (${h.b.id}, ${h.b.jobRoles.sdr}, 'sales@', ${h.b.connections.company}) returning id`;
    expect((await adminA.patch(`/v1/role-identities/${ri!.id}`, { label: "x" })).status).toBe(404);
    expect((await adminA.del(`/v1/role-identities/${ri!.id}`)).status).toBe(404);
  });

  test("TENANT: another tenant's device id is 404 on revoke", async () => {
    const memberB = await asPrincipal(h, "member", h.b);
    const dev = await enrollDevice(h, memberB);
    expect((await adminA.del(`/v1/devices/${dev.deviceId}`)).status).toBe(404);
    const [d] = await h.db.migrator`select state from devices where id = ${dev.deviceId}`;
    expect(d!.state).toBe("active");
  });

  test("TENANT: a forged tenant header is ignored; the tenant comes from the credential", async () => {
    const r = await ownerA.get("/v1/tenant", { "X-Tenant-Id": h.b.id, "X-Offload-Tenant": h.b.id });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(h.a.id);
    const forged = await ownerA.get(`/v1/people/${h.b.people.owner.id}`, { "X-Tenant-Id": h.b.id });
    expect(forged.status).toBe(404);
  });

  test("TENANT: a tenantId in a body is rejected as an unknown field", async () => {
    const r = await adminA.post("/v1/departments", { name: "Ops", tenantId: h.b.id });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    const [n] = await h.db.migrator`select count(*)::int as n from departments where tenant_id = ${h.b.id} and name = 'Ops'`;
    expect(n!.n).toBe(0);
  });

  test("TENANT: referencing another tenant's department in a body creates nothing there", async () => {
    const jr = await adminA.post("/v1/job-roles", { name: "Spy", departmentId: h.b.departments.sales });
    expect(jr.status).toBe(400);
    const inv = await adminA.post("/v1/people/invite", {
      email: "spy@example.com", displayName: "Spy", departmentId: h.b.departments.sales, jurisdiction: "GB",
    });
    expect(inv.status).toBe(400);
    const p = await adminA.patch(`/v1/people/${h.a.people.member.id}`, { departmentId: h.b.departments.finance });
    expect(p.status).toBe(400);
  });

  test("TENANT: swapping the tenant part of a session cookie is 401", async () => {
    const secret = ownerA.cred.cookie.split(".").slice(1).join(".");
    const r = await h.request("GET", "/v1/tenant", { headers: { Cookie: `__Host-offload_session=${h.b.id}.${secret}` } });
    expect(r.status).toBe(401);
  });

  test("TENANT: lists only contain the caller's tenant", async () => {
    const people = await ownerA.get("/v1/people?limit=200");
    const ids = people.json.items.map((p: { id: string }) => p.id);
    for (const p of Object.values(h.b.people)) expect(ids).not.toContain(p.id);
    const depts = await ownerA.get("/v1/departments");
    expect(depts.json.items.map((d: { id: string }) => d.id)).not.toContain(h.b.departments.sales);
  });

  test("TENANT: a device token with a forged tenant claim is 401", async () => {
    const memberA = await asPrincipal(h, "member");
    const dev = await enrollDevice(h, memberA);
    // Same claims, other tenant, signed with a key that is not the control plane's.
    const { generateEs256SigningKey } = await import("../../src/auth/jwt.ts");
    const now = Math.floor(h.clock.now() / 1000);
    const forged = await signJwt(
      { iss: "offload-control", aud: "device", sub: dev.deviceId, tid: h.b.id, iat: now, exp: now + 600 },
      await generateEs256SigningKey(),
    );
    expect((await asDevice(h, forged)("GET", "/v1/sync/config")).status).toBe(401);
    // A correctly signed token naming the wrong tenant finds no device there.
    const wrongTenant = await signJwt(
      { iss: "offload-control", aud: "device", sub: dev.deviceId, tid: h.b.id, iat: now, exp: now + 600 },
      h.deps.deviceKey,
    );
    expect((await asDevice(h, wrongTenant)("GET", "/v1/sync/config")).status).toBe(401);
  });
});
