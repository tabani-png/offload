import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";

let h: Harness;
let owner: Client;
let admin: Client;
let lead: Client;
let member: Client;
beforeAll(async () => {
  h = await createHarness();
  owner = await asPrincipal(h, "owner");
  admin = await asPrincipal(h, "admin");
  lead = await asPrincipal(h, "lead");
  member = await asPrincipal(h, "member");
});
afterAll(() => h.close());

const ids = (r: { json: { items: Array<{ id: string }> } }) => r.json.items.map((x) => x.id);

describe("ORG tenant", () => {
  test("ORG: GET /v1/tenant returns the caller's tenant with defaults", async () => {
    const r = await member.get("/v1/tenant");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: h.a.id, groupFloor: 5, retention: { perPersonDays: 90, workingTimeDays: 30, groupMonths: 24 } });
  });

  test("ORG: groupFloor can only go up", async () => {
    expect((await admin.patch("/v1/tenant", { groupFloor: 7 })).json.groupFloor).toBe(7);
    const down = await admin.patch("/v1/tenant", { groupFloor: 6 });
    expect(down.status).toBe(409);
    expect(down.json.error.code).toBe("conflict");
  });

  test("ORG: retention can only go down", async () => {
    expect((await admin.patch("/v1/tenant", { retention: { perPersonDays: 60 } })).json.retention.perPersonDays).toBe(60);
    expect((await admin.patch("/v1/tenant", { retention: { perPersonDays: 61 } })).status).toBe(409);
    expect((await admin.patch("/v1/tenant", { retention: { groupMonths: 25 } })).status).toBe(400);
  });

  test("ORG: only an owner changes identityAddon and the worker budget", async () => {
    expect((await admin.patch("/v1/tenant", { identityAddon: { sso: true } })).status).toBe(403);
    expect((await admin.patch("/v1/tenant", { monthlyWorkerBudgetCents: 100 })).status).toBe(403);
    const r = await owner.patch("/v1/tenant", { identityAddon: { sso: true }, monthlyWorkerBudgetCents: 5000 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ identityAddon: { sso: true, directorySync: false }, monthlyWorkerBudgetCents: 5000 });
    const [ev] = await h.db.migrator`select detail from audit_events where tenant_id = ${h.a.id} and action = 'tenant.update' order by seq desc limit 1`;
    expect(ev!.detail.fields).toEqual(["identityAddon", "monthlyWorkerBudgetCents"]);
  });
});

describe("ORG owners", () => {
  test("ORG: demoting the last owner is 409", async () => {
    const r = await owner.patch(`/v1/people/${h.a.people.owner.id}`, { accessRole: "admin" });
    expect(r.status).toBe(409);
    const [p] = await h.db.migrator`select access_role from people where id = ${h.a.people.owner.id}`;
    expect(p!.access_role).toBe("owner");
  });

  test("ORG: an admin can neither grant nor remove owner", async () => {
    expect((await admin.patch(`/v1/people/${h.a.people.member2.id}`, { accessRole: "owner" })).status).toBe(403);
    expect((await admin.patch(`/v1/people/${h.a.people.owner.id}`, { accessRole: "member" })).status).toBe(403);
  });

  test("ORG: with a second owner the first may step down", async () => {
    expect((await owner.patch(`/v1/people/${h.a.people.admin.id}`, { accessRole: "owner" })).json.accessRole).toBe("owner");
    const self = await owner.patch(`/v1/people/${h.a.people.owner.id}`, { accessRole: "admin" });
    expect(self.status).toBe(200);
    // Restore: the new owner promotes the old one back.
    const admin2 = await asPrincipal(h, "admin");
    expect((await admin2.patch(`/v1/people/${h.a.people.owner.id}`, { accessRole: "owner" })).status).toBe(200);
    expect((await (await asPrincipal(h, "owner")).patch(`/v1/people/${h.a.people.admin.id}`, { accessRole: "admin" })).status).toBe(200);
  });

  test("ORG: a frozen owner does not count toward the last-owner rule", async () => {
    const [extra] = await h.db.migrator`insert into people (tenant_id, email, display_name, access_role, source, state)
      values (${h.a.id}, 'gone@acme.example.com', 'Gone', 'owner', 'manual', 'frozen') returning id`;
    const o = await asPrincipal(h, "owner");
    expect((await o.patch(`/v1/people/${h.a.people.owner.id}`, { accessRole: "admin" })).status).toBe(409);
    await h.db.migrator`update people set access_role = 'member' where id = ${extra!.id}`;
  });

  test("ORG: the service role cannot be given to a person", async () => {
    const o = await asPrincipal(h, "owner");
    expect((await o.patch(`/v1/people/${h.a.people.member2.id}`, { accessRole: "service" })).status).toBe(400);
  });
});

