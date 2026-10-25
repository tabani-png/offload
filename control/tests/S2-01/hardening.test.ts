import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import type { FakeLogin } from "../helpers/fake-workos.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function login(user: FakeLogin) {
  const start = await h.request("GET", "/auth/login");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const code = h.workos.issueCode(user);
  return h.request("GET", `/auth/callback?code=${code}&state=${state}`, {
    headers: { Cookie: `__Host-offload_oauth_state=${state}` },
  });
}

async function deliver(event: string, data: Record<string, unknown>, id?: string) {
  const w = await h.workos.webhook(event, data, id ? { id } : {});
  return h.request("POST", "/webhooks/workos", { body: w.body, headers: w.headers });
}

const dirUser = (id: string, email: string) => ({
  id, directory_id: h.a.directoryId, emails: [{ primary: true, value: email }], first_name: "Ari", last_name: "Mo", state: "active",
});

describe("hardening (review wave A, low items)", () => {
  test("AUTH: an AuthKit token with the wrong issuer, audience or client is rejected", async () => {
    const who = { userId: "user_owner_a", email: h.a.people.owner.email, orgId: h.a.workosOrgId };
    expect((await login(who)).status).toBe(302);
    expect((await login({ ...who, claims: { iss: "https://evil.example.com" } })).status).toBe(401);
    expect((await login({ ...who, claims: { iss: undefined } })).status).toBe(401);
    expect((await login({ ...who, claims: { aud: "client_someone_else" } })).status).toBe(401);
    expect((await login({ ...who, claims: { client_id: "client_someone_else" } })).status).toBe(401);
    expect((await login({ ...who, claims: { aud: ["client_fake"], client_id: "client_fake" } })).status).toBe(302);
  });

  test("DEVICE: the unauthenticated challenge endpoint is rate limited per device (429 with Retry-After)", async () => {
    const dev = await enrollDevice(h, await asPrincipal(h, "member"));
    const statuses: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 15; i++) {
      const r = await h.request("POST", "/v1/devices/challenge", { body: { deviceId: dev.deviceId } });
      statuses.push(r.status);
      if (r.status === 429) {
        retry = r.headers.get("retry-after");
        expect(r.json.error.code).toBe("rate_limited");
      }
    }
    // enrollDevice already used one challenge.
    expect(statuses.filter((s) => s === 200).length).toBe(9);
    expect(statuses.slice(9).every((s) => s === 429)).toBe(true);
    expect(Number(retry)).toBeGreaterThan(0);
    const [n] = await h.db.migrator`select count(*)::int as n from device_nonces where device_id = ${dev.deviceId}`;
    expect(n!.n).toBe(10);
    // Once the window passes, challenges work again.
    h.clock.advance(5 * 60_000 + 1);
    expect((await h.request("POST", "/v1/devices/challenge", { body: { deviceId: dev.deviceId } })).status).toBe(200);
  });

  test("DSYNC: groups map to departments by directory group id only, never by name", async () => {
    await h.db.migrator`insert into department_group_mappings (tenant_id, directory_group, department_id)
      values (${h.a.id}, 'directory_group_finance', ${h.a.departments.finance})`;
    // Someone creates an IdP group whose *name* equals the mapped id: it must not map.
    await deliver("dsync.user.created", dirUser("dir_grp", "grp@acme.example.com"));
    await deliver("dsync.group.user_added", {
      directory_id: h.a.directoryId, user: dirUser("dir_grp", "grp@acme.example.com"),
      group: { id: "directory_group_spoof", name: "directory_group_finance" },
    });
    const dept = async () => (await h.db.migrator`select department_id from people where directory_user_id = 'dir_grp'`)[0]!.department_id;
    expect(await dept()).toBeNull();
    await deliver("dsync.group.user_added", {
      directory_id: h.a.directoryId, user: dirUser("dir_grp", "grp@acme.example.com"),
      group: { id: "directory_group_finance", name: "Finance" },
    });
    expect(await dept()).toBe(h.a.departments.finance);
  });

  test("DSYNC: a redelivered webhook (same event id) is processed once", async () => {
    const data = { directory_id: h.a.directoryId, user: dirUser("dir_grp", "grp@acme.example.com"), group: { id: "directory_group_finance" } };
    const events = async () => (await h.db.migrator`select count(*)::int as n from audit_events
      where tenant_id = ${h.a.id} and action = 'person.directory_sync'`)[0]!.n as number;
    const n0 = await events();
    expect((await deliver("dsync.group.user_removed", data, "event_dup_1")).status).toBe(204);
    const n1 = await events();
    expect(n1).toBe(n0 + 1);
    // WorkOS retries the same event; re-adding happened in between, the replay must not remove again.
    await deliver("dsync.group.user_added", data, "event_dup_2");
    expect((await deliver("dsync.group.user_removed", data, "event_dup_1")).status).toBe(204);
    expect(await events()).toBe(n1 + 1);
    const [p] = await h.db.migrator`select department_id from people where directory_user_id = 'dir_grp'`;
    expect(p!.department_id).toBe(h.a.departments.finance);
  });

  test("ORG: concurrent invites for one email give one 201 and 409s, never a 500", async () => {
    const admin = await asPrincipal(h, "admin");
    const inv = { email: "race@acme.example.com", displayName: "Race", departmentId: null, jurisdiction: "GB" };
    const rs = await Promise.all(Array.from({ length: 6 }, () => admin.post("/v1/people/invite", inv)));
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    const [n] = await h.db.migrator`select count(*)::int as n from people where tenant_id = ${h.a.id} and lower(email) = 'race@acme.example.com'`;
    expect(n!.n).toBe(1);
    expect((await admin.post("/v1/people/invite", { ...inv, email: "RACE@acme.example.com" })).status).toBe(409);
  });
});
