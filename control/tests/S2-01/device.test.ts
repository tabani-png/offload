import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  asDevice, asPrincipal, createHarness, deviceToken, enrollDevice, newDeviceKeys, signNonce, type Client, type Harness,
} from "../helpers/harness.ts";

let h: Harness;
let member: Client;
beforeAll(async () => {
  h = await createHarness();
  member = await asPrincipal(h, "member");
});
afterAll(() => h.close());

async function code(c: Client = member): Promise<string> {
  const r = await c.post("/v1/devices/enrollment-codes");
  expect(r.status).toBe(201);
  return r.json.code;
}

async function enroll(enrollmentCode: string) {
  const { keys, jwk } = await newDeviceKeys();
  const r = await h.request("POST", "/v1/devices/enroll", {
    body: { enrollmentCode, deviceName: "Jo's Mac", appVersion: "2.0.0", publicKeyJwk: jwk },
  });
  return { r, keys };
}

describe("DEVICE", () => {
  test("DEVICE: enrollment codes last 10 minutes and are not for auditors", async () => {
    const r = await member.post("/v1/devices/enrollment-codes");
    expect(r.status).toBe(201);
    expect(r.json.expiresAt).toBe(h.clock.now() + 10 * 60_000);
    const auditor = await asPrincipal(h, "auditor");
    expect((await auditor.post("/v1/devices/enrollment-codes")).status).toBe(403);
  });

  test("DEVICE: enroll with a valid code once registers the device for that person", async () => {
    const { r } = await enroll(await code());
    expect(r.status).toBe(201);
    expect(r.json.personId).toBe(h.a.people.member.id);
    expect(r.json.tenantId).toBe(h.a.id);
    const list = await member.get("/v1/devices");
    expect(list.json.items.map((d: { id: string }) => d.id)).toContain(r.json.deviceId);
    const [ev] = await h.db.migrator`select 1 from audit_events where action = 'device.enroll' and resource_id = ${r.json.deviceId}`;
    expect(ev).toBeTruthy();
  });

  test("DEVICE: a reused enrollment code is 401", async () => {
    const c = await code();
    expect((await enroll(c)).r.status).toBe(201);
    expect((await enroll(c)).r.status).toBe(401);
  });

  test("DEVICE: an expired enrollment code is 401", async () => {
    const c = await code();
    h.clock.advance(10 * 60_000 + 1);
    expect((await enroll(c)).r.status).toBe(401);
  });

  test("DEVICE: a made-up or tenant-swapped enrollment code is 401", async () => {
    expect((await enroll("x".repeat(40))).r.status).toBe(401);
    const c = await code();
    const swapped = `${Buffer.from(h.b.id.replace(/-/g, ""), "hex").toString("base64url")}.${c.split(".")[1]}`;
    expect((await enroll(swapped)).r.status).toBe(401);
  });

  test("DEVICE: a public key that is not a P-256 point is 400", async () => {
    const r = await h.request("POST", "/v1/devices/enroll", {
      body: { enrollmentCode: await code(), deviceName: "Mac", appVersion: "1", publicKeyJwk: { kty: "EC", crv: "P-256", x: "AAAA", y: "AAAA" } },
    });
    expect(r.status).toBe(400);
  });

  test("DEVICE: challenge + signed nonce mints a 15 minute ES256 device token", async () => {
    const { r, keys } = await enroll(await code());
    const ch = await h.request("POST", "/v1/devices/challenge", { body: { deviceId: r.json.deviceId } });
    expect(ch.status).toBe(200);
    const tk = await h.request("POST", "/v1/devices/token", {
      body: { deviceId: r.json.deviceId, nonce: ch.json.nonce, signature: await signNonce(keys.privateKey, ch.json.nonce) },
    });
    expect(tk.status).toBe(200);
    expect(tk.json.expiresAt).toBe(Math.floor((h.clock.now() + 15 * 60_000) / 1000) * 1000);
    const header = JSON.parse(Buffer.from(tk.json.accessToken.split(".")[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(tk.json.accessToken.split(".")[1], "base64url").toString());
    expect(header.alg).toBe("ES256");
    expect(claims.aud).toBe("device");
    // Device column of the matrix: sync is the device's (later slice → 404 until built), org reads are not (403).
    const dev = asDevice(h, tk.json.accessToken);
    expect((await dev("GET", "/v1/sync/config")).status).toBe(404);
    expect((await dev("GET", "/v1/tenant")).status).toBe(403);
  });

  test("DEVICE: a signature from another key is 401", async () => {
    const { r } = await enroll(await code());
    const other = await newDeviceKeys();
    const ch = await h.request("POST", "/v1/devices/challenge", { body: { deviceId: r.json.deviceId } });
    const tk = await h.request("POST", "/v1/devices/token", {
      body: { deviceId: r.json.deviceId, nonce: ch.json.nonce, signature: await signNonce(other.keys.privateKey, ch.json.nonce) },
    });
    expect(tk.status).toBe(401);
  });

  test("DEVICE: a nonce is single use, expires, and belongs to one device", async () => {
    const one = await enroll(await code());
    const two = await enroll(await code());
    const ch = await h.request("POST", "/v1/devices/challenge", { body: { deviceId: one.r.json.deviceId } });
    const sig = await signNonce(one.keys.privateKey, ch.json.nonce);
    const twoSig = await signNonce(two.keys.privateKey, ch.json.nonce);
    expect((await h.request("POST", "/v1/devices/token", { body: { deviceId: two.r.json.deviceId, nonce: ch.json.nonce, signature: twoSig } })).status).toBe(401);
    expect((await h.request("POST", "/v1/devices/token", { body: { deviceId: one.r.json.deviceId, nonce: ch.json.nonce, signature: sig } })).status).toBe(200);
    expect((await h.request("POST", "/v1/devices/token", { body: { deviceId: one.r.json.deviceId, nonce: ch.json.nonce, signature: sig } })).status).toBe(401);
    const late = await h.request("POST", "/v1/devices/challenge", { body: { deviceId: one.r.json.deviceId } });
    h.clock.advance(5 * 60_000 + 1);
    const lateSig = await signNonce(one.keys.privateKey, late.json.nonce);
    expect((await h.request("POST", "/v1/devices/token", { body: { deviceId: one.r.json.deviceId, nonce: late.json.nonce, signature: lateSig } })).status).toBe(401);
  });

  test("DEVICE: challenge for an unknown device is 401", async () => {
    const r = await h.request("POST", "/v1/devices/challenge", { body: { deviceId: crypto.randomUUID() } });
    expect(r.status).toBe(401);
  });

  test("DEVICE: a device token stops working after 15 minutes", async () => {
    const dev = await enrollDevice(h, member);
    h.clock.advance(15 * 60_000 + 1000);
    expect((await asDevice(h, dev.token)("GET", "/v1/sync/config")).status).toBe(401);
  });

  test("DEVICE: a tampered device token is 401", async () => {
    const dev = await enrollDevice(h, member);
    const [hd, body, sig] = dev.token.split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    claims.pid = h.a.people.owner.id;
    const tampered = `${hd}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    expect((await asDevice(h, tampered)("GET", "/v1/sync/config")).status).toBe(401);
  });

  test("DEVICE: a revoked device is 401 for its token, challenges and new tokens", async () => {
    const dev = await enrollDevice(h, member);
    const del = await member.del(`/v1/devices/${dev.deviceId}`);
    expect(del.status).toBe(200);
    expect(del.json.state).toBe("revoked");
    expect((await asDevice(h, dev.token)("GET", "/v1/sync/config")).status).toBe(401);
    expect((await h.request("POST", "/v1/devices/challenge", { body: { deviceId: dev.deviceId } })).status).toBe(401);
    await expect(deviceToken(h, dev.deviceId, dev.keys.privateKey)).rejects.toThrow();
  });

  test("DEVICE: a member sees and revokes only their own devices; an admin any in the tenant", async () => {
    const other = await asPrincipal(h, "member2");
    const mine = await enrollDevice(h, member);
    const theirs = await enrollDevice(h, other);
    const list = await member.get("/v1/devices?limit=200");
    const ids = list.json.items.map((d: { id: string }) => d.id);
    expect(ids).toContain(mine.deviceId);
    expect(ids).not.toContain(theirs.deviceId);
    expect((await member.del(`/v1/devices/${theirs.deviceId}`)).status).toBe(404);
    const admin = await asPrincipal(h, "admin");
    expect((await admin.del(`/v1/devices/${theirs.deviceId}`)).status).toBe(200);
  });

  test("DEVICE: a device whose person is frozen is 401", async () => {
    const lead = await asPrincipal(h, "lead");
    const dev = await enrollDevice(h, lead);
    await h.db.migrator`update people set state = 'frozen' where id = ${h.a.people.lead.id}`;
    expect((await asDevice(h, dev.token)("GET", "/v1/sync/config")).status).toBe(401);
    await h.db.migrator`update people set state = 'active' where id = ${h.a.people.lead.id}`;
  });
});
