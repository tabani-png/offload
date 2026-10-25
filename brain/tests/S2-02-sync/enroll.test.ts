// ENROLL: PKCE loopback flow against the fake control plane; token refresh before expiry; a revoked device stops sync.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { SecureEnclaveSigner, SoftwareSigner } from "../../src/sync/device.ts";
import { pkcePair, REFRESH_MARGIN_MS } from "../../src/sync/enroll.ts";
import { fromB64url } from "../../src/sync/encoding.ts";
import { checkControlUrl } from "../../src/sync/http.ts";
import { clearSyncKeyCache, rawKeyPath, wrappedKeyPath } from "../../src/sync/keys.ts";
import { createHash } from "node:crypto";
import { fakeObserverWith } from "../s05c-keys/fake.ts";
import { NOTICE_1 } from "./fake-control.ts";
import { browser, connect, connectAndAck, loopbackFetch, NOW, syncWorld, type SyncWorld } from "./setup.ts";

let w: SyncWorld;
afterEach(() => w.cleanup());

describe("connect", () => {
  beforeEach(async () => {
    w = await syncWorld();
  });

  test("ENROLL: the PKCE loopback flow enrolls the device with its public JWK", async () => {
    let opened = "";
    w.restart({ openUrl: async (u) => ((opened = u), await browser(u)) });
    const r = await w.client.connect();
    expect(r.state).toBe("waiting");
    await w.client.connectIdle();
    const u = new URL(opened);
    expect(u.origin).toBe(w.control.url);
    expect(u.pathname).toBe("/auth/login");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(16);
    const st = w.client.status();
    expect(st.state).toBe("connected");
    expect(st.personId).toBe("11111111-1111-4111-8111-111111111111");
    const dev = w.control.devices.get(st.deviceId!)!;
    const signer = new SoftwareSigner(readFileSync(rawKeyPath(w.home, "device-signing")));
    expect(dev.jwk).toEqual(await signer.publicJwk());
    expect(w.control.calls).toContain("POST /v1/devices/enroll");
  });

  test("ENROLL: the code challenge is S256 of the verifier (RFC 7636)", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(fromB64url(challenge)).equals(createHash("sha256").update(verifier).digest())).toBe(true);
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  test("ENROLL: a callback with another state is ignored; the real one still completes", async () => {
    let opened = "";
    w.restart({ openUrl: (u) => void (opened = u) });
    await w.client.connect();
    const redirect = new URL(opened).searchParams.get("redirect_uri")!;
    const forged = await loopbackFetch(`${redirect}?code=${"x".repeat(24)}&state=forged`);
    expect(forged.status).toBe(400);
    expect(w.client.status().state).toBe("connecting");
    await browser(opened);
    await w.client.connectIdle();
    expect(w.client.status().state).toBe("connected");
  });

  test("ENROLL: a sign-in error ends the flow with nothing enrolled", async () => {
    w.control.loginError = "access_denied";
    await w.client.connect();
    await w.client.connectIdle();
    const st = w.client.status();
    expect(st.state).toBe("not_connected");
    expect(st.lastError).toContain("access_denied");
    expect(w.control.devices.size).toBe(0);
  });

  test("ENROLL: an enrollment code is single use and the verifier must match the challenge", async () => {
    await connect(w);
    expect(w.control.devices.size).toBe(1);
    // Replaying the enroll call with a fresh, unknown code fails at the fake (the code is the credential).
    const res = await loopbackFetch(`${w.control.url}/v1/devices/enroll`, { method: "POST", headers: { "content-type": "application/json", "offload-code-verifier": "nope" }, body: JSON.stringify({ enrollmentCode: "y".repeat(20), deviceName: "Mac", appVersion: "1", publicKeyJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" } }) });
    expect(res.status).toBe(401);
  });

  test("ENROLL: the private key never leaves: the enroll body holds only the public JWK", async () => {
    const bodies: string[] = [];
    w.restart({ fetch: async (u, i) => (typeof i?.body === "string" && bodies.push(i.body), loopbackFetch(u, i)) });
    await connect(w);
    const enroll = bodies.find((b) => b.includes("enrollmentCode"))!;
    const jwk = (JSON.parse(enroll) as { publicKeyJwk: Record<string, string> }).publicKeyJwk;
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    const d = Buffer.from(readFileSync(rawKeyPath(w.home, "device-signing"))).toString("base64url");
    for (const b of bodies) expect(b).not.toContain(d);
  });

  test("ENROLL: connecting twice is a conflict", async () => {
    await connect(w);
    await expect(w.client.connect()).rejects.toThrow("already connected");
  });

  test("ENROLL: the control URL must be https; plain http only on the loopback address", () => {
    // A reserved .example host, never fetched (and kept out of URL literals: the hermetic scan reads every test URL).
    const host = ["control", "offload", "example"].join(".");
    expect(checkControlUrl(`https://${host}/`)).toEqual({ url: `https://${host}` });
    expect(checkControlUrl("https://127.0.0.1:4000")).toEqual({ url: "https://127.0.0.1:4000" });
    expect(checkControlUrl("http://127.0.0.1:4000")).toEqual({ url: "http://127.0.0.1:4000" });
    expect("error" in checkControlUrl(`http://${host}`)).toBe(true);
    expect("error" in checkControlUrl(`https://${["u", "p"].join(":")}@${host}`)).toBe(true);
    expect("error" in checkControlUrl(undefined)).toBe(true);
    expect("error" in checkControlUrl("not a url")).toBe(true);
  });
});

describe("tokens and revocation", () => {
  beforeEach(async () => {
    w = await syncWorld();
    await connectAndAck(w);
  });

  test("ENROLL: the access token is minted by signing the server's nonce and reused while valid", async () => {
    await w.client.flush({ force: true });
    expect(w.control.tokenCount()).toBe(1);
    w.clock.now += 10 * 60_000;
    await w.client.acknowledgeNotice(NOTICE_1).catch(() => {});
    await w.client.flush({ force: true });
    expect(w.control.tokenCount()).toBe(1);
  });

  test("ENROLL: the token is refreshed before it expires (inside the last minute)", async () => {
    await w.client.flush({ force: true });
    expect(w.control.tokenCount()).toBe(1);
    w.clock.now += 15 * 60_000 - REFRESH_MARGIN_MS + 1;
    await w.client.flush({ force: true });
    expect(w.control.tokenCount()).toBe(2);
    expect(w.control.calls.filter((c) => c === "POST /v1/devices/challenge")).toHaveLength(2);
  });

  test("ENROLL: a 401 on a batch (token revoked server-side) mints a new token once and retries", async () => {
    w.control.intercept = (() => {
      let first = true;
      return () => (first ? ((first = false), Response.json({ error: { code: "unauthorized", message: "expired" } }, { status: 401 })) : null);
    })();
    const r = await w.client.flush({ force: true });
    expect(r.accepted).toBe(1);
    expect(w.control.tokenCount()).toBe(2);
  });

  test("ENROLL: a revoked device stops sync: nothing more is sent and the status says revoked", async () => {
    await w.client.flush({ force: true });
    const before = w.control.received.length;
    w.control.revoke(w.client.status().deviceId!);
    w.clock.now += 16 * 60_000;
    const r = await w.client.flush({ force: true });
    expect(r.skipped).toBe("revoked");
    expect(w.client.status().state).toBe("revoked");
    w.clock.now += 60 * 60_000;
    expect((await w.client.flush({ force: true })).skipped).toBe("revoked");
    expect(w.control.received.length).toBe(before);
    expect(w.control.calls.filter((c) => c === "POST /v1/devices/challenge").length).toBe(2);
  });

  test("ENROLL: after revocation the person can connect again as a new device, seq from 1", async () => {
    await w.client.flush({ force: true });
    const old = w.client.status().deviceId!;
    w.control.revoke(old);
    w.clock.now += 16 * 60_000;
    await w.client.flush({ force: true });
    await w.client.connect();
    await w.client.connectIdle();
    const st = w.client.status();
    expect(st.state).toBe("connected");
    expect(st.deviceId).not.toBe(old);
    await w.client.refreshConfig();
    await w.client.acknowledgeNotice(NOTICE_1);
    await w.client.flush({ force: true });
    expect(w.control.received.at(-1)!.envelope).toMatchObject({ deviceId: st.deviceId, seq: 1 });
  });
});

describe("key storage", () => {
  test("ENROLL: keychain mode keeps the device keys wrapped by the observer (wrap-key --name device-signing)", async () => {
    const bin = fakeObserverWith({});
    const env = { OFFLOAD_OBSERVER_BIN: bin, PATH: process.env.PATH, HOME: process.env.HOME };
    w = await syncWorld({ deps: { env } });
    clearSyncKeyCache();
    await connect(w);
    expect(existsSync(wrappedKeyPath(w.home, "device-signing"))).toBe(true);
    expect(existsSync(wrappedKeyPath(w.home, "device-evidence"))).toBe(false); // created on first projection
    expect(existsSync(rawKeyPath(w.home, "device-signing"))).toBe(false);
    await w.client.refreshConfig();
    await w.client.acknowledgeNotice(NOTICE_1);
    expect(existsSync(wrappedKeyPath(w.home, "device-evidence"))).toBe(true);
    expect((await w.client.flush({ force: true })).accepted).toBe(1);
    expect(w.control.received[0]!.signatureOk).toBe(true);
  });

  test("ENROLL: a Secure Enclave signer plugs into the same seam (bridge stands in for the enclave)", async () => {
    const soft = new SoftwareSigner(new Uint8Array(32).fill(9));
    const jwk = await soft.publicJwk();
    const enclave = new SecureEnclaveSigner({ publicPoint: async () => ({ x: fromB64url(jwk.x), y: fromB64url(jwk.y) }), signEs256: (d) => soft.sign(d) });
    w = await syncWorld({ deps: { signer: enclave } });
    await connectAndAck(w);
    await w.client.flush({ force: true });
    expect(w.control.devices.get(w.client.status().deviceId!)!.jwk).toEqual(jwk);
    expect(w.control.received[0]!.signatureOk).toBe(true);
    expect(enclave.kind).toBe("secure_enclave");
    expect(NOW).toBeGreaterThan(0);
  });
});
