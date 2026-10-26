import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal } from "../helpers/harness.ts";
import { jcs } from "../../src/schema/encoding.ts";
import { addDevice, addPerson, receipt, runOutcome, sendObjects, setup, signBytes, type Dev, type S205 } from "./helpers.ts";

let s: S205;
let dev: Dev;
let other: Dev;

const stored = async () => {
  const [r] = await s.h.db.migrator`select (select count(*)::int from run_outcomes) as runs, (select count(*)::int from sync_objects) as ledger`;
  return r as { runs: number; ledger: number };
};

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const p1 = await addPerson(s.h, t, { departmentId: t.departments.sales });
  const p2 = await addPerson(s.h, t, { departmentId: t.departments.sales });
  s.fc.ackAll([p1, p2]);
  dev = await addDevice(s.h, t, p1);
  other = await addDevice(s.h, t, p2);
});
afterAll(() => s.close());

describe("VERIFY envelope signatures", () => {
  test("VERIFY: an envelope signed by the device's key over its JCS bytes is accepted", async () => {
    const run = runOutcome();
    const r = receipt(await sendObjects(s.h, dev, [run]));
    expect(r.accepted).toEqual([run.id]);
    expect(r.rejected).toEqual({});
    expect((await stored()).runs).toBe(1);
  });

  test("VERIFY: the receipt echoes the envelope seq and matches sync-receipt.schema.json", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()]);
    expect(r.status).toBe(200);
    expect(r.json.seq).toBe(dev.seq);
    expect(s.h.deps.validator.validate("offload/stage2/sync-receipt.schema.json", r.json)).toEqual({ ok: true });
  });

  test("VERIFY: one flipped byte after signing is 401 bad_signature and nothing is stored", async () => {
    const before = await stored();
    const r = await sendObjects(s.h, dev, [runOutcome({ sent: 4 })], {
      tamper: (b) => b.replace('"sent":4', '"sent":5'),
    });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("bad_signature");
    expect(await stored()).toEqual(before);
  });

  test("VERIFY: a signature by another device's key is 401 bad_signature", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()], { signWith: other.keys.privateKey });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("bad_signature");
  });

  test("VERIFY: keyid naming another device than the token's is 401 bad_signature", async () => {
    const env = { v: 1, deviceId: dev.deviceId, seq: dev.seq + 1, sentAt: s.h.clock.now(), objects: [runOutcome()] };
    const sig = await signBytes(other.keys.privateKey, jcs(env));
    const r = await sendObjects(s.h, dev, env.objects, { header: `keyid=${other.deviceId}, sig=${sig}` });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("bad_signature");
  });

  test("VERIFY: re-ordered keys, signed as sent, are not canonical: 400 validation_failed, nothing stored", async () => {
    const before = await stored();
    const r = await sendObjects(s.h, dev, [runOutcome()], {
      body: (env) => JSON.stringify({ objects: env.objects, v: env.v, seq: env.seq, deviceId: env.deviceId, sentAt: env.sentAt }),
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    expect(await stored()).toEqual(before);
  });

  test("VERIFY: the same content in its JCS form (whatever key order the client built) is accepted", async () => {
    const run = runOutcome();
    const shuffled = Object.fromEntries(Object.entries(run).reverse());
    const r = receipt(await sendObjects(s.h, dev, [shuffled]));
    expect(r.accepted).toEqual([run.id]);
  });

  test("VERIFY: whitespace added to a signed JCS body breaks the signature (the exact bytes are verified)", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()], { tamper: (b) => b.replace('{"v"', '{ "v"').replace(/^\{/, "{ ") });
    expect(r.status).toBe(401);
  });

  test("VERIFY: a missing or malformed Offload-Signature header is 400 validation_failed", async () => {
    expect((await sendObjects(s.h, dev, [runOutcome()], { header: null })).json.error.code).toBe("validation_failed");
    expect((await sendObjects(s.h, dev, [runOutcome()], { header: "sig=abc" })).status).toBe(400);
  });

  test("VERIFY: a signature that is not 64 raw bytes is 401 bad_signature", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()], { header: `keyid=${dev.deviceId}, sig=AAAA` });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("bad_signature");
  });

  test("VERIFY: an envelope naming another deviceId than the token's is 403 forbidden", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()], { deviceId: other.deviceId });
    expect(r.status).toBe(403);
  });

  test("VERIFY: a web session cannot post batches (device column only)", async () => {
    const owner = await asPrincipal(s.h, "owner");
    const r = await owner.post("/v1/sync/batches", { v: 1 });
    expect(r.status).toBe(403);
  });

  test("VERIFY: a revoked device's token no longer posts", async () => {
    const p = await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.sales });
    s.fc.acked.add(p);
    const d = await addDevice(s.h, s.h.a, p);
    await s.h.db.migrator`update devices set state = 'revoked' where id = ${d.deviceId}`;
    expect((await sendObjects(s.h, d, [runOutcome()])).status).toBe(401);
  });

  test("VERIFY: a body that is not JSON or not an envelope is 400 validation_failed", async () => {
    expect((await sendObjects(s.h, dev, [], { body: () => "not json" })).status).toBe(400);
    expect((await sendObjects(s.h, dev, [])).json.error.code).toBe("validation_failed");
    expect((await sendObjects(s.h, dev, [runOutcome()], { body: (e) => jcs({ ...e, v: 2 }) })).status).toBe(400);
  });

  test("VERIFY: an envelope over 1 MiB is 400 validation_failed", async () => {
    const big = Array.from({ length: 500 }, () => runOutcome({ extra: { errorCode: "x".repeat(64) } }));
    const r = await sendObjects(s.h, dev, big, { body: (e) => jcs(e) + " ".repeat(1024 * 1024) });
    expect(r.status).toBe(400);
  });

  /** POST a streamed body of `total` bytes (no Content-Length unless given) and count how much the server pulled. */
  const streamed = async (total: number, headers: Record<string, string> = {}) => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= total) return c.close();
        pulled += chunk.byteLength;
        c.enqueue(chunk);
      },
    });
    const res = await s.h.app.request("http://control.test/v1/sync/batches", {
      method: "POST",
      body,
      duplex: "half",
      headers: { Authorization: `Bearer ${dev.token}`, "Content-Type": "application/json", "Offload-Signature": `keyid=${dev.deviceId}, sig=AAAA`, ...headers },
    } as RequestInit);
    return { status: res.status, json: (await res.json()) as { error: { code: string } }, pulled };
  };

  test("VERIFY: an oversize body without Content-Length is rejected without being read in full", async () => {
    const r = await streamed(64 * 1024 * 1024);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    // The cap is 1 MiB; the reader stops within a chunk or two of it instead of buffering 64 MiB.
    expect(r.pulled).toBeLessThan(2 * 1024 * 1024);
  });

  test("VERIFY: a Content-Length over 1 MiB is rejected before the body is read", async () => {
    const r = await streamed(8 * 1024 * 1024, { "Content-Length": String(8 * 1024 * 1024) });
    expect(r.status).toBe(400);
    expect(r.pulled).toBeLessThanOrEqual(256 * 1024);
  });
});
