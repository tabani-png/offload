import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createHarness, newDeviceKeys, type Harness, type Res } from "../helpers/harness.ts";
import type { FakeLogin } from "../helpers/fake-workos.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

/** The Mac side of ADR 0111 §1, as brain/src/sync/enroll.ts does it. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const PORT = 53117;
const LOOPBACK = `http://127.0.0.1:${PORT}/callback`;

function cookiesOf(r: Res): string {
  return r.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("=")).join("; ");
}

function loginQuery(over: Record<string, string | null> = {}) {
  const { challenge, verifier } = pkce();
  const base: Record<string, string | null> = {
    client: "offload-mac", redirect_uri: LOOPBACK, state: `st_${randomBytes(8).toString("base64url")}`,
    code_challenge: challenge, code_challenge_method: "S256", ...over,
  };
  const q = new URLSearchParams(Object.entries(base).filter(([, v]) => v !== null) as Array<[string, string]>);
  return { q, verifier, state: base.state! };
}

/** /auth/login?client=offload-mac... → AuthKit (fake) → /auth/callback → redirect to the loopback. */
async function macLogin(user: FakeLogin, over: Record<string, string | null> = {}) {
  const { q, verifier, state } = loginQuery(over);
  const start = await h.request("GET", `/auth/login?${q}`);
  expect(start.status).toBe(302);
  const authState = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const code = h.workos.issueCode(user);
  const cb = await h.request("GET", `/auth/callback?code=${code}&state=${authState}`, { headers: { Cookie: cookiesOf(start) } });
  return { cb, verifier, state, loc: cb.headers.get("location") ? new URL(cb.headers.get("location")!) : null };
}

const leadLogin = (): FakeLogin => ({ userId: "user_lead_a", email: h.a.people.lead.email, orgId: h.a.workosOrgId });

async function enroll(code: string, verifier: string | null) {
  const { jwk } = await newDeviceKeys();
  return h.request("POST", "/v1/devices/enroll", {
    body: { enrollmentCode: code, deviceName: "Lead's Mac", appVersion: "2.0.0", publicKeyJwk: jwk },
    headers: verifier === null ? {} : { "Offload-Code-Verifier": verifier },
  });
}

