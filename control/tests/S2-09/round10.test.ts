// Codex review of f229e62: a worker sync never holds a pool connection while it waits for another one (no pool
// deadlock); two processes recovering one session send its first message once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorkers } from "../../src/modules/workers/orchestrator.ts";
import { ulid } from "../../src/schema/encoding.ts";
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

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => "done" as const), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

describe("PROVISION", () => {
  test("PROVISION: a worker sync completes while all but one pool connection are busy (no connection held across nested transactions)", async () => {
    const x = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "UTC" } });
    // A schedule change leaves a deployment to replace: the sync archives one and creates one (several transactions).
    expect((await (await w.as("admin")).patch(`/v1/workers/${x.id}`, { schedule: { cron: "0 7 * * *", timezone: "UTC" } })).status).toBe(200);
    // All but one of the pool's connections (the test pool has 8) are taken by other work (other tenants' syncs, requests).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = Array.from({ length: 7 }, () =>
      w.h.deps.db.begin(async (tx) => {
        await tx`select 1`;
        await gate;
      }),
    );
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await within(w.workers.reconcile(w.t.id, x.id), 8_000)).toBe("done");
    } finally {
      release();
      await Promise.all(held);
    }
    await w.workers.idle();
    expect(w.fake.deploymentsOf(x.id).filter((d) => d.status === "active").map((d) => d.body.schedule.expression)).toEqual(["0 7 * * *"]);
  }, 30_000);
});

describe("SESSION", () => {
  test("SESSION: two processes recovering a session whose first message was not sent send it once", async () => {
    const x = await createWorker(w, { identityId: w.t.people.member.id });
    w.fake.queue([{ await: "user.message" }]);
    const s = await w.fake.api().createSession({
      agent: { type: "agent", id: x.externalRefs.agentId, version: 1 },
      environment_id: x.externalRefs.environmentId,
      vault_ids: [],
      budget: { type: "limit", max_list_cost: { amount: "300", currency: "USD" } },
      title: "first once",
      metadata: {},
    } as never);
    const id = ulid(w.h.clock.now());
    const first = { type: "user.message", content: [{ type: "text", text: "Run the workflow." }] };
    await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, state, budget_cents, session_ref, first_message)
      values (${w.t.id}, ${id}, ${x.id}, 'manual', ${w.t.people.member.id}, ${new Date(w.h.clock.now())}, 'running', 300, ${s.id}, ${first}::jsonb)`;
    await w.h.db.migrator`insert into session_cursors (tenant_id, session_id, run_id) values (${w.t.id}, ${s.id}, ${id})`;
    const other = createWorkers(w.h.deps);
    other.configure({ api: w.fake.api() });
    try {
      await Promise.all([w.workers.resume(w.t.id, id), other.resume(w.t.id, id)]);
      await Promise.all([w.workers.idle(), other.idle()]);
      expect(w.fake.sent(s.id).filter((e) => e.type === "user.message")).toHaveLength(1);
      const [r] = await w.h.db.migrator`select first_sent_at from worker_runs where id = ${id}`;
      expect(r!.first_sent_at).not.toBeNull();
    } finally {
      other.shutdown();
    }
  }, 60_000);
});
