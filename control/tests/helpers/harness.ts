import { createApp, type CreateAppOpts, type Deps, type App } from "../../src/app.ts";
import type { Config } from "../../src/config.ts";
import { generateEs256SigningKey } from "../../src/auth/jwt.ts";
import { b64url } from "../../src/schema/encoding.ts";
import { testDb, type TestDb } from "./db.ts";
import { FAKE_ISSUER, FakeWorkOS, WEBHOOK_SECRET } from "./fake-workos.ts";
import { createSession, seedTenant, type PersonKey, type SeededTenant, type SessionCred } from "./seed.ts";

export const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);

export class TestClock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function testConfig(appUrl: string, schema: string): Config {
  return {
    appPgUrl: appUrl,
    migratorPgUrl: "unused-in-tests",
    dbSchema: schema,
    workos: { apiKey: "sk_test_fake", clientId: "client_fake", redirectUri: "https://control.test/auth/callback", webhookSecret: WEBHOOK_SECRET, issuer: FAKE_ISSUER },
    validateResponses: true,
    afterLoginPath: "/",
  };
}

export interface Res {
  status: number;
  json: any;
  headers: Headers;
}

export interface Harness {
  db: TestDb;
  app: App;
  deps: Deps;
  clock: TestClock;
  workos: FakeWorkOS;
  a: SeededTenant;
  b: SeededTenant;
  /** Raw request against the app. */
  request(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<Res>;
  close(): Promise<void>;
}

/** A fresh schema, two seeded tenants (a, b), a fake clock and fake WorkOS, and the real app with every module. */
export async function createHarness(opts: Partial<Pick<CreateAppOpts, "modulesDir" | "ports">> = {}): Promise<Harness> {
  const db = await testDb();
  const clock = new TestClock();
  const workos = await FakeWorkOS.create(clock.now);
  const { app, deps } = await createApp({
    db: db.app,
    config: testConfig(db.appUrl, db.schema),
    workos,
    deviceKey: await generateEs256SigningKey(),
    clock,
    ...opts,
  });
  const a = await seedTenant(db.migrator, `Acme ${db.schema}`);
  const b = await seedTenant(db.migrator, `Globex ${db.schema}`);
  return {
    db,
    app,
    deps,
    clock,
    workos,
    a,
    b,
    async request(method, path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
        headers["Content-Type"] ??= "application/json";
      }
      const res = await app.request(`http://control.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      if (res.status >= 400) {
        // Every error in tests must match error.schema.json.
        const v = deps.validator.validate("offload/stage2/error.schema.json", json);
        if (!v.ok) throw new Error(`error response for ${method} ${path} breaks error.schema.json: ${text}`);
      }
      return { status: res.status, json, headers: res.headers };
    },
    close: () => db.close(),
  };
}

export interface Client {
  cred: SessionCred;
  personId: string;
  get(path: string, headers?: Record<string, string>): Promise<Res>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  patch(path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  put(path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  del(path: string, headers?: Record<string, string>): Promise<Res>;
  send(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
}

/** A signed-in browser for one seeded person: session cookie plus the CSRF header on every request. */
export async function asPrincipal(h: Harness, who: PersonKey, tenant: SeededTenant = h.a): Promise<Client> {
  const personId = tenant.people[who].id;
  const cred = await createSession(h.db.migrator, tenant.id, personId, h.clock.now());
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.request(method, path, {
      ...(body !== undefined ? { body } : {}),
      headers: { Cookie: cred.cookie, "X-CSRF-Token": cred.csrf, ...headers },
    });
  return {
    cred,
    personId,
    send,
    get: (p, hd) => send("GET", p, undefined, hd),
    post: (p, b = {}, hd) => send("POST", p, b, hd),
    patch: (p, b = {}, hd) => send("PATCH", p, b, hd),
    put: (p, b = {}, hd) => send("PUT", p, b, hd),
    del: (p, hd) => send("DELETE", p, undefined, hd),
  };
}

export interface DeviceCred {
  deviceId: string;
  keys: CryptoKeyPair;
  token: string;
}

export async function newDeviceKeys(): Promise<{ keys: CryptoKeyPair; jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const j = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as { x: string; y: string };
  return { keys, jwk: { kty: "EC", crv: "P-256", x: j.x, y: j.y } };
}

export async function signNonce(key: CryptoKey, nonce: string): Promise<string> {
  return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(nonce)));
}

/** Full device flow: enrollment code (browser) → enroll → challenge → token. */
export async function enrollDevice(h: Harness, who: Client): Promise<DeviceCred> {
  const code = await who.post("/v1/devices/enrollment-codes");
  if (code.status !== 201) throw new Error(`enrollment code ${code.status}`);
  const { keys, jwk } = await newDeviceKeys();
  const en = await h.request("POST", "/v1/devices/enroll", {
    body: { enrollmentCode: code.json.code, deviceName: "Test Mac", appVersion: "2.0.0", publicKeyJwk: jwk },
  });
  if (en.status !== 201) throw new Error(`enroll ${en.status} ${JSON.stringify(en.json)}`);
  const token = await deviceToken(h, en.json.deviceId, keys.privateKey);
  return { deviceId: en.json.deviceId, keys, token };
}

export async function deviceToken(h: Harness, deviceId: string, key: CryptoKey): Promise<string> {
  const ch = await h.request("POST", "/v1/devices/challenge", { body: { deviceId } });
  if (ch.status !== 200) throw new Error(`challenge ${ch.status}`);
  const tk = await h.request("POST", "/v1/devices/token", {
    body: { deviceId, nonce: ch.json.nonce, signature: await signNonce(key, ch.json.nonce) },
  });
  if (tk.status !== 200) throw new Error(`token ${tk.status}`);
  return tk.json.accessToken;
}

export function asDevice(h: Harness, token: string) {
  return (method: string, path: string, body?: unknown) =>
    h.request(method, path, { ...(body !== undefined ? { body } : {}), headers: { Authorization: `Bearer ${token}` } });
}
