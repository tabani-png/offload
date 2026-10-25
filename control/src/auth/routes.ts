import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { App, AppEnv, Deps, PersonRole } from "../app.ts";
import { actorOf, principalOf, reply, tenantTx } from "../app.ts";
import { withLookup, withTenant } from "../db/tenant.ts";
import { personById } from "../db/people.ts";
import { b64url, fromB64url, randomToken, safeEqual, sha256Hex } from "../schema/encoding.ts";
import { HttpError, forbidden, invalid, notFound, unauthorized } from "../schema/http.ts";
import { parseCell, permission } from "../rbac/permissions.ts";
import { verifyJwt } from "./jwt.ts";
import { SESSION_COOKIE, sessionPrincipal } from "./principal.ts";
import { makeEnrollmentCode } from "./devices.ts";
import { ENROLLMENT_CODE_TTL_MS, SESSION_ABSOLUTE_MS } from "../config.ts";

export const STATE_COOKIE = "__Host-offload_oauth_state";
/** The Mac's loopback request (ADR 0111 §1), carried across the AuthKit round trip and bound to its oauth state. */
export const MAC_LOGIN_COOKIE = "__Host-offload_mac_login";
export const MAC_CLIENT = "offload-mac";

const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

// RFC 8252 §7.3 loopback redirect: exactly http://127.0.0.1:<port>/callback, nothing else (no other host, path,
// query, fragment or userinfo).
const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/;
const MAC_STATE = /^[\x20-\x7e]{1,512}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

interface MacLogin {
  redirectUri: string;
  state: string;
  challenge: string;
  /** The oauth state of the AuthKit round trip this request belongs to. */
  authState: string;
}

export function isLoopbackRedirect(uri: string): boolean {
  const m = LOOPBACK.exec(uri);
  return m !== null && Number(m[1]) <= 65535;
}

function loopback(uri: string, params: Record<string, string>): string {
  return `${uri}?${new URLSearchParams(params).toString()}`;
}

function readMacLogin(raw: string | undefined): MacLogin | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(fromB64url(raw))) as Partial<MacLogin>;
    if (typeof m.redirectUri !== "string" || !isLoopbackRedirect(m.redirectUri)) return null;
    if (typeof m.state !== "string" || !MAC_STATE.test(m.state)) return null;
    if (typeof m.challenge !== "string" || !CHALLENGE.test(m.challenge)) return null;
    if (typeof m.authState !== "string") return null;
    return m as MacLogin;
  } catch {
    return null;
  }
}

/** Whoever may mint enrollment codes by hand may enroll through the Mac login (same matrix row). */
const ENROLLMENT_CODES = permission("POST /v1/devices/enrollment-codes");

