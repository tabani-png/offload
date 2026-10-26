// Codex review of 1ff5f64: interrupts must be delivered (not just marked), a restart must not orphan sessions, and the
// tenant monthly cap must hold under concurrent admission.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import workersModule from "../../src/modules/workers/index.ts";
import { ulid } from "../../src/schema/encoding.ts";
import type { Step } from "../../src/modules/workers/fake-managed-agents.ts";
import { createWorker, endTurn, requiresAction, running, tx, world, type World } from "./setup.ts";

let w: World;
let a: Record<string, any>;
let b: Record<string, any>;

beforeAll(async () => {
  w = await world();
  a = await createWorker(w);
  b = await createWorker(w);
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const hanging = (): Step[] => [{ await: "user.message" }, { emit: [running] }, { await: "user.custom_tool_result" }, { emit: [endTurn] }];

async function startHanging(workerId: string) {
  w.fake.queue(hanging());
  const r = await (await w.as("member")).post(`/v1/workers/${workerId}/runs`, {});
  expect(r.status).toBe(201);
  const id = r.json.id as string;
  for (let i = 0; i < 400 && !(await sessionOf(id)); i++) await Bun.sleep(5);
  const sid = await sessionOf(id);
  for (let i = 0; i < 400 && w.fake.receivedBy(sid).length === 0; i++) await Bun.sleep(5);
  expect(w.fake.receivedBy(sid).length).toBe(1);
  return { id, sid };
}

const sessionOf = async (id: string) => ((await w.h.db.migrator`select session_ref from worker_runs where id = ${id}`)[0]?.session_ref as string) ?? "";
const runOf = async (id: string) => (await w.h.db.migrator`select * from worker_runs where id = ${id}`)[0]!;
const interrupts = (sid: string) => w.fake.receivedBy(sid).filter((e) => e.type === "user.interrupt").length;
const job = (name: string) => (workersModule.jobs ?? []).find((j) => j.name === name) as { schedule: string; run(d: unknown, t?: string): Promise<void> } | undefined;
const killSwitch = async (scope: string, targetId: string | null) =>
  expect((await (await w.as("owner")).post("/v1/kill-switches", { scope, targetId, reason: "test" })).status).toBe(201);
const clearSwitch = async (scope: string, targetId: string | null) => {
  const owner = await w.as("owner");
  expect((await owner.del(`/v1/kill-switches/${scope}/${targetId}`)).status).toBe(200);
  for (const x of (await owner.get("/v1/workers?limit=200")).json.items) {
    if (x.state === "paused") expect((await owner.post(`/v1/workers/${x.id}/resume`)).status).toBe(200);
  }
  await w.workers.idle();
};
// The SDK retries a 500 twice: three failures make one call fail.
const failSends = (calls: number) => w.fake.failNext.set("sessions.events.send", 3 * calls);

describe("KILL", () => {
  test("KILL: an interrupt that does not reach the session is retried by later sweeps until it is delivered", async () => {
    const { id, sid } = await startHanging(a.id);
    failSends(1);
    await killSwitch("tenant", null);
    try {
      await w.workers.sweep(w.t.id);
      await w.workers.idle();
      expect(interrupts(sid)).toBe(0);
      expect((await runOf(id)).ended_at).toBeNull();
      w.h.clock.advance(10 * 60_000);
      await w.workers.sweep(w.t.id);
      await w.workers.idle();
      expect(interrupts(sid)).toBe(1);
      expect((await runOf(id)).state).toBe("interrupted");
      // Delivered: no further sends on later sweeps.
      w.h.clock.advance(10 * 60_000);
      await w.workers.sweep(w.t.id);
      expect(interrupts(sid)).toBe(1);
    } finally {
      w.fake.failNext.delete("sessions.events.send");
      await clearSwitch("tenant", null);
    }
  }, 60_000);

  test("KILL: stopping a person without a kill switch requests the interrupt in the caller's transaction; the sweep delivers it", async () => {
    const mine = await createWorker(w, { identityId: w.t.people.member.id });
    const { id, sid } = await startHanging(mine.id);
    failSends(1);
    await tx(w, (t) => w.broker.stopRunsFor(t, w.t.people.member.id));
    await w.workers.idle();
    expect(interrupts(sid)).toBe(0);
    expect((await runOf(id)).interrupt_sent_at).not.toBeNull();
    w.h.clock.advance(10 * 60_000);
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    expect(interrupts(sid)).toBe(1);
    expect((await runOf(id)).state).toBe("interrupted");
  }, 60_000);
});

describe("SESSION", () => {
  test("SESSION: after a restart the reconcile tick re-attaches to a running session, answers its waiting tool call and ends the run", async () => {
    const { id, sid } = await startHanging(a.id);
    w.workers.shutdown();
    await w.workers.idle();
    w.fake.inject(sid, [
      { id: "evt_rep_restart", type: "agent.custom_tool_use", name: "offload_report", input: { summary: "after restart" } },
      requiresAction(["evt_rep_restart"]),
    ]);
    await w.workers.reconcile(w.t.id);
    await w.workers.idle();
    expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.custom_tool_result" && e.custom_tool_use_id === "evt_rep_restart")).toHaveLength(1);
    const r = await runOf(id);
    expect(r.state).toBe("done");
    expect(r.summary).toBe("after restart");
  }, 60_000);

  test("SESSION: a per-minute recovery job fails a run whose session was never recorded, after a timeout, and releases its budget", async () => {
    const recover = job("workers.recover");
    expect(recover?.schedule).toBe("* * * * *");
    const now = w.h.clock.now();
    const stale = ulid(now - 20 * 60_000);
    const fresh = ulid(now);
    for (const [id, at] of [[stale, now - 20 * 60_000], [fresh, now]] as const) {
      await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, state, budget_cents)
        values (${w.t.id}, ${id}, ${a.id}, 'manual', ${w.t.people.member.id}, ${new Date(at)}, 'running', 300)`;
    }
    const before = (await tx(w, (t) => w.workers.monthSpent(t))).spent;
    await recover!.run(w.h.deps, w.t.id);
    await w.workers.idle();
    const s = await runOf(stale);
    expect(s.state).toBe("failed");
    expect(s.error_code).toBe("session_not_recorded");
    expect(s.ended_at).not.toBeNull();
    expect((await runOf(fresh)).ended_at).toBeNull();
    expect((await tx(w, (t) => w.workers.monthSpent(t))).spent).toBe(before - 300);
    await w.h.db.migrator`update worker_runs set state = 'failed', ended_at = now(), stop_reason = 'error' where id = ${fresh}`;
  }, 60_000);
});

describe("BUDGET", () => {
  test("BUDGET: two runs of different workers started at once cannot both take the month's last session budget", async () => {
    const { spent } = await tx(w, (t) => w.workers.monthSpent(t));
    await w.h.db.migrator`update tenants set monthly_worker_budget_cents = ${spent + 400} where id = ${w.t.id}`;
    const member = await w.as("member");
    w.fake.queue(hanging(), hanging());
    // Gate: hold the tenant row so each admission stops at its run insert (the FK's key-share lock) after its check.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const gate = w.h.db.migrator.begin(async (g) => {
      await g`select 1 from tenants where id = ${w.t.id} for update`;
      locked();
      await held;
    });
    await isLocked;
    const p1 = member.post(`/v1/workers/${a.id}/runs`, {});
    const p2 = member.post(`/v1/workers/${b.id}/runs`, {});
    await Bun.sleep(600);
    release();
    await gate;
    const res = [await p1, await p2];
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.json.error.code).toBe("budget_exceeded");
    await w.workers.idle();
    await w.h.db.migrator`update tenants set monthly_worker_budget_cents = 100000 where id = ${w.t.id}`;
  }, 60_000);
});
