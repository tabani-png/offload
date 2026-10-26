import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorker, email, manualRun, proposeScript, running, world, type World } from "./setup.ts";
import type { Step } from "../../src/modules/workers/fake-managed-agents.ts";

let w: World;
let a: Record<string, any>;
let b: Record<string, any>;

beforeAll(async () => {
  w = await world();
  a = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "UTC" } });
  b = await createWorker(w, { workflowId: w.wfWeb.id, schedule: { cron: "0 5 * * *", timezone: "UTC" } });
});
afterAll(() => w.close());

/** A session that reads, then waits forever for a confirmation that never comes in this test. */
const hanging = (): Step[] => [
  { await: "user.message" },
  { emit: [running, { type: "agent.message", content: [{ type: "text", text: "working" }] }] },
  { await: "user.custom_tool_result" },
];

async function startHanging(workerId: string) {
  w.fake.queue(hanging());
  const before = w.fake.sessions.size;
  const r = await (await w.as("member")).post(`/v1/workers/${workerId}/runs`, {});
  expect(r.status).toBe(201);
  // Let the consumer create the session, attach and send the first message.
  const sent = () => (w.fake.sessions.size > before ? w.fake.sent([...w.fake.sessions.values()].pop()!.id).length : 0);
  for (let i = 0; i < 200 && sent() === 0; i++) await Bun.sleep(5);
  expect(sent()).toBe(1);
  return r.json.id as string;
}

const runState = async (id: string) => (await (await w.as("admin")).get(`/v1/worker-runs/${id}`)).json.state as string;
const killSwitch = async (scope: string, targetId: string | null) => {
  const r = await (await w.as("owner")).post("/v1/kill-switches", { scope, targetId, reason: "test" });
  expect(r.status).toBe(201);
};
/** Clears a switch. Workers a kill paused stay paused until someone resumes them (here: the owner, at once). */
const clearSwitch = async (scope: string, targetId: string | null) => {
  const owner = await w.as("owner");
  expect((await owner.del(`/v1/kill-switches/${scope}/${targetId}`)).status).toBe(200);
  for (const x of (await owner.get("/v1/workers?limit=200")).json.items) {
    if (x.state === "paused") expect((await owner.post(`/v1/workers/${x.id}/resume`)).status).toBe(200);
  }
  await w.workers.idle();
};

describe("KILL", () => {
  test("KILL: a workflow kill interrupts only that workflow's running sessions and pauses only its deployment", async () => {
    const r1 = await startHanging(a.id);
    const r2 = await startHanging(b.id);
    await killSwitch("workflow", w.wf.id);
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    expect(await runState(r1)).toBe("interrupted");
    expect(await runState(r2)).toBe("running");
    expect(w.fake.deployments.get(a.externalRefs.deploymentId)!.status).toBe("paused");
    expect(w.fake.deployments.get(b.externalRefs.deploymentId)!.status).toBe("active");
    await clearSwitch("workflow", w.wf.id);
    await w.workers.interruptAll(w.t.id, { tenant: true });
    await w.workers.idle();
  });

  test("KILL: a tenant kill sends user.interrupt to every running session and pauses every deployment", async () => {
    const r1 = await startHanging(a.id);
    const r2 = await startHanging(b.id);
    await killSwitch("tenant", null);
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    for (const id of [r1, r2]) {
      expect(await runState(id)).toBe("interrupted");
      const [r] = await w.h.db.migrator`select session_ref from worker_runs where id = ${id}`;
      expect(w.fake.sent(r!.session_ref as string).filter((e) => e.type === "user.interrupt")).toHaveLength(1);
    }
    for (const x of [a, b]) expect(w.fake.deployments.get(x.externalRefs.deploymentId)!.status).toBe("paused");
    // A second sweep sends nothing new.
    const sends = w.fake.ops("sessions.events.send").length;
    await w.workers.sweep(w.t.id);
    expect(w.fake.ops("sessions.events.send").length).toBe(sends);
  });

  test("KILL: while a kill switch is on, a new run is refused with kill_switch_active", async () => {
    const r = await (await w.as("member")).post(`/v1/workers/${a.id}/runs`, {});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("kill_switch_active");
    await clearSwitch("tenant", null);
  });

  test("KILL: queued batches stay queued (pending) after a kill; nothing is sent", async () => {
    w.fake.queue(proposeScript([email("anna@northzone.com")]));
    const { run } = await manualRun(w, a.id, { recipients: ["anna@northzone.com"] });
    const hash = run!.batchHashes[0];
    await killSwitch("tenant", null);
    await w.workers.sweep(w.t.id);
    const [bt] = await w.h.db.migrator`select state from batches where hash = ${hash}`;
    expect(bt!.state).toBe("pending");
    expect(w.composio.sends()).toEqual([]);
    await clearSwitch("tenant", null);
  });

  test("KILL: an event that arrives while a kill switch is on is not acted on; the session is interrupted", async () => {
    w.fake.queue(proposeScript([email("anna@northzone.com")]));
    await killSwitch("workflow", w.wf.id);
    // Bypass the route's check (a run that started just before the switch): resume consumption of a fresh session.
    const runId = await w.workers.startRunUnchecked(w.t.id, a.id, { trigger: "manual", runnerPersonId: w.t.people.member.id, inputs: null });
    await w.workers.idle();
    expect(await runState(runId)).toBe("interrupted");
    const [r] = await w.h.db.migrator`select session_ref from worker_runs where id = ${runId}`;
    const sent = w.fake.sent(r!.session_ref as string);
    expect(sent.filter((e) => e.type === "user.tool_confirmation" && e.result === "allow")).toEqual([]);
    expect(sent.filter((e) => e.type === "user.custom_tool_result")).toEqual([]);
    await clearSwitch("workflow", w.wf.id);
  });

  test("KILL: a person kill (broker route → WorkersPort.pauseFor) pauses that person's workers and interrupts their sessions", async () => {
    const mine = await createWorker(w, { identityId: w.t.people.member.id, schedule: { cron: "0 20 * * *", timezone: "UTC" } });
    const runId = await startHanging(mine.id);
    await w.workers.resume(w.t.id, runId);
    await killSwitch("person", w.t.people.member.id);
    await w.workers.idle();
    const g = (await (await w.as("admin")).get("/v1/workers")).json.items.find((x: { id: string }) => x.id === mine.id);
    expect(g.state).toBe("paused");
    expect(w.fake.deployments.get(mine.externalRefs.deploymentId)!.status).toBe("paused");
    expect(await runState(runId)).toBe("interrupted");
    const [k] = await w.h.db.migrator`select detail from audit_events where action = 'kill.set' order by seq desc limit 1`;
    expect(Number(k!.detail.workersPaused)).toBeGreaterThanOrEqual(1);
    await clearSwitch("person", w.t.people.member.id);
  });
});
