// Codex review of d57279c: the role policy's session budget is a ceiling read at every admission and sync, not only
// when the worker is created. A worker made under a higher cap runs at the lower one: a manual session is created
// with min(worker budget, role cap); a scheduled session above the cap is refused; the deployment is replaced.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createWorker, world, type World } from "./setup.ts";

let w: World;
let roleCap: number;

beforeAll(async () => {
  w = await world();
  roleCap = Number((await w.h.db.migrator`select session_budget_cents from role_policies where job_role_id = ${w.t.jobRoles.sdr}`)[0]!.session_budget_cents);
});
afterEach(async () => {
  await w.h.db.migrator`update role_policies set session_budget_cents = ${roleCap} where job_role_id = ${w.t.jobRoles.sdr}`;
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const lowerCap = (cents: number) => w.h.db.migrator`update role_policies set session_budget_cents = ${cents} where job_role_id = ${w.t.jobRoles.sdr}`;
const budget = (cents: number) => ({ type: "limit", max_list_cost: { amount: String(cents), currency: "USD" } });

describe("BUDGET", () => {
  test("BUDGET: a manual run of a worker made under a higher role cap reserves and creates its session at the current cap", async () => {
    const x = await createWorker(w, { sessionBudgetCents: 300 });
    await lowerCap(200);
    const before = w.fake.ops("sessions.create").length;
    const r = await (await w.as("member")).post(`/v1/workers/${x.id}/runs`, {});
    expect(r.status).toBe(201);
    await w.workers.idle();
    const created = w.fake.ops("sessions.create").slice(before);
    expect(created).toHaveLength(1);
    expect(created[0]!.body!.budget).toEqual(budget(200));
    const [row] = await w.h.db.migrator`select budget_cents from worker_runs where id = ${r.json.id}`;
    expect(Number(row!.budget_cents)).toBe(200);
  }, 60_000);

  test("BUDGET: a deployment made above a lowered role cap is replaced at the cap; a session it fired above the cap is refused", async () => {
    const x = await createWorker(w, { identityId: w.t.people.member.id, sessionBudgetCents: 300, schedule: { cron: "0 22 * * *", timezone: "UTC" } });
    const old = x.externalRefs.deploymentId as string;
    expect(w.fake.deployments.get(old)!.body.budget).toEqual(budget(300));
    await lowerCap(200);
    // The platform fires the old deployment before any sync saw the new cap.
    const sid = w.fake.fire(old)!;
    await w.workers.pollDeployments(w.t.id);
    await w.workers.idle();
    const [run] = await w.h.db.migrator`select error_code, interrupt_sent_at from worker_runs where session_ref = ${sid}`;
    expect(run!.error_code).toBe("budget_above_role_cap");
    expect(run!.interrupt_sent_at).not.toBeNull();
    expect(w.fake.receivedBy(sid).some((e) => e.type === "user.interrupt")).toBe(true);
    // The sweep (and the refusal) sync the worker: the old deployment is archived, a new one runs at the cap.
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    expect(w.fake.deployments.get(old)!.status).toBe("archived");
    const live = w.fake.deploymentsOf(x.id).filter((d) => d.status === "active");
    expect(live).toHaveLength(1);
    expect(live[0]!.body.budget).toEqual(budget(200));
  }, 60_000);
});
