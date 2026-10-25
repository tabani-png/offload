import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asDevice, asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import type { ContinuityPort, FreezeReason } from "../../src/ports.ts";

let h: Harness;
let spy: Harness;
const freezes: Array<{ personId: string; reason: FreezeReason }> = [];

beforeAll(async () => {
  h = await createHarness();
  const continuity: ContinuityPort = {
    async freeze(_tx, personId, reason) {
      freezes.push({ personId, reason });
    },
  };
  spy = await createHarness({ ports: { continuity } });
});
afterAll(async () => {
  await h.close();
  await spy.close();
});

function user(id: string, email: string, extra: Record<string, unknown> = {}) {
  return { id, directory_id: h.a.directoryId, organization_id: h.a.workosOrgId, emails: [{ primary: true, value: email }],
    first_name: "Dana", last_name: "Lee", state: "active", ...extra };
}

async function deliver(event: string, data: Record<string, unknown>, harness = h, opts: { secret?: string; at?: number } = {}) {
  const w = await harness.workos.webhook(event, data, opts);
  return harness.request("POST", "/webhooks/workos", { body: w.body, headers: w.headers });
}

const personByDir = async (dirId: string, harness = h) =>
  (await harness.db.migrator`select * from people where directory_user_id = ${dirId}`)[0];

