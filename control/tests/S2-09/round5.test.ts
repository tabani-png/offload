// Codex review of 1f8bb13: a lost session keeps its budget reserved until it is confirmed stopped; an interrupt that
// lands while the stream opens is never followed by the first message; catch-up never skips an unseen event whose
// processed_at is older than one already handled.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedAgentsApi } from "../../src/modules/workers/managed-agents.ts";
import { createWorker, endTurn, running, tx, world, type World } from "./setup.ts";

let w: World;
let worker: Record<string, any>;
let base: ManagedAgentsApi;

beforeAll(async () => {
  w = await world();
  worker = await createWorker(w);
  base = w.fake.api();
});
afterEach(() => {
  w.workers.configure({ api: base });
  w.fake.dropAfter = null;
  w.fake.dropEvery = false;
  w.fake.failNext.clear();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const lastSession = () => [...w.fake.sessions.values()].pop()!;
const spent = async () => (await tx(w, (t) => w.workers.monthSpent(t))).spent;
const runRow = async (id: string) => (await w.h.db.migrator`select * from worker_runs where id = ${id}`)[0]!;

async function post(): Promise<string> {
  const r = await (await w.as("member")).post(`/v1/workers/${worker.id}/runs`, {});
  expect(r.status).toBe(201);
  return r.json.id as string;
}

describe("BUDGET", () => {
  test("BUDGET: a run that lost its stream keeps its whole budget reserved until the session is confirmed stopped, then holds its final cost", async () => {
    const before = await spent();
    // The session starts working (cost 50 so far) and never idles; every stream after the first fails to open.
    w.fake.queue([{ await: "user.message" }, { emit: [running, { type: "session.usage", list_cost: { amount: "50", currency: "USD" } }], cost: 50 }]);
    w.fake.dropAfter = 2;
    let opened = 0;
    w.workers.configure({
      api: { ...base, streamEvents: async (sid, signal) => (++opened > 1 ? Promise.reject(new Error("connection reset")) : base.streamEvents(sid, signal)) },
    });
    // Its interrupt cannot be delivered yet either.
    w.fake.failNext.set("sessions.events.send", 0);
    const id = await post();
    await w.workers.idle();
    const s = lastSession();
    w.fake.failNext.set("sessions.events.send", 1000);
    await w.workers.idle();
    let r = await runRow(id);
    expect(r.ended_at).not.toBeNull();
    expect(r.error_code).toBe("stream_lost");
    expect(s.status).toBe("running");
    // Ended on our side, still running on the platform: the reservation is not released.
    expect((await spent()) - before).toBe(300);
    // Recovery and the sweep keep trying; while the interrupt fails, the reservation stays.
    await w.workers.recover(w.t.id);
    await w.workers.sweep(w.t.id);
    expect((await spent()) - before).toBe(300);
    // The session kept spending meanwhile.
    s.costCents = 120;
    w.fake.failNext.set("sessions.events.send", 0);
    await w.workers.sweep(w.t.id);
    await w.workers.recover(w.t.id);
    await w.workers.idle();
    r = await runRow(id);
    expect(s.received.some((e) => e.type === "user.interrupt")).toBe(true);
    // Confirmed stopped: the reservation is replaced by the session's final cost.
    expect(Number(r.cost_cents)).toBe(120);
    expect((await spent()) - before).toBe(120);
  }, 60_000);
});

describe("KILL", () => {
  test("KILL: a kill switch that interrupts the session while its stream opens is never followed by the first message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let opening!: () => void;
    const atOpen = new Promise<void>((r) => (opening = r));
    w.workers.configure({
      api: {
        ...base,
        streamEvents: async (sid, signal) => {
          opening();
          await gate;
          return base.streamEvents(sid, signal);
        },
      },
    });
    w.fake.queue([{ await: "user.message" }, { emit: [running, endTurn], cost: 7 }]);
    const id = await post();
    await atOpen;
    const s = lastSession();
    // The kill switch: the interrupt is requested and delivered while the stream is still opening.
    await w.workers.interruptAll(w.t.id, { tenant: true });
    expect(s.received.map((e) => e.type)).toEqual(["user.interrupt"]);
    release();
    await w.workers.idle();
    expect(s.received.some((e) => e.type === "user.message")).toBe(false);
    const r = await runRow(id);
    expect(r.ended_at).not.toBeNull();
    expect(r.state).toBe("interrupted");
  }, 60_000);
});

describe("SESSION", () => {
  test("SESSION: catch-up after a drop handles an unseen event whose processed_at is older than one already handled", async () => {
    // The first event is processed late (its processed_at is ahead of the next one's); the stream drops after it,
    // before the terminal idle arrives, and the reconnected stream replays nothing.
    const late = new Date(w.h.clock.now() + 3_600_000).toISOString();
    w.fake.queue([{ await: "user.message" }, { emit: [{ ...running, processed_at: late }, endTurn], cost: 9 }]);
    w.fake.dropAfter = 2;
    const id = await post();
    await w.workers.idle();
    const r = await runRow(id);
    expect(r.ended_at).not.toBeNull();
    expect(r.state).toBe("done");
  }, 60_000);
});
