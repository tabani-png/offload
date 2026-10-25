import type { App, Deps } from "../app.ts";
import { actorOf, authzPrincipal, body, principalOf, reply, tenantTx } from "../app.ts";
import { isUuid, withLookup, withTenant } from "../db/tenant.ts";
import { msNN, ms } from "../db/pool.ts";
import { b64url, fromB64url, randomToken, sha256Hex, ulid } from "../schema/encoding.ts";
import { forbidden, invalid, notFound, page, pageParams, unauthorized } from "../schema/http.ts";
import { authorize } from "../rbac/permissions.ts";
import { importEs256Public, signJwt, verifyEs256 } from "./jwt.ts";
import { DEVICE_AUDIENCE, TOKEN_ISSUER } from "./principal.ts";
import { DEVICE_NONCE_TTL_MS, DEVICE_TOKEN_TTL_MS, ENROLLMENT_CODE_TTL_MS } from "../config.ts";

const DE = "offload/stage2/device-enrollment.schema.json#/$defs";

/** Enrollment code: `<base64url(tenant uuid bytes)>.<secret>`; the tenant part routes, only sha256(code) is stored. */
export function makeEnrollmentCode(tenantId: string): string {
  return `${b64url(Buffer.from(tenantId.replace(/-/g, ""), "hex"))}.${randomToken(24)}`;
}

export function tenantOfEnrollmentCode(code: string): string | null {
  const i = code.indexOf(".");
  if (i !== 22) return null;
  const hex = Buffer.from(fromB64url(code.slice(0, i))).toString("hex");
  if (hex.length !== 32) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(id) ? id : null;
}

interface DeviceRow {
  id: string;
  person_id: string;
  name: string;
  app_version: string;
  enrolled_at: Date;
  last_sync_at: Date | null;
  state: "active" | "revoked";
}

function deviceDto(r: DeviceRow) {
  return {
    id: r.id,
    personId: r.person_id,
    name: r.name,
    appVersion: r.app_version,
    enrolledAt: msNN(r.enrolled_at),
    lastSyncAt: ms(r.last_sync_at),
    state: r.state,
  };
}

/** Looks a device up by id before its tenant is known (read-only `device_lookup` policy). */
async function lookupDevice(deps: Deps, deviceId: string) {
  return withLookup(deps.db, "lookup_device_id", deviceId, async (tx) => {
    const [d] = await tx`select tenant_id, person_id, state, public_key_jwk from devices where id = ${deviceId}`;
    return d as { tenant_id: string; person_id: string; state: string; public_key_jwk: { kty: string; crv: string; x: string; y: string } } | undefined;
  });
}