/** Browser login round trip through WorkOS AuthKit (ADR 0102 §1-2, ADR 0111 §1), session read, and logout. */
export function authRoutes(app: App, deps: Deps): void {
  app.get("/auth/login", (c) => {
    const state = randomToken(24);
    const client = c.req.queries("client");
    if (client !== undefined) {
      if (client.length !== 1 || client[0] !== MAC_CLIENT) throw invalid("unknown client");
      const one = (k: string) => {
        const v = c.req.queries(k);
        return v && v.length === 1 ? v[0]! : null;
      };
      const redirectUri = one("redirect_uri");
      // An unacceptable redirect_uri is never redirected to.
      if (redirectUri === null || !isLoopbackRedirect(redirectUri)) {
        throw invalid("redirect_uri must be http://127.0.0.1:<port>/callback");
      }
      const macState = one("state");
      if (macState === null || !MAC_STATE.test(macState)) throw invalid("state is required");
      const challenge = one("code_challenge");
      if (one("code_challenge_method") !== "S256" || challenge === null || !CHALLENGE.test(challenge)) {
        return c.redirect(loopback(redirectUri, { error: "invalid_request", state: macState }), 302);
      }
      const mac: MacLogin = { redirectUri, state: macState, challenge, authState: state };
      setCookie(c, MAC_LOGIN_COOKIE, b64url(new TextEncoder().encode(JSON.stringify(mac))), { ...cookieOpts, maxAge: 600 });
    } else if (getCookie(c, MAC_LOGIN_COOKIE)) {
      deleteCookie(c, MAC_LOGIN_COOKIE, cookieOpts);
    }
    setCookie(c, STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    return c.redirect(deps.workos.authorizationUrl({ state, redirectUri: deps.config.workos.redirectUri }), 302);
  });

  app.get("/auth/callback", async (c) => {
    const raw = readMacLogin(getCookie(c, MAC_LOGIN_COOKIE));
    if (raw) deleteCookie(c, MAC_LOGIN_COOKIE, cookieOpts);
    // A Mac request left over from another login round trip is not this one's: this is a plain web login.
    const st = c.req.query("state");
    const mac = raw && st && safeEqual(raw.authState, st) ? raw : null;
    try {
      return await callback(c, deps, mac);
    } catch (err) {
      // The Mac is told through its loopback, with its state; it never sees why.
      if (mac && err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        return c.redirect(loopback(mac.redirectUri, { error: "access_denied", state: mac.state }), 302);
      }
      throw err;
    }
  });

  app.get("/auth/session", async (c) => {
    const p = principalOf(c);
    if (p.kind !== "person") throw forbidden();
    const person = await tenantTx(c, deps, (tx) => personById(tx, p.personId));
    if (!person) throw notFound();
    return reply(c, deps, 200, { person, csrfToken: p.csrfToken }, "offload/control/auth-session.json");
  });

  app.post("/auth/logout", async (c) => {
    const p = await sessionPrincipal(deps, getCookie(c, SESSION_COOKIE));
    if (p && p.kind === "person") {
      if (!safeEqual(c.req.header("X-CSRF-Token") ?? "", p.csrfToken)) throw forbidden("missing or wrong X-CSRF-Token");
      const workosSid = await withTenant(deps.db, { tenantId: p.tenantId, principalPersonId: p.personId }, async (tx) => {
        const [s] = await tx`update sessions set revoked_at = ${new Date(deps.clock.now())}
          where id = ${p.sessionId} returning workos_session_id`;
        await deps.ports.audit.write(tx, {
          actor: actorOf(p),
          action: "session.revoke",
          subjectPersonId: p.personId,
          resource: { type: "session", id: p.sessionId },
        });
        return s?.workos_session_id as string | null;
      });
      if (workosSid) await deps.workos.revokeSession(workosSid).catch(() => undefined);
    }
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    return c.body(null, 204);
  });
}

/** /auth/callback: AuthKit code → session; for a Mac login also a one-time PKCE-bound enrollment code. */
async function callback(c: Context<AppEnv>, deps: Deps, mac: MacLogin | null): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expected = getCookie(c, STATE_COOKIE);
  if (!code || !state || !expected || !safeEqual(state, expected)) throw unauthorized("login state mismatch");
  deleteCookie(c, STATE_COOKIE, cookieOpts);

  let auth: Awaited<ReturnType<Deps["workos"]["authenticateWithCode"]>>;
  try {
    auth = await deps.workos.authenticateWithCode(code);
  } catch {
    throw unauthorized("login code rejected");
  }
  const now = deps.clock.now();
  const claims = await verifyJwt(auth.accessToken, await deps.workos.jwks(), {
    now,
    issuer: deps.config.workos.issuer,
    ...(deps.config.workos.audience ? { audience: deps.config.workos.audience } : {}),
  });
  const orgId = auth.organizationId;
  if (!claims || !orgId || (claims.org_id !== undefined && claims.org_id !== orgId)) {
    throw unauthorized("login token rejected");
  }
  // Without a configured audience, a token that names an audience or a client must still name this client.
  const id = deps.config.workos.clientId;
  if (!deps.config.workos.audience && claims.aud !== undefined) {
    const aud = claims.aud;
    if (!(aud === id || (Array.isArray(aud) && aud.includes(id)))) throw unauthorized("login token rejected");
  }
  if (claims.client_id !== undefined && claims.client_id !== id) throw unauthorized("login token rejected");
  const tenant = await withLookup(deps.db, "lookup_workos_org", orgId, async (tx) => {
    const [t] = await tx`select id from tenants where workos_org_id = ${orgId}`;
    return t?.id as string | undefined;
  });
  if (!tenant) throw unauthorized("no tenant for this organization");

  const secret = randomToken(32);
  const enrollmentCode = await withTenant(deps.db, { tenantId: tenant, accessRole: "system" }, async (tx) => {
    const [p] = await tx`select id, access_role, workos_user_id from people
      where (workos_user_id = ${auth.user.id} or (workos_user_id is null and lower(email) = lower(${auth.user.email})))
        and state in ('active', 'leaving')
      order by (workos_user_id is null) limit 1`;
    if (!p) throw unauthorized("no active person for this login");
    if (mac && parseCell(ENROLLMENT_CODES.roles[p.access_role as PersonRole]).scope === null) {
      throw forbidden("this access role cannot enroll devices");
    }
    if (!p.workos_user_id) await tx`update people set workos_user_id = ${auth.user.id} where id = ${p.id}`;
    const [s] = await tx`insert into sessions (tenant_id, person_id, token_hash, csrf_token, workos_session_id,
        created_at, last_seen_at, expires_at)
      values (${tenant}, ${p.id}, ${sha256Hex(secret)}, ${randomToken(24)},
        ${typeof claims.sid === "string" ? claims.sid : null}, ${new Date(now)}, ${new Date(now)},
        ${new Date(now + SESSION_ABSOLUTE_MS)})
      returning id`;
    const actor = { type: "person" as const, id: p.id as string, accessRole: p.access_role as PersonRole };
    await deps.ports.audit.write(tx, {
      actor,
      action: "session.create",
      subjectPersonId: p.id,
      resource: { type: "session", id: s!.id },
    });
    if (!mac) return null;
    // One-time, 10 minutes, bound to this person, this tenant and the Mac's code_challenge.
    const ec = makeEnrollmentCode(tenant);
    await tx`insert into enrollment_codes (tenant_id, code_hash, person_id, created_at, expires_at, code_challenge)
      values (${tenant}, ${sha256Hex(ec)}, ${p.id}, ${new Date(now)}, ${new Date(now + ENROLLMENT_CODE_TTL_MS)},
        ${mac.challenge})`;
    await deps.ports.audit.write(tx, {
      actor,
      action: "device.enrollment_code",
      subjectPersonId: p.id,
      resource: { type: "enrollment_code", id: null },
      detail: { method: "pkce" },
    });
    return ec;
  });
  setCookie(c, SESSION_COOKIE, `${tenant}.${secret}`, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 });
  if (mac && enrollmentCode) return c.redirect(loopback(mac.redirectUri, { code: enrollmentCode, state: mac.state }), 302);
  return c.redirect(deps.config.afterLoginPath, 302);
}
