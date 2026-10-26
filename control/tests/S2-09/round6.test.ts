// Codex review of 86d4dd0: a lost session's settled cost reaches metrics and its overnight policy's counter (the
// unreported delta, once); a scheduled run imported late starts when the platform started it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedAgentsApi } from "../../src/modules/workers/managed-agents.ts";
import { createWorker, overnightPolicy, running, world, type World } from "./setup.ts";

let w: World;
let base: ManagedAgentsApi;
let policyId: string;

beforeAll(async () => {
  w = await world();
  base = w.fake.api();
  policyId = await overnightPolicy(w);
});
afterEach(() => {
  w.workers.configure({ api: base });
  w.fake.failNext.clear();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const runOfSession = async (sid: string) => (await w.h.db.migrator`select * from worker_runs where session_ref = ${sid}`)[0];
const counted = async () =>
  Number((await w.h.db.migrator`select coalesce(sum(budget_cents), 0)::int as c from overnight_counters where policy_id = ${policyId}`)[0]!.c);

describe("BUDGET", () => {
  test("BUDGET: a lost scheduled session's settled cost reaches metrics and its overnight policy's counter, once", async () => {
    const x = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "UTC" } });
    const dep = x.externalRefs.deploymentId as string;
    // The scheduled session works (cost 50 so far) and never idles; no stream to it can be opened.
    w.fake.queue([{ await: "user.message" }, { emit: [running, { type: "session.usage", list_cost: { amount: "50", currency: "USD" } }], cost: 50 }]);
    w.workers.configure({ api: { ...base, streamEvents: () => Promise.reject(new Error("connection refused")) } });
    const before = await counted();
    const sid = w.fake.fire(dep)!;
    w.fake.failNext.set("sessions.events.send", 1000);
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    let r = await runOfSession(sid);
    expect(r!.ended_at).not.toBeNull();
    expect(r!.session_unsettled).toBe(true);
    // The session keeps spending until its interrupt lands; then it settles at 120.
    w.fake.sessions.get(sid)!.costCents = 120;
    w.fake.failNext.clear();
    w.h.clock.advance(16 * 60_000);
    await w.workers.sweep(w.t.id);
    await w.workers.recover(w.t.id);
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    r = await runOfSession(sid);
    expect(r!.session_unsettled).toBe(false);
    expect(Number(r!.cost_cents)).toBe(120);
    const [m] = await w.h.db.migrator`select cost_cents from run_outcomes where run_id = ${r!.id}`;
    expect(Number(m!.cost_cents)).toBe(120);
    expect((await counted()) - before).toBe(120);
  }, 60_000);
});

describe("SCHEDULE", () => {
  test("SCHEDULE: a scheduled run imported after downtime starts when the platform started it", async () => {
    const x = await createWorker(w, { schedule: { cron: "0 20 * * *", timezone: "UTC" } });
    const dep = x.externalRefs.deploymentId as string;
    const sid = w.fake.fire(dep)!;
    const created = w.fake.deploymentRuns.find((d) => d.session_id === sid)!.created_at;
    // The poll job was down for two days.
    w.h.clock.advance(2 * 24 * 3600_000);
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    const r = await runOfSession(sid);
    expect(r).toBeDefined();
    expect((r!.started_at as Date).toISOString()).toBe(created);
  }, 60_000);
});
