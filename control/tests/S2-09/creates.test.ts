// Codex review of 04078b6: remote creates must be serialized and never repeated blindly (a second active deployment
// schedules paid sessions nobody can pause), and a session whose first message was never sent must be started (or
// failed) by recovery.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorker, world, type World } from "./setup.ts";

let w: World;

beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

/** A ready worker with a schedule whose remote deployment does not exist yet (no reconcile dispatched for it). */
async function unsynced(): Promise<string> {
  const x = await createWorker(w);
  await w.h.db.migrator`insert into deployments (tenant_id, worker_id, cron, timezone, desired_status, updated_at)
    values (${w.t.id}, ${x.id}, '0 22 * * *', 'UTC', 'active', now())`;
  return x.id as string;
}

const active = (workerId: string) => w.fake.deploymentsOf(workerId).filter((d) => d.status === "active");
const deploymentRow = async (workerId: string) => (await w.h.db.migrator`select * from deployments where worker_id = ${workerId}`)[0]!;

describe("SCHEDULE", () => {
  test("SCHEDULE: two overlapping reconciles of one worker create exactly one remote deployment", async () => {
    const id = await unsynced();
    w.fake.delayMs.set("deployments.create", 300);
    try {
      await Promise.all([w.workers.reconcile(w.t.id, id), w.workers.reconcile(w.t.id, id), w.workers.reconcile(w.t.id)]);
      await w.workers.idle();
    } finally {
      w.fake.delayMs.delete("deployments.create");
    }
    expect(active(id)).toHaveLength(1);
    expect((await deploymentRow(id)).deployment_id).toBe(active(id)[0]!.id);
  }, 60_000);

  test("SCHEDULE: a create whose answer was lost is never repeated; the unconfirmed deployment is flagged for a person", async () => {
    const id = await unsynced();
    w.fake.loseResponseNext.set("deployments.create", 3);
    try {
      await w.workers.reconcile(w.t.id, id);
      await w.workers.reconcile(w.t.id, id);
      await w.workers.reconcile(w.t.id);
      await w.workers.idle();
    } finally {
      w.fake.loseResponseNext.delete("deployments.create");
    }
    // The platform holds the one deployment it made; Offload made no second one and says so.
    expect(w.fake.deploymentsOf(id)).toHaveLength(1);
    const d = await deploymentRow(id);
    expect(d.deployment_id).toBeNull();
    const ev = await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action = 'worker.deployment_unconfirmed'
      and resource_id = ${id}`;
    expect(ev).toHaveLength(1);
  }, 60_000);
});

describe("SESSION", () => {
  test("SESSION: a session recorded before its first message was sent (process exit) gets that message from recovery, once", async () => {
    const x = await createWorker(w);
    // The process stops while the stream is opening: the session id is recorded, the first message is not sent.
    w.fake.delayMs.set("sessions.events.stream", 400);
    const r = await (await w.as("member")).post(`/v1/workers/${x.id}/runs`, {});
    expect(r.status).toBe(201);
    const runId = r.json.id as string;
    let sid = "";
    for (let i = 0; i < 400 && sid === ""; i++) {
      sid = ((await w.h.db.migrator`select session_ref from worker_runs where id = ${runId}`)[0]?.session_ref as string) ?? "";
      if (sid === "") await Bun.sleep(5);
    }
    expect(sid).not.toBe("");
    w.workers.shutdown();
    await w.workers.idle();
    w.fake.delayMs.delete("sessions.events.stream");
    expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.message")).toHaveLength(0);
    await w.workers.recover(w.t.id);
    await w.workers.idle();
    await w.workers.recover(w.t.id);
    await w.workers.idle();
    expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.message")).toHaveLength(1);
    const [run] = await w.h.db.migrator`select state, ended_at from worker_runs where id = ${runId}`;
    expect(run!.state).toBe("done");
  }, 60_000);
});