describe("DEVICE loopback PKCE enrollment (ADR 0111 §1)", () => {
  test("DEVICE: login with client=offload-mac redirects to the loopback with a one-time code and the state", async () => {
    const { cb, loc, verifier, state } = await macLogin(leadLogin());
    expect(cb.status).toBe(302);
    expect(`${loc!.origin}${loc!.pathname}`).toBe(LOOPBACK);
    expect(loc!.searchParams.get("state")).toBe(state);
    expect(loc!.searchParams.get("error")).toBeNull();
    const code = loc!.searchParams.get("code")!;
    expect(code.length).toBeGreaterThanOrEqual(16);
    const r = await enroll(code, verifier);
    expect(r.status).toBe(201);
    expect(r.json.personId).toBe(h.a.people.lead.id);
    expect(r.json.tenantId).toBe(h.a.id);
    const [ev] = await h.db.migrator`select actor_id, detail from audit_events
      where tenant_id = ${h.a.id} and action = 'device.enrolled' and resource_id = ${r.json.deviceId}`;
    expect(ev!.actor_id).toBe(h.a.people.lead.id);
    expect(ev!.detail.method).toBe("pkce");
  });

  test("DEVICE: the state comes back unchanged, also on an error redirect", async () => {
    const odd = "a.b~c-d_e%20f";
    const ok = await macLogin(leadLogin(), { state: odd });
    expect(ok.loc!.searchParams.get("state")).toBe(odd);
    // Signed in at AuthKit, but nobody in the tenant has that email: error back to the Mac, with its state, no code.
    const no = await macLogin({ userId: "user_ghost", email: "ghost@nowhere.example.com", orgId: h.a.workosOrgId }, { state: "keep-me" });
    expect(`${no.loc!.origin}${no.loc!.pathname}`).toBe(LOOPBACK);
    expect(no.loc!.searchParams.get("error")).toBe("access_denied");
    expect(no.loc!.searchParams.get("state")).toBe("keep-me");
    expect(no.loc!.searchParams.get("code")).toBeNull();
    // A plain or missing challenge is refused back to the Mac too.
    const overs: Array<Record<string, string | null>> = [{ code_challenge_method: "plain" }, { code_challenge: null }, { code_challenge: "short" }];
    for (const over of overs) {
      const { q, state } = loginQuery(over);
      const r = await h.request("GET", `/auth/login?${q}`);
      expect(r.status).toBe(302);
      const loc = new URL(r.headers.get("location")!);
      expect(`${loc.origin}${loc.pathname}`).toBe(LOOPBACK);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("state")).toBe(state);
    }
  });

  test("DEVICE: a wrong or missing Offload-Code-Verifier is 401 and burns the code", async () => {
    const a = await macLogin(leadLogin());
    const code = a.loc!.searchParams.get("code")!;
    expect((await enroll(code, pkce().verifier)).status).toBe(401);
    expect((await enroll(code, a.verifier)).status).toBe(401);
    const b = await macLogin(leadLogin());
    expect((await enroll(b.loc!.searchParams.get("code")!, null)).status).toBe(401);
    const c = await macLogin(leadLogin());
    expect((await enroll(c.loc!.searchParams.get("code")!, "x")).status).toBe(401);
  });

  test("DEVICE: a PKCE code is single use", async () => {
    const { loc, verifier } = await macLogin(leadLogin());
    const code = loc!.searchParams.get("code")!;
    expect((await enroll(code, verifier)).status).toBe(201);
    expect((await enroll(code, verifier)).status).toBe(401);
  });

  test("DEVICE: a PKCE code expires after 10 minutes", async () => {
    const { loc, verifier } = await macLogin(leadLogin());
    h.clock.advance(10 * 60_000 + 1);
    expect((await enroll(loc!.searchParams.get("code")!, verifier)).status).toBe(401);
  });

  test("DEVICE: only http://127.0.0.1:<port>/callback is accepted as redirect_uri", async () => {
    const bad = [
      `http://localhost:${PORT}/callback`, `https://127.0.0.1:${PORT}/callback`, `http://127.0.0.1:${PORT}/other`,
      "http://127.0.0.1/callback", `http://127.0.0.1:${PORT}/callback?x=1`, `http://127.0.0.1:${PORT}/callback#f`,
      `http://127.0.0.1:${PORT}@evil.example.com/callback`, "http://evil.example.com/callback", "http://127.0.0.1:99999/callback",
      "http://127.0.0.1:0/callback", `http://127.0.0.1:${PORT}/callback/`, `http://[::1]:${PORT}/callback`, "",
    ];
    for (const redirect_uri of bad) {
      const { q } = loginQuery({ redirect_uri });
      const r = await h.request("GET", `/auth/login?${q}`);
      expect({ redirect_uri, status: r.status, location: r.headers.get("location") }).toEqual({ redirect_uri, status: 400, location: null });
    }
    const { q } = loginQuery({ client: "someone-else" });
    expect((await h.request("GET", `/auth/login?${q}`)).status).toBe(400);
    const two = loginQuery();
    two.q.append("redirect_uri", "http://evil.example.com/callback");
    expect((await h.request("GET", `/auth/login?${two.q}`)).status).toBe(400);
  });

  test("DEVICE: the code is bound to the signed-in person's tenant", async () => {
    const { loc, verifier } = await macLogin({ userId: "user_member_b", email: h.b.people.member.email, orgId: h.b.workosOrgId });
    const code = loc!.searchParams.get("code")!;
    // Pointing the routing part at tenant A finds nothing: the code exists only in B.
    const swapped = `${Buffer.from(h.a.id.replace(/-/g, ""), "hex").toString("base64url")}.${code.split(".")[1]}`;
    expect((await enroll(swapped, verifier)).status).toBe(401);
    const r = await enroll(code, verifier);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ tenantId: h.b.id, personId: h.b.people.member.id });
    const [row] = await h.db.migrator`select tenant_id, person_id, code_challenge from enrollment_codes
      where person_id = ${h.b.people.member.id} and code_challenge is not null`;
    expect(row!.tenant_id).toBe(h.b.id);
  });

  test("DEVICE: an auditor's Mac login gets access_denied, like the enrollment-codes endpoint", async () => {
    const { loc } = await macLogin({ userId: "user_auditor_a", email: h.a.people.auditor.email, orgId: h.a.workosOrgId });
    expect(loc!.searchParams.get("error")).toBe("access_denied");
    expect(loc!.searchParams.get("code")).toBeNull();
  });

  test("DEVICE: admin-issued codes still enroll without a verifier", async () => {
    const { asPrincipal } = await import("../helpers/harness.ts");
    const member = await asPrincipal(h, "member");
    const code = await member.post("/v1/devices/enrollment-codes");
    expect((await enroll(code.json.code, null)).status).toBe(201);
  });
});
