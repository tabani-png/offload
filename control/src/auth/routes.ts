import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { App, Deps } from "../app.ts";
import { actorOf, principalOf, reply, tenantTx } from "../app.ts";
import { withLookup, withTenant } from "../db/tenant.ts";
import { personById } from "../db/people.ts";
import { randomToken, safeEqual, sha256Hex } from "../schema/encoding.ts";
import { forbidden, notFound, unauthorized } from "../schema/http.ts";
import { verifyJwt } from "./jwt.ts";
import { SESSION_COOKIE, sessionPrincipal } from "./principal.ts";
import { SESSION_ABSOLUTE_MS } from "../config.ts";

export const STATE_COOKIE = "__Host-offload_oauth_state";

const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

/** Browser login round trip through WorkOS AuthKit (ADR 0102 §1-2), session read, and logout. */
export function authRoutes(app: App, deps: Deps): void {
  app.get("/auth/login", (c) => {
    const state = randomToken(24);
    setCookie(c, STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    return c.redirect(deps.workos.authorizationUrl({ state, redirectUri: deps.config.workos.redirectUri }), 302);
  });

  app.get("/auth/callback", async (c) => {
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
    const claims = await verifyJwt(auth.accessToken, await deps.workos.jwks(), { now });
    const orgId = auth.organizationId;
    if (!claims || !orgId || (claims.org_id !== undefined && claims.org_id !== orgId)) {
      throw unauthorized("login token rejected");
    }
    const tenant = await withLookup(deps.db, "lookup_workos_org", orgId, async (tx) => {
      const [t] = await tx`select id from tenants where workos_org_id = ${orgId}`;
      return t?.id as string | undefined;
    });
    if (!tenant) throw unauthorized("no tenant for this organization");

    const secret = randomToken(32);
    await withTenant(deps.db, { tenantId: tenant, accessRole: "system" }, async (tx) => {
      const [p] = await tx`select id, access_role, workos_user_id from people
        where (workos_user_id = ${auth.user.id} or (workos_user_id is null and lower(email) = lower(${auth.user.email})))
          and state in ('active', 'leaving')
        order by (workos_user_id is null) limit 1`;
      if (!p) throw unauthorized("no active person for this login");
      if (!p.workos_user_id) await tx`update people set workos_user_id = ${auth.user.id} where id = ${p.id}`;
      const [s] = await tx`insert into sessions (tenant_id, person_id, token_hash, csrf_token, workos_session_id,
          created_at, last_seen_at, expires_at)
        values (${tenant}, ${p.id}, ${sha256Hex(secret)}, ${randomToken(24)},
          ${typeof claims.sid === "string" ? claims.sid : null}, ${new Date(now)}, ${new Date(now)},
          ${new Date(now + SESSION_ABSOLUTE_MS)})
        returning id`;
      await deps.ports.audit.write(tx, {
        actor: { type: "person", id: p.id, accessRole: p.access_role },
        action: "session.create",
        subjectPersonId: p.id,
        resource: { type: "session", id: s!.id },
      });
    });
    setCookie(c, SESSION_COOKIE, `${tenant}.${secret}`, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 });
    return c.redirect(deps.config.afterLoginPath, 302);
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