describe("DSYNC", () => {
  test("DSYNC: a webhook without a valid signature is 401 and changes nothing", async () => {
    const data = user("dir_bad", "bad@acme.example.com");
    expect((await deliver("dsync.user.created", data, h, { secret: "wrong" })).status).toBe(401);
    expect((await deliver("dsync.user.created", data, h, { at: h.clock.now() - 10 * 60_000 })).status).toBe(401);
    const body = JSON.stringify({ id: "e", event: "dsync.user.created", data });
    expect((await h.request("POST", "/webhooks/workos", { body })).status).toBe(401);
    expect(await personByDir("dir_bad")).toBeUndefined();
  });

  test("DSYNC: user.created adds a directory person with the IdP role", async () => {
    expect((await deliver("dsync.user.created", user("dir_1", "dana@acme.example.com", { role: { slug: "admin" } }))).status).toBe(204);
    const p = await personByDir("dir_1");
    expect(p).toMatchObject({ email: "dana@acme.example.com", display_name: "Dana Lee", access_role: "admin", source: "directory", state: "active" });
  });

  test("DSYNC: the IdP never grants owner", async () => {
    await deliver("dsync.user.created", user("dir_2", "eve@acme.example.com", { role: { slug: "owner" } }));
    expect((await personByDir("dir_2")).access_role).toBe("member");
    await deliver("dsync.user.updated", user("dir_2", "eve@acme.example.com", { role: { slug: "owner" } }));
    expect((await personByDir("dir_2")).access_role).toBe("member");
  });

  test("DSYNC: an in-app owner stays owner whatever the IdP role says", async () => {
    await deliver("dsync.user.updated", user("dir_owner", h.a.people.owner.email, { role: { slug: "member" } }));
    const [p] = await h.db.migrator`select access_role, directory_user_id from people where id = ${h.a.people.owner.id}`;
    expect(p).toEqual({ access_role: "owner", directory_user_id: "dir_owner" });
  });

  test("DSYNC: user.updated changes name, email and jurisdiction", async () => {
    await deliver("dsync.user.updated", user("dir_1", "dana.lee@acme.example.com", { first_name: "Dana M.", custom_attributes: { jurisdiction: "US-NY" } }));
    expect(await personByDir("dir_1")).toMatchObject({ email: "dana.lee@acme.example.com", display_name: "Dana M. Lee", jurisdiction: "US-NY" });
  });

  test("DSYNC: group membership maps to departments through department_group_mappings", async () => {
    await h.db.migrator`insert into department_group_mappings (tenant_id, directory_group, department_id)
      values (${h.a.id}, 'grp_finance', ${h.a.departments.finance})`;
    const u = user("dir_1", "dana.lee@acme.example.com");
    await deliver("dsync.group.user_added", { directory_id: h.a.directoryId, user: u, group: { id: "grp_finance", name: "Finance" } });
    expect((await personByDir("dir_1")).department_id).toBe(h.a.departments.finance);
    await deliver("dsync.group.user_removed", { directory_id: h.a.directoryId, user: u, group: { id: "grp_finance", name: "Finance" } });
    expect((await personByDir("dir_1")).department_id).toBeNull();
    await deliver("dsync.group.user_added", { directory_id: h.a.directoryId, user: u, group: { id: "grp_unmapped", name: "Book club" } });
    expect((await personByDir("dir_1")).department_id).toBeNull();
  });

  test("DSYNC: deactivation freezes the person and revokes their sessions and devices", async () => {
    await deliver("dsync.user.updated", user("dir_member", h.a.people.member.email));
    const member = await asPrincipal(h, "member");
    const dev = await enrollDevice(h, member);
    expect((await member.get("/v1/tenant")).status).toBe(200);
    expect((await deliver("dsync.user.updated", user("dir_member", h.a.people.member.email, { state: "inactive" }))).status).toBe(204);
    expect((await member.get("/v1/tenant")).status).toBe(401);
    expect((await asDevice(h, dev.token)("GET", "/v1/sync/config")).status).toBe(401);
    const [p] = await h.db.migrator`select state, pending_freeze_at from people where id = ${h.a.people.member.id}`;
    expect(p!.state).toBe("frozen");
    expect(p!.pending_freeze_at).not.toBeNull();
    const sessions = await h.db.migrator`select revoked_at from sessions where person_id = ${h.a.people.member.id}`;
    expect(sessions.every((s: { revoked_at: Date | null }) => s.revoked_at !== null)).toBe(true);
    const devices = await h.db.migrator`select state from devices where person_id = ${h.a.people.member.id}`;
    expect(devices.every((d: { state: string }) => d.state === "revoked")).toBe(true);
    const [ev] = await h.db.migrator`select detail from audit_events where action = 'person.freeze' and subject_person_id = ${h.a.people.member.id}`;
    expect(ev!.detail).toMatchObject({ pending: true, source: "directory" });
  });

  test("DSYNC: deactivation calls ContinuityPort.freeze", async () => {
    const data = { ...user("dir_x", spy.a.people.member2.email), directory_id: spy.a.directoryId };
    await deliver("dsync.user.updated", data, spy);
    await deliver("dsync.user.updated", { ...data, state: "inactive" }, spy);
    expect(freezes).toEqual([{ personId: spy.a.people.member2.id, reason: { source: "directory", detail: "inactive" } }]);
  });

  test("DSYNC: user.deleted also freezes, and never deletes the person", async () => {
    await deliver("dsync.user.updated", user("dir_m2", h.a.people.member2.email));
    await deliver("dsync.user.deleted", user("dir_m2", h.a.people.member2.email));
    const [p] = await h.db.migrator`select state from people where id = ${h.a.people.member2.id}`;
    expect(p!.state).toBe("frozen");
  });

  test("DSYNC: events for an unknown directory are acknowledged and ignored", async () => {
    const r = await deliver("dsync.user.created", { ...user("dir_ghost", "ghost@else.example.com"), directory_id: "directory_unknown" });
    expect(r.status).toBe(204);
    expect(await personByDir("dir_ghost")).toBeUndefined();
  });

  test("DSYNC: a directory user only lands in the tenant that owns the directory", async () => {
    await deliver("dsync.user.created", { ...user("dir_b1", "b1@globex.example.com"), directory_id: h.b.directoryId });
    const [p] = await h.db.migrator`select tenant_id from people where directory_user_id = 'dir_b1'`;
    expect(p!.tenant_id).toBe(h.b.id);
  });

  test("DSYNC: a directory user with an invited person's email links to that person", async () => {
    const admin = await asPrincipal(h, "admin");
    const inv = await admin.post("/v1/people/invite", { email: "new.hire@acme.example.com", displayName: "New Hire", departmentId: null, jurisdiction: "GB" });
    expect(inv.status).toBe(201);
    await deliver("dsync.user.created", user("dir_hire", "new.hire@acme.example.com"));
    expect((await personByDir("dir_hire")).id).toBe(inv.json.id);
  });
});