describe("ORG department scope", () => {
  test("ORG: dept_lead lists only people in their own departments", async () => {
    const r = await lead.get("/v1/people?limit=200");
    expect(r.status).toBe(200);
    expect(ids(r)).toContain(h.a.people.member.id);
    expect(ids(r)).not.toContain(h.a.people.member2.id);
    expect(r.json.items.every((p: { departmentId: string }) => p.departmentId === h.a.departments.sales)).toBe(true);
  });

  test("ORG: dept_lead reading a person outside their departments is 404", async () => {
    expect((await lead.get(`/v1/people/${h.a.people.member2.id}`)).status).toBe(404);
    expect((await lead.get(`/v1/people/${h.a.people.member.id}`)).status).toBe(200);
  });

  test("ORG: dept_lead sees and writes job roles of own departments only", async () => {
    const list = await lead.get("/v1/job-roles");
    expect(ids(list)).toEqual([h.a.jobRoles.sdr]);
    expect((await lead.post("/v1/job-roles", { name: "AE", departmentId: h.a.departments.finance })).status).toBe(404);
    const ok = await lead.post("/v1/job-roles", { name: "AE", departmentId: h.a.departments.sales });
    expect(ok.status).toBe(201);
    expect((await lead.patch(`/v1/job-roles/${h.a.jobRoles.ap}`, { name: "x" })).status).toBe(404);
    expect((await lead.patch(`/v1/job-roles/${ok.json.id}`, { departmentId: h.a.departments.finance })).status).toBe(404);
    expect((await lead.patch(`/v1/job-roles/${ok.json.id}`, { name: "Account exec" })).json.name).toBe("Account exec");
  });

  test("ORG: dept_lead reads role identities of own departments only", async () => {
    const mk = (jobRoleId: string, label: string) =>
      admin.post("/v1/role-identities", { jobRoleId, label, address: `${label}@acme.example.com`, connectionId: h.a.connections.company });
    const sales = await mk(h.a.jobRoles.sdr, "sales");
    const ap = await mk(h.a.jobRoles.ap, "ap");
    expect(sales.status).toBe(201);
    const r = await lead.get("/v1/role-identities");
    expect(ids(r)).toContain(sales.json.id);
    expect(ids(r)).not.toContain(ap.json.id);
    expect(ids(await (await asPrincipal(h, "auditor")).get("/v1/role-identities"))).toContain(ap.json.id);
  });

  test("ORG: a member reads only their own person record", async () => {
    expect((await member.get(`/v1/people/${h.a.people.member.id}`)).status).toBe(200);
    expect((await member.get(`/v1/people/${h.a.people.lead.id}`)).status).toBe(404);
    expect((await member.get("/v1/people")).status).toBe(403);
  });
});

