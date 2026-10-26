// PR #9 Codex review of c8a9965: the nightly job took the dirty markers and then loaded inputs in later statements under
// READ COMMITTED. An ingest committing in between showed new inputs while the job believed nothing arrived: a false
// recompute_mismatch and a lost final flag. Here the job is held between the two (on September's company snapshot row,
// after it took the markers and before it loads October), an October run commits, and the job goes on. No alert; the
// next run takes the new data in.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import metrics from "../../src/modules/metrics/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { at, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

let s: S205;
let owner: Client;
let sales: Awaited<ReturnType<typeof populate>>;
const nightly = () => metrics.jobs!.find((j) => j.name === "metrics.nightly_recompute")!.run(s.h.deps);
const Q = "from=2026-10-01&to=2026-11-01";
const alerts = async () => (await s.h.db.migrator`select scope_key from metric_alerts where tenant_id = ${s.h.a.id}`) as unknown[];

beforeAll(async () => {
  s = await setup();
  sales = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
  await populate(s, s.h.a, { departmentId: s.h.a.departments.finance, size: 5 });
  owner = await asPrincipal(s.h, "owner");
  await nightly();
  await nightly();
});
afterAll(() => s.close());

describe("RECOMPUTE one snapshot per pass", () => {
  test("RECOMPUTE: an ingest committing between taking the markers and loading the inputs is no mismatch; the next run takes it in", async () => {
    const dept = `/v1/metrics/hours-saved?scope=department:${s.h.a.departments.sales}&${Q}`;
    expect((await owner.get(dept)).json.final).toBe(true);
    const runsBefore = (await owner.get(dept)).json.total.runs.success as number;

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: (pid: number) => void;
    const isLocked = new Promise<number>((r) => (locked = r));
    const holder = s.h.db.migrator.begin(async (tx) => {
      await tx`select 1 from metric_snapshots where tenant_id = ${s.h.a.id} and month = '2026-09' and scope_key = 'company:' for update`;
      locked((await tx`select pg_backend_pid() as pid`)[0]!.pid as number);
      await gate;
    });
    const pid = await isLocked;
    const job = nightly();
    const end = Date.now() + 10_000;
    for (;;) {
      const [w] = await s.h.db.migrator`select count(*)::int as n from pg_stat_activity where ${pid}::int = any (pg_blocking_pids(pid))`;
      if (w!.n > 0) break;
      if (Date.now() > end) throw new Error("the job never reached the held snapshot row");
      await Bun.sleep(20);
    }
    const run = runOutcome({ endedAt: at("2026-10-23", 10) });
    receipt(await sendObjects(s.h, sales[0]!.dev, [run, reviewEvent(run.runId, { at: at("2026-10-23", 11) })]));
    release();
    await holder;
    await job;

    expect(await alerts()).toEqual([]);
    // The new run arrived after the markers were taken: pending, so not final, and the next run takes it in.
    expect((await owner.get(dept)).json.final).toBe(false);
    await nightly();
    expect(await alerts()).toEqual([]);
    await nightly();
    const r = await owner.get(dept);
    expect(r.json.final).toBe(true);
    expect(r.json.total.runs.success).toBe(runsBefore + 1);
  }, 60_000);
});