/** Device enrollment, challenge/token and revocation (ADR 0102 §3). */
export function deviceRoutes(app: App, deps: Deps): void {
  app.post("/v1/devices/enrollment-codes", async (c) => {
    await body(c, deps, "offload/control/empty.json");
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      if (p.kind !== "person") throw forbidden();
      const code = makeEnrollmentCode(p.tenantId);
      const expiresAt = now + ENROLLMENT_CODE_TTL_MS;
      await tx`insert into enrollment_codes (tenant_id, code_hash, person_id, created_at, expires_at)
        values (${p.tenantId}, ${sha256Hex(code)}, ${p.personId}, ${new Date(now)}, ${new Date(expiresAt)})`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "device.enrollment_code",
        subjectPersonId: p.personId,
        resource: { type: "enrollment_code", id: null },
      });
      return { code, expiresAt };
    });
    return reply(c, deps, 201, out, "offload/control/enrollment-code.json");
  });

  app.post("/v1/devices/enroll", async (c) => {
    const req = await body<{
      enrollmentCode: string;
      deviceName: string;
      appVersion: string;
      publicKeyJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
    }>(c, deps, `${DE}/request`);
    const tenantId = tenantOfEnrollmentCode(req.enrollmentCode);
    if (!tenantId) throw unauthorized("invalid enrollment code");
    try {
      await importEs256Public(req.publicKeyJwk);
    } catch {
      throw invalid("publicKeyJwk is not a valid P-256 public key");
    }
    const now = deps.clock.now();
    const out = await withTenant(deps.db, { tenantId, accessRole: "system" }, async (tx) => {
      // Single use: the UPDATE claims the code atomically.
      const [code] = await tx`update enrollment_codes set used_at = ${new Date(now)}
        where code_hash = ${sha256Hex(req.enrollmentCode)} and used_at is null and expires_at > ${new Date(now)}
        returning person_id`;
      if (!code) return null;
      const [person] = await tx`select access_role, state from people where id = ${code.person_id}`;
      if (!person || !["active", "leaving"].includes(person.state)) return null;
      const [d] = await tx`insert into devices (tenant_id, person_id, name, app_version, public_key_jwk, enrolled_at)
        values (${tenantId}, ${code.person_id}, ${req.deviceName}, ${req.appVersion},
          ${{ kty: "EC", crv: "P-256", x: req.publicKeyJwk.x, y: req.publicKeyJwk.y }}::jsonb, ${new Date(now)})
        returning id`;
      await deps.ports.audit.write(tx, {
        actor: { type: "person", id: code.person_id, accessRole: person.access_role },
        action: "device.enroll",
        subjectPersonId: code.person_id,
        resource: { type: "device", id: d!.id },
        detail: { name: req.deviceName, appVersion: req.appVersion },
      });
      return { deviceId: d!.id as string, personId: code.person_id as string, tenantId, enrolledAt: now };
    });
    if (!out) throw unauthorized("enrollment code is invalid, used or expired");
    return reply(c, deps, 201, out, `${DE}/response`);
  });

  app.post("/v1/devices/challenge", async (c) => {
    const { deviceId } = await body<{ deviceId: string }>(c, deps, "offload/control/challenge-request.json");
    const d = await lookupDevice(deps, deviceId);
    if (!d || d.state !== "active") throw unauthorized("unknown or revoked device");
    const now = deps.clock.now();
    const nonce = randomToken(32);
    const expiresAt = now + DEVICE_NONCE_TTL_MS;
    await withTenant(deps.db, { tenantId: d.tenant_id, principalId: deviceId, accessRole: "system" }, async (tx) => {
      await tx`insert into device_nonces (tenant_id, nonce, device_id, expires_at)
        values (${d.tenant_id}, ${nonce}, ${deviceId}, ${new Date(expiresAt)})`;
    });
    return reply(c, deps, 200, { nonce, expiresAt }, `${DE}/challenge`);
  });

  app.post("/v1/devices/token", async (c) => {
    const req = await body<{ deviceId: string; nonce: string; signature: string }>(c, deps, `${DE}/tokenRequest`);
    const d = await lookupDevice(deps, req.deviceId);
    if (!d || d.state !== "active") throw unauthorized("unknown or revoked device");
    const now = deps.clock.now();
    const ok = await withTenant(deps.db, { tenantId: d.tenant_id, principalId: req.deviceId, accessRole: "system" }, async (tx) => {
      const [n] = await tx`update device_nonces set used_at = ${new Date(now)}
        where nonce = ${req.nonce} and device_id = ${req.deviceId} and used_at is null and expires_at > ${new Date(now)}
        returning nonce`;
      return !!n;
    });
    if (!ok) throw unauthorized("nonce is unknown, used or expired");
    const key = await importEs256Public(d.public_key_jwk);
    if (!(await verifyEs256(key, req.nonce, req.signature))) throw unauthorized("bad signature over nonce");
    const expiresAt = now + DEVICE_TOKEN_TTL_MS;
    const accessToken = await signJwt(
      {
        iss: TOKEN_ISSUER,
        aud: DEVICE_AUDIENCE,
        sub: req.deviceId,
        tid: d.tenant_id,
        pid: d.person_id,
        iat: Math.floor(now / 1000),
        exp: Math.floor(expiresAt / 1000),
        jti: ulid(now),
      },
      deps.deviceKey,
    );
    return reply(c, deps, 200, { accessToken, expiresAt: Math.floor(expiresAt / 1000) * 1000 }, `${DE}/tokenResponse`);
  });

  app.get("/v1/devices", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
    const out = await tenantTx(c, deps, async (tx, p) => {
      const scope = c.get("scope");
      const rows = (await tx`select id, person_id, name, app_version, enrolled_at, last_sync_at, state from devices
        where (${scope === "S"} = false or person_id = ${p.personId})
          and (${after}::uuid is null or id > ${after}::uuid)
        order by id limit ${limit + 1}`) as DeviceRow[];
      return page(rows.map(deviceDto), limit, (l) => ({ id: l.id }));
    });
    return reply(c, deps, 200, out, "offload/control/device-list.json");
  });

  app.delete("/v1/devices/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound();
    const p0 = principalOf(c);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const [d] = (await tx`select id, person_id, name, app_version, enrolled_at, last_sync_at, state
        from devices where id = ${id}`) as DeviceRow[];
      if (!d) throw notFound();
      const dec = authorize(authzPrincipal(p0), c.get("perm")!, { personId: d.person_id }, new Set());
      if (!dec.allow) throw notFound();
      const now = deps.clock.now();
      const [r] = (await tx`update devices set state = 'revoked', revoked_at = coalesce(revoked_at, ${new Date(now)})
        where id = ${id} returning id, person_id, name, app_version, enrolled_at, last_sync_at, state`) as DeviceRow[];
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "device.revoke",
        subjectPersonId: d.person_id,
        resource: { type: "device", id },
      });
      return deviceDto(r!);
    });
    return reply(c, deps, 200, out, `${DE}/device`);
  });
}
