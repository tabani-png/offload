// ENVELOPE: RFC 8785 JCS (test vectors from the RFC), ES256 signature verifiable with the public JWK, seq strictly
// increasing across restarts, 500-object / 1 MiB limits split envelopes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SoftwareSigner, verifyEs256 } from "../../src/sync/device.ts";
import { fromB64url, ulid } from "../../src/sync/encoding.ts";
import { MAX_BYTES, MAX_OBJECTS, parseSignatureHeader, signEnvelope, splitObjects } from "../../src/sync/envelope.ts";
import { canonicalize, JcsError } from "../../src/sync/jcs.ts";
import { statePath } from "../../src/sync/state.ts";
import type { NoticeAck, SyncObject } from "../../src/sync/types.ts";
import { NOTICE_1 } from "./fake-control.ts";
import { connectAndAck, NOW, syncWorld, type SyncWorld } from "./setup.ts";

const hexDouble = (hex: string) => new DataView(Uint8Array.from(Buffer.from(hex, "hex")).buffer).getFloat64(0, false);

describe("JCS (RFC 8785)", () => {
  // RFC 8785 Appendix B: IEEE 754 bit patterns and their canonical text.
  const VECTORS: Array<[string, string]> = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];

  test("ENVELOPE: JCS number serialization matches every RFC 8785 Appendix B vector", () => {
    for (const [hex, want] of VECTORS) expect(canonicalize(hexDouble(hex))).toBe(want);
  });

  test("ENVELOPE: JCS rejects NaN and Infinity (RFC 8785 Appendix B error cases)", () => {
    expect(() => canonicalize(hexDouble("7fffffffffffffff"))).toThrow(JcsError);
    expect(() => canonicalize(hexDouble("7ff0000000000000"))).toThrow(JcsError);
    expect(() => canonicalize({ a: Number.NEGATIVE_INFINITY })).toThrow(JcsError);
  });

  test("ENVELOPE: JCS section 3.2.2 example (numbers, string escapes, literals)", () => {
    const input = JSON.parse('{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}');
    expect(canonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  test("ENVELOPE: JCS section 3.2.3 property sorting by UTF-16 code units", () => {
    const input = JSON.parse('{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", "\\u00f6": "Latin Small Letter O With Diaeresis"}');
    // Read the values in text order (Object.values would move the integer-like key "1" first).
    const values = [...canonicalize(input).matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"]);
  });

  test("ENVELOPE: JCS is whitespace-free, nested-sorted and stable under re-parsing", () => {
    const v = { b: [1, { z: true, a: null }], a: "x", c: { y: -0, x: 1.5 } };
    const t = canonicalize(v);
    expect(t).toBe('{"a":"x","b":[1,{"a":null,"z":true}],"c":{"x":1.5,"y":0}}');
    expect(canonicalize(JSON.parse(t))).toBe(t);
    expect(() => canonicalize({ d: new Date(0) })).toThrow(JcsError);
    expect(() => canonicalize([undefined])).toThrow(JcsError);
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

function ack(i: number, pad = 0): NoticeAck {
  return { id: ulid(NOW + i), kind: "notice_ack", createdAt: NOW, noticeVersionId: NOTICE_1, acknowledgedAt: NOW, jurisdiction: "CA-ON", features: pad > 0 ? ["workflow_metrics"] : [], channel: "mac_app" };
}

describe("signing and limits", () => {
  const DEVICE = "66666666-6666-4666-8666-666666666666";
  const signer = new SoftwareSigner(Uint8Array.from(Buffer.from("1f".repeat(32), "hex")));

  test("ENVELOPE: the ES256 signature over the JCS body verifies with the device's public JWK", async () => {
    const env = { v: 1 as const, deviceId: DEVICE, seq: 1, sentAt: NOW, objects: [ack(1)] as SyncObject[] };
    const s = await signEnvelope(env, signer);
    expect(s.body).toBe(canonicalize(env));
    const h = parseSignatureHeader(s.header);
    expect(h?.keyid).toBe(DEVICE);
    expect(fromB64url(h!.sig)).toHaveLength(64);
    const jwk = await signer.publicJwk();
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(await verifyEs256(jwk, new TextEncoder().encode(s.body), h!.sig)).toBe(true);
  });

  test("ENVELOPE: a changed body or another key does not verify", async () => {
    const env = { v: 1 as const, deviceId: DEVICE, seq: 2, sentAt: NOW, objects: [ack(1)] as SyncObject[] };
    const s = await signEnvelope(env, signer);
    const jwk = await signer.publicJwk();
    expect(await verifyEs256(jwk, new TextEncoder().encode(s.body.replace('"seq":2', '"seq":3')), s.signature)).toBe(false);
    const other = new SoftwareSigner(Uint8Array.from(Buffer.from("2e".repeat(32), "hex")));
    expect(await verifyEs256(await other.publicJwk(), new TextEncoder().encode(s.body), s.signature)).toBe(false);
  });

  test("ENVELOPE: the signature header is keyid=<deviceId>, sig=<b64url>; anything else does not parse", () => {
    expect(parseSignatureHeader(`keyid=${DEVICE}, sig=abc_-D`)).toEqual({ keyid: DEVICE, sig: "abc_-D" });
    expect(parseSignatureHeader(`keyid=${DEVICE} sig=abc`)).toBeNull();
    expect(parseSignatureHeader("sig=abc")).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
  });

  test("ENVELOPE: more than 500 objects split into envelopes of at most 500", () => {
    const objs = Array.from({ length: 1203 }, (_, i) => ack(i));
    const parts = splitObjects(objs, DEVICE);
    expect(parts.map((p) => p.length)).toEqual([MAX_OBJECTS, MAX_OBJECTS, 203]);
    expect(parts.flat().map((o) => o.id)).toEqual(objs.map((o) => o.id));
  });

  test("ENVELOPE: envelopes stay at or under 1 MiB of JCS bytes, counting the widest seq and sentAt", () => {
    const objs = Array.from({ length: 450 }, (_, i) => ack(i));
    const one = Buffer.byteLength(canonicalize(objs[0]));
    const limit = one * 100 + 200; // a small limit to exercise the byte split
    const parts = splitObjects(objs, DEVICE, MAX_OBJECTS, limit);
    expect(parts.length).toBeGreaterThan(4);
    for (const p of parts) expect(Buffer.byteLength(canonicalize({ v: 1, deviceId: DEVICE, seq: Number.MAX_SAFE_INTEGER, sentAt: Number.MAX_SAFE_INTEGER, objects: p }))).toBeLessThanOrEqual(limit);
    expect(parts.flat()).toHaveLength(450);
    expect(MAX_BYTES).toBe(1024 * 1024);
  });

  test("ENVELOPE: an empty or oversized envelope is never signed", async () => {
    await expect(signEnvelope({ v: 1, deviceId: DEVICE, seq: 1, sentAt: NOW, objects: [] }, signer)).rejects.toThrow();
    await expect(signEnvelope({ v: 1, deviceId: DEVICE, seq: 1, sentAt: NOW, objects: Array.from({ length: 501 }, (_, i) => ack(i)) }, signer)).rejects.toThrow();
  });
});

describe("seq against replay", () => {
  let w: SyncWorld;
  beforeEach(async () => {
    w = await syncWorld();
  });
  afterEach(() => w.cleanup());

  test("ENVELOPE: seq strictly increases across flushes and brain restarts, and is on disk before the request", async () => {
    await connectAndAck(w);
    await w.client.flush({ force: true });
    for (let i = 0; i < 3; i++) {
      w.clock.now += 60_000;
      w.restart();
      // A new ack object each time so there is something to send.
      w.control.config.requiredNotice = { noticeVersionId: `3333333${i}-3333-4333-8333-333333333333`, title: "v", markdown: "m", features: ["workflow_metrics"] };
      await w.client.refreshConfig();
      await w.client.acknowledgeNotice(w.control.config.requiredNotice.noticeVersionId);
      await w.client.flush({ force: true });
    }
    const seqs = w.control.received.map((r) => r.envelope.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(w.control.received.every((r) => r.status === 200 && r.signatureOk)).toBe(true);
    expect((JSON.parse(readFileSync(statePath(w.home), "utf8")) as { seq: number }).seq).toBe(4);
  });

  test("ENVELOPE: a seq is used up even when its request fails, so a retry never reuses it", async () => {
    await connectAndAck(w);
    w.control.intercept = () => Response.json({ error: { code: "server_error", message: "x" } }, { status: 503 });
    const r1 = await w.client.flush({ force: true });
    expect(r1.error).toBeDefined();
    w.control.intercept = null;
    await w.client.flush({ force: true });
    expect(w.control.received.map((r) => r.envelope.seq)).toEqual([1, 2]);
    expect(w.control.received[1]!.status).toBe(200);
  });

  test("ENVELOPE: the server's replay check refuses an old seq (the fake re-sends a captured envelope)", async () => {
    await connectAndAck(w);
    await w.client.flush({ force: true });
    const first = w.control.received[0]!;
    const res = await fetch(`${w.control.url}/v1/sync/batches`, { method: "POST", headers: { authorization: first.headers.get("authorization")!, "offload-signature": first.headers.get("offload-signature")!, "content-type": "application/json" }, body: first.body });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("replay");
  });
});