describe("ORG departments, people, job roles, identities, grants", () => {
  test("ORG: departments are created with directory group mappings and listed with leads", async () => {
    const r = await admin.post("/v1/departments", { name: "Ops", directoryGroups: ["grp_ops"] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "Ops", parentId: null, directoryGroups: ["grp_ops"], leadPersonIds: [] });
    const list = await member.get("/v1/departments");
    const sales = list.json.items.find((d: { id: string }) => d.id === h.a.departments.sales);
    expect(sales.leadPersonIds).toEqual([h.a.people.lead.id]);
  });

  test("ORG: a department in use cannot be deleted; an empty one can", async () => {
    expect((await admin.del(`/v1/departments/${h.a.departments.sales}`)).status).toBe(409);
    const d = await admin.post("/v1/departments", { name: "Temp", directoryGroups: ["grp_tmp"] });
    expect((await admin.del(`/v1/departments/${d.json.id}`)).status).toBe(204);
    const [m] = await h.db.migrator`select count(*)::int as n from department_group_mappings where directory_group = 'grp_tmp'`;
    expect(m!.n).toBe(0);
  });

  test("ORG: department parents cannot form a cycle", async () => {
    const top = await admin.post("/v1/departments", { name: "Top" });
    const sub = await admin.post("/v1/departments", { name: "Sub", parentId: top.json.id });
    expect(sub.status).toBe(201);
    expect((await admin.patch(`/v1/departments/${top.json.id}`, { parentId: sub.json.id })).status).toBe(400);
    expect((await admin.patch(`/v1/departments/${top.json.id}`, { parentId: top.json.id })).status).toBe(400);
  });

  test("ORG: invite creates a person, sends a WorkOS invitation, and rejects duplicates", async () => {
    const body = { email: "newbie@acme.example.com", displayName: "Newbie", departmentId: h.a.departments.sales, jurisdiction: "CA-QC" };
    const r = await admin.post("/v1/people/invite", body);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email: body.email, accessRole: "member", source: "invite", state: "active", jurisdiction: "CA-QC" });
    expect(h.workos.invitations).toContainEqual({ email: body.email, organizationId: h.a.workosOrgId });
    expect((await admin.post("/v1/people/invite", { ...body, email: "NEWBIE@acme.example.com" })).status).toBe(409);
    expect((await lead.post("/v1/people/invite", body)).status).toBe(403);
  });

  test("ORG: PATCH person sets job roles, department lead scope and leaving state", async () => {
    const r = await admin.patch(`/v1/people/${h.a.people.member.id}`, {
      jobRoleIds: [h.a.jobRoles.sdr], deptLeadOf: [h.a.departments.sales], leavingOn: "2026-12-31",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ jobRoleIds: [h.a.jobRoles.sdr], deptLeadOf: [h.a.departments.sales], leavingOn: "2026-12-31", state: "leaving" });
    const jr = await admin.get("/v1/job-roles");
    expect(jr.json.items.find((j: { id: string }) => j.id === h.a.jobRoles.sdr).holderPersonIds).toContain(h.a.people.member.id);
    const back = await admin.patch(`/v1/people/${h.a.people.member.id}`, { leavingOn: null, deptLeadOf: [] });
    expect(back.json).toMatchObject({ state: "active", leavingOn: null, deptLeadOf: [] });
    expect((await admin.patch(`/v1/people/${h.a.people.member.id}`, { jobRoleIds: [crypto.randomUUID()] })).status).toBe(400);
  });

  test("ORG: a role identity needs a company-owned connection", async () => {
    const r = await admin.post("/v1/role-identities", { jobRoleId: h.a.jobRoles.sdr, label: "me", connectionId: h.a.connections.personal });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
  });

  test("ORG: role identities can be renamed and removed by admins only", async () => {
    const ri = await owner.post("/v1/role-identities", { jobRoleId: h.a.jobRoles.ap, label: "ap", connectionId: h.a.connections.company, signature: "AP team" });
    expect((await lead.patch(`/v1/role-identities/${ri.json.id}`, { label: "x" })).status).toBe(403);
    expect((await admin.patch(`/v1/role-identities/${ri.json.id}`, { label: "Accounts payable" })).json.label).toBe("Accounts payable");
    expect((await admin.del(`/v1/role-identities/${ri.json.id}`)).status).toBe(204);
    expect((await admin.del(`/v1/role-identities/${ri.json.id}`)).status).toBe(404);
  });

  test("ORG: support grants are owner-only, at most 72 hours, read-only by default", async () => {
    const r = await owner.post("/v1/support-grants", { hours: 72 });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ hours: 72, readOnly: true, expiresAt: h.clock.now() + 72 * 3600_000 });
    expect((await owner.post("/v1/support-grants", { hours: 73 })).status).toBe(400);
    expect((await admin.post("/v1/support-grants", { hours: 1 })).status).toBe(403);
    const [ev] = await h.db.migrator`select 1 from audit_events where action = 'support_grant.create' and resource_id = ${r.json.id}`;
    expect(ev).toBeTruthy();
  });
});
