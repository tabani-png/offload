// Review wave C, PR #9 item 3: a per-device budget of accepted objects per hour. Objects over it are rejected
// rate_limited (retryable, so the Mac keeps them) and are accepted once the hour has passed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SYNC_OBJECTS_PER_HOUR, loadConfig } from "../../src/config.ts";
import { deviceToken } from "../helpers/harness.ts";
import { addDevice, addPerson, at, receipt, runOutcome, sendObjects, setup, type Dev, type S205 } from "./helpers.ts";

let s: S205;
let dev: Dev;
let other: Dev;
/** Objects the first envelope had rejected, sent again after the hour. */
let held: ReturnType<typeof runOutcome>[] = [];

const stored = async (d: Dev) =>
  ((await s.h.db.migrator`select count(*)::int as n from run_outcomes where device_id = ${d.deviceId}`)[0]!.n as number);
const runs = (n: number, hour: number) => Array.from({ length: n }, (_, i) => runOutcome({ endedAt: at("2026-10-20", hour) + i * 1000 }));

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const p = await addPerson(s.h, t, { departmentId: t.departments.sales });
  const p2 = await addPerson(s.h, t, { departmentId: t.departments.sales });
  s.fc.ackAll([p, p2]);
  dev = await addDevice(s.h, t, p);
  other = await addDevice(s.h, t, p2);
  (s.h.deps.config as { syncObjectsPerHour?: number }).syncObjectsPerHour = 3;
});
afterAll(() => s.close());

describe("VERIFY per-device rate limit", () => {
  test("VERIFY: objects over the device's hourly budget are rejected rate_limited (retryable) and not stored", async () => {
    const objs = runs(5, 9);
    const r = await sendObjects(s.h, dev, objs);
    expect(r.status).toBe(200);
    expect(r.json.accepted).toEqual(objs.slice(0, 3).map((o) => o.id));
    expect(r.json.rejected).toEqual(objs.slice(3).map((o) => ({ id: o.id, code: "rate_limited", retryable: true })));
    expect(await stored(dev)).toBe(3);
    held = objs.slice(3);
    // The next envelope in the same hour gets nothing in; the seq still advances (the envelope itself was accepted).
    const again = runs(1, 10);
    expect(receipt(await sendObjects(s.h, dev, again)).rejected).toEqual({ [again[0]!.id]: "rate_limited" });
    expect(await stored(dev)).toBe(3);
  });

  test("VERIFY: the budget is per device: another device of the tenant is not limited by the first", async () => {
    const objs = runs(2, 11);
    expect(receipt(await sendObjects(s.h, other, objs)).accepted).toEqual(objs.map((o) => o.id));
  });

  test("VERIFY: a duplicate is still reported as a duplicate, not rate_limited", async () => {
    const [first] = (await s.h.db.migrator`select object_id from sync_objects where device_id = ${dev.deviceId} limit 1`) as Array<{ object_id: string }>;
    const [orig] = (await s.h.db.migrator`select run_id, ended_at_ms from run_outcomes where object_id = ${first!.object_id}`) as Array<{ run_id: string; ended_at_ms: string }>;
    const dup = runOutcome({ id: first!.object_id, runId: orig!.run_id, endedAt: Number(orig!.ended_at_ms) });
    expect(receipt(await sendObjects(s.h, dev, [dup])).rejected).toEqual({ [dup.id]: "duplicate" });
  });

  test("VERIFY: after an hour the rejected objects are accepted when sent again", async () => {
    s.h.clock.advance(3600_000 + 1);
    dev.token = await deviceToken(s.h, dev.deviceId, dev.keys.privateKey);
    const r = receipt(await sendObjects(s.h, dev, held));
    expect(r.rejected).toEqual({});
    expect(await stored(dev)).toBe(5);
  });

  test("VERIFY: the budget comes from OFFLOAD_SYNC_OBJECTS_PER_HOUR with a default, and a bad value fails at startup", () => {
    const env = {
      OFFLOAD_APP_PG_URL: "postgres://x", OFFLOAD_PG_URL: "postgres://y", WORKOS_API_KEY: "k", WORKOS_CLIENT_ID: "c",
      WORKOS_REDIRECT_URI: "https://r", WORKOS_WEBHOOK_SECRET: "w", WORKOS_ISSUER: "https://i", OFFLOAD_DEVICE_SIGNING_JWK: "{}",
    };
    expect(SYNC_OBJECTS_PER_HOUR).toBeGreaterThanOrEqual(2000);
    expect(loadConfig(env).syncObjectsPerHour).toBe(SYNC_OBJECTS_PER_HOUR);
    expect(loadConfig({ ...env, OFFLOAD_SYNC_OBJECTS_PER_HOUR: "120" }).syncObjectsPerHour).toBe(120);
    for (const bad of ["0", "-1", "1.5", "lots"]) {
      expect(() => loadConfig({ ...env, OFFLOAD_SYNC_OBJECTS_PER_HOUR: bad })).toThrow("OFFLOAD_SYNC_OBJECTS_PER_HOUR");
    }
  });
});
