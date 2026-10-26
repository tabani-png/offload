import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nextRun } from "../../src/modules/workers/cron.ts";
import { createWorker, endTurn, running, world, type World } from "./setup.ts";

let w: World;
let worker: Record<string, any>;

beforeAll(async () => {
  w = await world();
  worker = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "America/Toronto" } });
});
afterAll(() => w.close());

const deploymentOf = (id: string) => w.fake.deployments.get(id)!;
const runs = async () => (await (await w.as("admin")).get(`/v1/workers/${worker.id}/runs`)).json.items as Array<Record<string, any>>;

describe("SCHEDULE", () => {
  test("SCHEDULE: a valid cron is accepted and its next run is computed in the worker's timezone", () => {
    expect(worker.schedule).toEqual({ cron: "0 22 * * *", timezone: "America/Toronto", nextRunAt: nextRun("0 22 * * *", "America/Toronto", w.h.clock.now()) });
    expect(deploymentOf(worker.externalRefs.deploymentId).status).toBe("active");
  });

  test("SCHEDULE: 02:30 local is rejected on create and on PATCH, and nothing reaches Managed Agents", async () => {
    const admin = await w.as("admin");
    const deployments = w.fake.ops("deployments.create").length;
    const c = await admin.post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100, schedule: { cron: "30 2 * * *", timezone: "Europe/Berlin" } });
    expect(c.status).toBe(400);
    expect(c.json.error.message).toMatch(/01:00 and 03:59/);
    const p = await admin.patch(`/v1/workers/${worker.id}`, { schedule: { cron: "30 2 * * *", timezone: "America/Toronto" } });
    expect(p.status).toBe(400);
    expect((await admin.patch(`/v1/workers/${worker.id}`, { schedule: { cron: "0 22 * * *", timezone: "Nowhere/Land" } })).status).toBe(400);
    await w.workers.idle();
    expect(w.fake.ops("deployments.create").length).toBe(deployments);
  });

  test("SCHEDULE: PATCH to a new valid schedule replaces the deployment; null removes it", async () => {
    const admin = await w.as("admin");
    const old = worker.externalRefs.deploymentId as string;
    const p = await admin.patch(`/v1/workers/${worker.id}`, { schedule: { cron: "0 6 * * 1-5", timezone: "America/Toronto" } });
    expect(p.status).toBe(200);
    await w.workers.idle();
    const g = (await admin.get("/v1/workers")).json.items.find((x: { id: string }) => x.id === worker.id);
    expect(g.schedule.cron).toBe("0 6 * * 1-5");
    expect(g.externalRefs.deploymentId).not.toBe(old);
    expect(deploymentOf(old).status).toBe("archived");
    worker = g;
    const tmp = await createWorker(w, { schedule: { cron: "0 7 * * *", timezone: "UTC" } });
    expect((await admin.patch(`/v1/workers/${tmp.id}`, { schedule: null })).status).toBe(200);
    await w.workers.idle();
    expect(deploymentOf(tmp.externalRefs.deploymentId).status).toBe("archived");
    expect((await admin.get("/v1/workers")).json.items.find((x: { id: string }) => x.id === tmp.id)).toMatchObject({ schedule: null, externalRefs: { deploymentId: null } });
  });

  test("SCHEDULE: a deployment firing is picked up by the poll job as a schedule run and consumed from its events", async () => {
    w.fake.queue([{ await: "user.message" }, { emit: [running, { type: "agent.message", content: [{ type: "text", text: "ok" }] }, endTurn], cost: 7 }]);
    const sid = w.fake.fire(worker.externalRefs.deploymentId);
    expect(sid).not.toBeNull();
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    const r = (await runs())[0]!;
    expect(r).toMatchObject({ trigger: "schedule", state: "done", sessionRef: sid, costCents: 7 });
    // Polling again does not create the run twice.
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    expect((await runs()).filter((x) => x.sessionRef === sid)).toHaveLength(1);
  });

  test("SCHEDULE: two consecutive failed runs pause the deployment and the worker", async () => {
    const dep = worker.externalRefs.deploymentId as string;
    w.fake.fire(dep, { error: "vault_not_found_error" });
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    let g = (await (await w.as("admin")).get("/v1/workers")).json.items.find((x: { id: string }) => x.id === worker.id);
    expect(g.state).toBe("ready");
    w.fake.queue([{ await: "user.message" }, { emit: [running, { type: "session.status_terminated" }] }]);
    w.fake.fire(dep);
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    g = (await (await w.as("admin")).get("/v1/workers")).json.items.find((x: { id: string }) => x.id === worker.id);
    expect(g.state).toBe("paused");
    expect(deploymentOf(dep).status).toBe("paused");
    const [a] = await w.h.db.migrator`select detail from audit_events where action = 'worker.auto_pause' and resource_id = ${worker.id}`;
    expect(a!.detail).toMatchObject({ reason: "consecutive_failures", failures: 2 });
    // A paused deployment does not fire.
    expect(w.fake.fire(dep)).toBeNull();
  });

  test("SCHEDULE: a success between failures resets the count; resume unpauses the deployment", async () => {
    const admin = await w.as("admin");
    const r = await admin.post(`/v1/workers/${worker.id}/resume`);
    expect(r.status).toBe(200);
    await w.workers.idle();
    const dep = worker.externalRefs.deploymentId as string;
    expect(deploymentOf(dep).status).toBe("active");
    w.fake.fire(dep, { error: "environment_not_found_error" });
    await w.workers.pollDeployments(w.t.id);
    w.fake.queue([{ await: "user.message" }, { emit: [endTurn] }]);
    w.fake.fire(dep);
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    w.fake.fire(dep, { error: "environment_not_found_error" });
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    const g = (await admin.get("/v1/workers")).json.items.find((x: { id: string }) => x.id === worker.id);
    expect(g.state).toBe("ready");
    expect(deploymentOf(dep).status).toBe("active");
  });

  test("SCHEDULE: pause and retire reach the deployment; a retired worker cannot run or resume", async () => {
    const admin = await w.as("admin");
    const dep = worker.externalRefs.deploymentId as string;
    expect((await admin.post(`/v1/workers/${worker.id}/pause`)).json.state).toBe("paused");
    await w.workers.idle();
    expect(deploymentOf(dep).status).toBe("paused");
    expect((await admin.post(`/v1/workers/${worker.id}/retire`)).json.state).toBe("retired");
    await w.workers.idle();
    expect(deploymentOf(dep).status).toBe("archived");
    expect((await admin.post(`/v1/workers/${worker.id}/resume`)).status).toBe(409);
    expect((await admin.post(`/v1/workers/${worker.id}/runs`, {})).status).toBe(409);
    const [a] = await w.h.db.migrator`select count(*)::int as n from audit_events where resource_id = ${worker.id} and action in ('worker.pause', 'worker.retire', 'worker.resume', 'worker.update')`;
    expect(a!.n).toBeGreaterThanOrEqual(4);
  });
});
