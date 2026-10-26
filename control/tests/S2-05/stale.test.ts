// Review wave B, PR #9 item 4: marking snapshots stale must not lock snapshot rows inside every ingest, and an ingest
// that commits while the nightly job runs must never be marked final (which became a false mismatch the next night).
// The ingest under test is the real POST /v1/sync/batches; it is held open just before commit by locking its device row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import metrics from "../../src/modules/metrics/index.ts";
import { at, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type Dev, type S205 } from "./helpers.ts";

let s: S205;
let owner: Client;
let people: Awaited<ReturnType<typeof populate>>;
const OCT = "/v1/metrics/hours-saved?scope=company&from=2026-10-01&to=2026-11-01";
const SEP = "/v1/metrics/hours-saved?scope=company&from=2026-09-01&to=2026-10-01";
const nightly = () => metrics.jobs!.find((j) => j.name === "metrics.nightly_recompute")!.run(s.h.deps);
const alerts = async () => (await s.h.db.migrator`select scope_key from metric_alerts where tenant_id = ${s.h.a.id}`) as unknown[];

/** Backends of this database waiting on a lock, optionally only those running `like`. */
async function lockWaiters(like = "%"): Promise<number> {
  const [r] = await s.h.db.migrator`select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and query like ${like}`;
  return r!.n as number;
}

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(20);
  }
  return false;
}

/**
 * Sends `objects` from `dev` and holds that ingest open after its handlers ran: the device row is locked, so the
 * ingest waits on its last statement (`update devices set last_sync_at`); NO KEY UPDATE leaves the foreign-key checks
 * of its inserts free. `commit()` releases it.
 */
async function heldIngest(dev: Dev, objects: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = s.h.db.migrator.begin(async (tx) => {
    await tx`select 1 from devices where id = ${dev.deviceId} for no key update`;
    locked();
    await gate;
  });
  await isLocked;
  const sent = sendObjects(s.h, dev, objects);
  expect(await until(async () => (await lockWaiters("update devices set last_sync_at%")) === 1)).toBe(true);
  return {
    async commit() {
      release();
      await holder;
      return receipt(await sent);
    },
  };
}

beforeAll(async () => {
  s = await setup();
  people = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
  owner = await asPrincipal(s.h, "owner");
  await nightly();
  await nightly();
});
afterAll(() => s.close());

describe("RECOMPUTE stale marking under concurrency (review wave B #9 item 4)", () => {
  test("RECOMPUTE: the setup month is final", async () => {
    expect((await owner.get(OCT)).json.final).toBe(true);
  });

  test("RECOMPUTE: an envelope of several metric objects records new data once (one stale mark per ingest transaction)", async () => {
    const [before] = await s.h.db.migrator`select count(*)::int as n from metric_dirty where tenant_id = ${s.h.a.id} and taken_at is null`;
    const a = runOutcome({ endedAt: at("2026-10-21", 9) });
    const b = runOutcome({ endedAt: at("2026-10-21", 10) });
    receipt(await sendObjects(s.h, people[2]!.dev, [a, reviewEvent(a.runId), b, reviewEvent(b.runId)]));
    const [after] = await s.h.db.migrator`select count(*)::int as n from metric_dirty where tenant_id = ${s.h.a.id} and taken_at is null`;
    expect(after!.n - before!.n).toBe(1);
    expect((await owner.get(OCT)).json.final).toBe(false);
    await nightly();
    await nightly();
    expect((await owner.get(OCT)).json.final).toBe(true);
    expect(await alerts()).toEqual([]);
  });

  test("RECOMPUTE: an open ingest does not block another device's envelope", async () => {
    const held = await heldIngest(people[0]!.dev, [runOutcome({ endedAt: at("2026-10-22", 9) })]);
    try {
      const other = sendObjects(s.h, people[1]!.dev, [runOutcome({ endedAt: at("2026-10-22", 10) })]);
      const first = await Promise.race([other.then(() => "sent"), Bun.sleep(3000).then(() => "blocked")]);
      expect(first).toBe("sent");
      receipt(await other);
    } finally {
      await held.commit();
    }
  });

  test("RECOMPUTE: an ingest committing while the nightly job runs is not marked final and causes no false mismatch", async () => {
    // September is the first month the job checks, so its inputs are read while the ingest below is still open.
    await nightly();
    await nightly();
    expect((await owner.get(SEP)).json.final).toBe(true);
    const digestBefore = (await owner.get(SEP)).json.inputsDigest as string;
    const held = await heldIngest(people[3]!.dev, [runOutcome({ endedAt: at("2026-09-28", 9) })]);
    const job = nightly();
    // Whether the job finishes or waits behind the open ingest, the ingest commits now.
    await Promise.race([job, until(async () => (await lockWaiters()) >= 2)]);
    await held.commit();
    await job;
    expect((await owner.get(SEP)).json.final).toBe(false);
    await nightly();
    expect(await alerts()).toEqual([]);
    await nightly();
    const r = await owner.get(SEP);
    expect(r.json.final).toBe(true);
    expect(r.json.inputsDigest).not.toBe(digestBefore);
    expect(await alerts()).toEqual([]);
  });
});
