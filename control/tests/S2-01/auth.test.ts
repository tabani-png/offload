import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { FAKE_AUTHKIT_URL } from "../helpers/fake-workos.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

function cookieValue(setCookie: string | null, name: string): string | null {
  const m = new RegExp(`${name}=([^;]*)`).exec(setCookie ?? "");
  return m ? m[1]! : null;
}

/** Runs /auth/login then /auth/callback for a login the fake AuthKit accepted. */
async function login(user: { userId: string; email: string; orgId: string | null }) {
  const start = await h.request("GET", "/auth/login");
  const state = cookieValue(start.headers.get("set-cookie"), "__Host-offload_oauth_state")!;
  const code = h.workos.issueCode(user);
  return h.request("GET", `/auth/callback?code=${code}&state=${state}`, {
    headers: { Cookie: `__Host-offload_oauth_state=${state}` },
  });
}

describe("AUTH", () => {
  test("AUTH: login redirects to AuthKit with a state bound to a cookie", async () => {
    const r = await h.request("GET", "/auth/login");
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(FAKE_AUTHKIT_URL);
    const state = cookieValue(r.headers.get("set-cookie"), "__Host-offload_oauth_state");
    expect(state).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe(state);
  });

  test("AUTH: callback creates a session, sets a hardened cookie and an audit event", async () => {
    const r = await login({ userId: "user_owner_a", email: h.a.people.owner.email, orgId: h.a.workosOrgId });
    expect(r.status).toBe(302);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain("__Host-offload_session=");
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    const cookie = `__Host-offload_session=${cookieValue(sc, "__Host-offload_session")}`;
    const s = await h.request("GET", "/auth/session", { headers: { Cookie: cookie } });
    expect(s.status).toBe(200);
    expect(s.json.person.id).toBe(h.a.people.owner.id);
    expect(typeof s.json.csrfToken).toBe("string");
    const [ev] = await h.db.migrator`select action from audit_events where tenant_id = ${h.a.id} and action = 'session.create'`;
    expect(ev).toBeTruthy();
  });

  test("AUTH: callback links the WorkOS user id to the person found by email", async () => {
    await login({ userId: "user_member_a", email: h.a.people.member.email.toUpperCase(), orgId: h.a.workosOrgId });
    const [p] = await h.db.migrator`select workos_user_id from people where id = ${h.a.people.member.id}`;
    expect(p!.workos_user_id).toBe("user_member_a");
  });

  test("AUTH: callback with a wrong state is 401", async () => {
    const code = h.workos.issueCode({ userId: "u", email: h.a.people.owner.email, orgId: h.a.workosOrgId });
    const r = await h.request("GET", `/auth/callback?code=${code}&state=abc`, { headers: { Cookie: "__Host-offload_oauth_state=xyz" } });
    expect(r.status).toBe(401);
  });

  test("AUTH: callback for an unknown organization or unknown person is 401", async () => {
    expect((await login({ userId: "u1", email: h.a.people.owner.email, orgId: "org_unknown" })).status).toBe(401);
    expect((await login({ userId: "u2", email: "stranger@nowhere.example.com", orgId: h.a.workosOrgId })).status).toBe(401);
    expect((await login({ userId: "u3", email: h.a.people.owner.email, orgId: null })).status).toBe(401);
  });

  test("AUTH: callback never signs a person into another tenant's organization", async () => {
    // Tenant B's owner email used with tenant A's organization: no person in A has it.
    const r = await login({ userId: "u_b", email: h.b.people.owner.email, orgId: h.a.workosOrgId });
    expect(r.status).toBe(401);
  });

  test("AUTH: no credential is 401", async () => {
    expect((await h.request("GET", "/v1/tenant")).status).toBe(401);
    expect((await h.request("GET", "/v1/tenant", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await h.request("GET", "/v1/tenant", { headers: { Cookie: "__Host-offload_session=garbage" } })).status).toBe(401);
  });

  test("AUTH: CSRF token is required on mutations", async () => {
    const admin = await asPrincipal(h, "admin");
    const none = await h.request("POST", "/v1/departments", { body: { name: "Ops" }, headers: { Cookie: admin.cred.cookie } });
    expect(none.status).toBe(403);
    const wrong = await admin.post("/v1/departments", { name: "Ops" }, { "X-CSRF-Token": "x".repeat(32) });
    expect(wrong.status).toBe(403);
    const ok = await admin.post("/v1/departments", { name: "Ops" });
    expect(ok.status).toBe(201);
  });

  test("AUTH: reads do not need the CSRF token", async () => {
    const admin = await asPrincipal(h, "admin");
    const r = await h.request("GET", "/v1/tenant", { headers: { Cookie: admin.cred.cookie } });
    expect(r.status).toBe(200);
  });

  test("AUTH: owner and admin sessions expire after 30 minutes idle", async () => {
    const admin = await asPrincipal(h, "admin");
    h.clock.advance(29 * 60_000);
    expect((await admin.get("/v1/tenant")).status).toBe(200);
    h.clock.advance(29 * 60_000); // activity above reset the idle timer
    expect((await admin.get("/v1/tenant")).status).toBe(200);
    h.clock.advance(31 * 60_000);
    expect((await admin.get("/v1/tenant")).status).toBe(401);
  });

  test("AUTH: other sessions idle out after 8 hours, not 30 minutes", async () => {
    const member = await asPrincipal(h, "member");
    h.clock.advance(31 * 60_000);
    expect((await member.get("/v1/tenant")).status).toBe(200);
    h.clock.advance(8 * 3600_000 + 1);
    expect((await member.get("/v1/tenant")).status).toBe(401);
  });

  test("AUTH: sessions end at the 12 hour absolute limit despite activity", async () => {
    const member = await asPrincipal(h, "member");
    for (let i = 0; i < 11; i++) {
      h.clock.advance(3600_000);
      expect((await member.get("/v1/tenant")).status).toBe(200);
    }
    h.clock.advance(3600_000);
    expect((await member.get("/v1/tenant")).status).toBe(401);
  });

  test("AUTH: logout revokes the session and the WorkOS session", async () => {
    const r = await login({ userId: "user_admin_a", email: h.a.people.admin.email, orgId: h.a.workosOrgId });
    const cookie = `__Host-offload_session=${cookieValue(r.headers.get("set-cookie"), "__Host-offload_session")}`;
    const s = await h.request("GET", "/auth/session", { headers: { Cookie: cookie } });
    const noCsrf = await h.request("POST", "/auth/logout", { headers: { Cookie: cookie } });
    expect(noCsrf.status).toBe(403);
    const out = await h.request("POST", "/auth/logout", { headers: { Cookie: cookie, "X-CSRF-Token": s.json.csrfToken } });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("__Host-offload_session=;");
    expect((await h.request("GET", "/auth/session", { headers: { Cookie: cookie } })).status).toBe(401);
    expect(h.workos.revokedSessions.length).toBe(1);
  });

  test("AUTH: a frozen person's session stops working", async () => {
    const member2 = await asPrincipal(h, "member2");
    expect((await member2.get("/v1/tenant")).status).toBe(200);
    await h.db.migrator`update people set state = 'frozen' where id = ${h.a.people.member2.id}`;
    expect((await member2.get("/v1/tenant")).status).toBe(401);
    await h.db.migrator`update people set state = 'active' where id = ${h.a.people.member2.id}`;
  });
});
