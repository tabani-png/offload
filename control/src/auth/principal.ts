import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv, Deps, PersonRole, Principal } from "../app.ts";
import { isUuid, withTenant } from "../db/tenant.ts";
import { sha256Hex } from "../schema/encoding.ts";
import { verifyJwt } from "./jwt.ts";
import { SESSION_IDLE_MS, SESSION_IDLE_PRIVILEGED_MS } from "../config.ts";

export const SESSION_COOKIE = "__Host-offload_session";
export const DEVICE_AUDIENCE = "device";
export const TOKEN_ISSUER = "offload-control";

/** Session cookie value: `<tenantId>.<secret>`. Only sha256(secret) is stored; the tenant part is a routing hint. */
export function parseSessionCookie(v: string | undefined): { tenantId: string; secret: string } | null {
  if (!v) return null;
  const i = v.indexOf(".");
  const tenantId = v.slice(0, i);
  const secret = v.slice(i + 1);
  if (i < 0 || !isUuid(tenantId) || secret.length < 32 || secret.length > 128) return null;
  return { tenantId, secret };
}

export function idleLimitMs(role: PersonRole): number {
  return role === "owner" || role === "admin" ? SESSION_IDLE_PRIVILEGED_MS : SESSION_IDLE_MS;
}

const ACTIVE_STATES = new Set(["active", "leaving"]);

interface SessionRow {
  id: string;
  person_id: string;
  csrf_token: string;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  access_role: PersonRole;
  dept_lead_of: string[];
  jurisdiction: string;
  state: string;
}

/** Loads and touches a web session. Null when missing, revoked, idle, past its absolute expiry, or the person left. */
export async function sessionPrincipal(deps: Deps, cookie: string | undefined): Promise<Principal | null> {
  const parsed = parseSessionCookie(cookie);
  if (!parsed) return null;
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId: parsed.tenantId }, async (tx) => {
    const [s] = (await tx`select s.id, s.person_id, s.csrf_token, s.last_seen_at, s.expires_at, s.revoked_at,
        p.access_role, p.dept_lead_of, p.jurisdiction, p.state
      from sessions s join people p on p.tenant_id = s.tenant_id and p.id = s.person_id
      where s.token_hash = ${sha256Hex(parsed.secret)}`) as SessionRow[];
    if (!s || s.revoked_at || s.expires_at.getTime() <= now || !ACTIVE_STATES.has(s.state)) return null;
    if (now - s.last_seen_at.getTime() > idleLimitMs(s.access_role)) return null;
    await tx`update sessions set last_seen_at = ${new Date(now)} where id = ${s.id}`;
    return {
      kind: "person" as const,
      tenantId: parsed.tenantId,
      personId: s.person_id,
      accessRole: s.access_role,
      departmentScope: s.dept_lead_of,
      jurisdiction: s.jurisdiction,
      sessionId: s.id,
      csrfToken: s.csrf_token,
    };
  });
}

/** Verifies a device access token (ES256, aud device) and that the device and its person are still active. */
export async function devicePrincipal(deps: Deps, token: string): Promise<Principal | null> {
  const now = deps.clock.now();
  const claims = await verifyJwt(token, { keys: [deps.deviceKey.publicJwk] }, {
    audience: DEVICE_AUDIENCE,
    issuer: TOKEN_ISSUER,
    now,
  });
  if (!claims || !isUuid(claims.tid) || !isUuid(claims.sub)) return null;
  const tenantId = claims.tid;
  const deviceId = claims.sub;
  return withTenant(deps.db, { tenantId, principalId: deviceId }, async (tx) => {
    const [d] = await tx`select d.person_id, p.access_role, p.dept_lead_of, p.jurisdiction, p.state
      from devices d join people p on p.tenant_id = d.tenant_id and p.id = d.person_id
      where d.id = ${deviceId} and d.state = 'active'`;
    if (!d || !ACTIVE_STATES.has(d.state)) return null;
    return {
      kind: "device" as const,
      tenantId,
      personId: d.person_id as string,
      deviceId,
      accessRole: d.access_role as PersonRole,
      departmentScope: d.dept_lead_of as string[],
      jurisdiction: d.jurisdiction as string,
    };
  });
}

/** Bearer device token if present, otherwise the session cookie. */
export async function authenticate(c: Context<AppEnv>, deps: Deps): Promise<Principal | null> {
  const auth = c.req.header("Authorization");
  if (auth !== undefined) {
    const m = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(auth);
    return m ? devicePrincipal(deps, m[1]!) : null;
  }
  return sessionPrincipal(deps, getCookie(c, SESSION_COOKIE));
}
