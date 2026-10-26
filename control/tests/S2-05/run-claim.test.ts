// PR #9 round 4 (Codex P2): run ownership must not follow transaction start time. Migration 0503 stamped
// first_received_at with now(), the start of the ingest transaction, so an envelope that began first but stored its
// copy of a run id after another device had committed one got the earlier time and took the run over. Here device A's
// ingest transaction is held after it started (its device_seq row is locked), device B commits a copy of the same run
// id, then A goes on. The run belongs to B, whose copy was stored and committed first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { at, asPerson, populate, receipt, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";
import { ulid } from "../../src/schema/encoding.ts";

const OCT = "from=2026-10-01&to=2026-11-01";
let s: S205;
let people: Awaited<ReturnType<typeof populate>>;

beforeAll(async () => {
  s = await setup();
  people = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
});
afterAll(() => s.close());

async function successes(personId: string): Promise<number> {
  const me = await asPerson(s.h, s.h.a, personId);
  const r = await me.get(`/v1/metrics/hours-saved?scope=person:${personId}&${OCT}`);
  expect(r.status).toBe(200);
  return r.json.total.runs.success as number;
}

describe("PERSON run ownership is claimed when the copy is stored, not when the transaction started", () => {
  test("PERSON: an ingest that started first but stores its copy after another device committed one does not take the run", async () => {
    const [a, b] = [people[0]!, people[1]!];
    const before = { a: await successes(a.personId), b: await successes(b.personId) };
    const run = runOutcome({ endedAt: at("2026-10-25", 10), sent: 4 });

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: (pid: number) => void;
    const isLocked = new Promise<number>((r) => (locked = r));
    const lock = s.h.db.migrator.begin(async (tx) => {
      await tx`select 1 from device_seq where tenant_id = ${s.h.a.id} and device_id = ${a.dev.deviceId} for update`;
      locked((await tx`select pg_backend_pid() as pid`)[0]!.pid as number);
      await held;
    });
    const lockPid = await isLocked;

    // A's transaction starts (now() is fixed here) and waits on its device_seq row.
    const aSend = sendObjects(s.h, a.dev, [run]);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [w] = await s.h.db.migrator`select count(*)::int as n from pg_stat_activity
        where ${lockPid}::int = any (pg_blocking_pids(pid))`;
      if (w!.n > 0) break;
      if (Date.now() > deadline) throw new Error("A's ingest never blocked");
      await Bun.sleep(20);
    }

    // B stores and commits its copy of the same run id while A is still in flight.
    receipt(await sendObjects(s.h, b.dev, [{ ...run, id: ulid(run.endedAt) }]));
    release();
    await lock;
    expect(receipt(await aSend).accepted).toEqual([run.id]);

    expect(await successes(b.personId)).toBe(before.b + 1);
    expect(await successes(a.personId)).toBe(before.a);
  }, 30_000);
});
