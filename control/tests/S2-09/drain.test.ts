// Codex review of 4153ad3: a replaced or removed deployment is drained (every session it started is imported and
// finished) before it is forgotten; a session gets the budget its run reserved; the default digest day follows the
// local-noon calendar rule across DST.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { localInstant } from "../../src/modules/workers/cron.ts";
import { digestDayOf, windowOf } from "../../src/modules/workers/digest.ts";
import { loadRun, loadWorker } from "../../src/modules/workers/repo.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { createWorker, tx, world, type World } from "./setup.ts";

let w: World;

beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const runOfSession = async (sid: string) => (await w.h.db.migrator`select * from worker_runs where session_ref = ${sid}`)[0];

describe("SCHEDULE", () => {
  test("SCHEDULE: a session the old deployment started just before a schedule change is imported and finished after the replacement", async () => {
    const x = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "UTC" } });
    const old = x.externalRefs.deploymentId as string;
    const sid = w.fake.fire(old)!;
    expect(sid).not.toBeNull();
    // The schedule changes before the poll job saw that firing: the old deployment is archived and replaced.
    expect((await (await w.as("admin")).patch(`/v1/workers/${x.id}`, { schedule: { cron: "0 6 * * 1-5", timezone: "UTC" } })).status).toBe(200);
    await w.workers.idle();
    expect(w.fake.deployments.get(old)!.status).toBe("archived");
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    const r = await runOfSession(sid);
    expect(r).toBeDefined();
    expect(r!.trigger).toBe("schedule");
    expect(r!.ended_at).not.toBeNull();
    // Drained: imported, finished and archived, so it is no longer polled.
    await w.workers.pollDeployments(w.t.id);
    const polls = w.fake.ops("deploymentRuns.list").length;
    await w.workers.pollDeployments(w.t.id);
    expect(w.fake.ops("deploymentRuns.list").filter((o) => o.query.deployment_id === old).length).toBeGreaterThan(0);
    const afterPolls = w.fake.ops("deploymentRuns.list").slice(polls).filter((o) => o.query.deployment_id === old);
    expect(afterPolls).toHaveLength(0);
  }, 60_000);

  test("SCHEDULE: a session started just before the schedule was removed is imported and finished after the archive", async () => {
    const x = await createWorker(w, { schedule: { cron: "0 23 * * *", timezone: "UTC" } });
    const dep = x.externalRefs.deploymentId as string;
    const sid = w.fake.fire(dep)!;
    expect((await (await w.as("admin")).patch(`/v1/workers/${x.id}`, { schedule: null })).status).toBe(200);
    await w.workers.idle();
    expect(w.fake.deployments.get(dep)!.status).toBe("archived");
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    const r = await runOfSession(sid);
    expect(r).toBeDefined();
    expect(r!.ended_at).not.toBeNull();
  }, 60_000);
});

describe("SESSION", () => {
  test("SESSION: the session is created with the budget its run reserved, not a budget raised after admission", async () => {
    const x = await createWorker(w);
    const id = ulid(w.h.clock.now());
    await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, state, budget_cents)
      values (${w.t.id}, ${id}, ${x.id}, 'manual', ${w.t.people.member.id}, ${new Date(w.h.clock.now())}, 'running', 300)`;
    // An admin raises the worker's budget between admission and the session's creation.
    await w.h.db.migrator`update workers set session_budget_cents = 450 where id = ${x.id}`;
    const { run, wk } = await tx(w, async (t) => ({ run: (await loadRun(t, id))!, wk: (await loadWorker(t, x.id))! }));
    const before = w.fake.ops("sessions.create").length;
    w.workers.dispatchRun(w.t.id, run, wk, null);
    await w.workers.idle();
    const created = w.fake.ops("sessions.create").slice(before);
    expect(created).toHaveLength(1);
    expect(created[0]!.body!.budget).toEqual({ type: "limit", max_list_cost: { amount: "300", currency: "USD" } });
  }, 60_000);
});

describe("DIGEST", () => {
  // Day D covers [12:00 local on D-1, 12:00 local on D): the default day is the one whose window holds now.
  const cases: Array<[string, string, [number, number, number, number, number], string]> = [
    // Beirut falls back at 00:00 on 2026-10-25 (to 23:00 on the 24th): 12:30 on the 24th belongs to the 25th.
    ["Asia/Beirut fall-back at midnight", "Asia/Beirut", [2026, 10, 24, 12, 30], "2026-10-25"],
    ["Asia/Beirut before noon", "Asia/Beirut", [2026, 10, 24, 11, 30], "2026-10-24"],
    ["Toronto spring-forward day, after noon", "America/Toronto", [2026, 3, 8, 12, 30], "2026-03-09"],
    ["Toronto spring-forward day, before noon", "America/Toronto", [2026, 3, 8, 11, 59], "2026-03-08"],
    ["Toronto fall-back day, after noon", "America/Toronto", [2026, 11, 1, 12, 0], "2026-11-02"],
    ["Toronto fall-back day, before noon", "America/Toronto", [2026, 11, 1, 1, 30], "2026-11-01"],
    ["Kolkata +5:30, after noon", "Asia/Kolkata", [2026, 6, 1, 12, 15], "2026-06-02"],
    ["Kolkata +5:30, before noon", "Asia/Kolkata", [2026, 6, 1, 11, 45], "2026-06-01"],
  ];
  for (const [name, tz, [y, mo, d, h, mi], want] of cases) {
    test(`DIGEST: default day, ${name}`, () => {
      const t = localInstant(y, mo, d, h, mi, tz);
      const day = digestDayOf(t, tz);
      expect(day).toBe(want);
      const win = windowOf(day, tz);
      expect(win.from <= t && t < win.to).toBe(true);
    });
  }
});
