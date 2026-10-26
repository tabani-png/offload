// Codex review of a9bf194: a scheduled run passes the same gates a manual run passes, at admission and for as long as
// its deployment is active; lists filter before they limit.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "../../src/schema/encoding.ts";
import type { Step } from "../../src/modules/workers/fake-managed-agents.ts";
import { createWorker, running, world, type World } from "./setup.ts";

let w: World;

beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const hanging = (): Step[] => [{ await: "user.message" }, { emit: [running] }, { await: "user.custom_tool_result" }];
const remote = (depId: string) => w.fake.deployments.get(depId)!.status;
const runOfSession = async (sid: string) => (await w.h.db.migrator`select * from worker_runs where session_ref = ${sid}`)[0]!;
const cap = (cents: number) => w.h.db.migrator`update tenants set monthly_worker_budget_cents = ${cents} where id = ${w.t.id}`;

/** The platform fires the deployment; the poll job admits (or refuses) the run. Returns the session id. */
async function fire(depId: string): Promise<string> {
  w.fake.queue(hanging());
  const sid = w.fake.fire(depId);
  expect(sid).not.toBeNull();
  await w.workers.pollDeployments(w.t.id);
  await w.workers.idle();
  return sid!;
}

describe("BUDGET", () => {
  test("BUDGET: a scheduled session over the monthly cap is stopped and its deployment paused until the budget allows again", async () => {
    const x = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "UTC" } });
    const dep = x.externalRefs.deploymentId as string;
    await cap(0);
    try {
      const sid = await fire(dep);
      const r = await runOfSession(sid);
      expect(r.error_code).toBe("budget_exceeded");
      expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.interrupt")).toHaveLength(1);
      expect(remote(dep)).toBe("paused");
      // Still no budget: the sweep keeps it paused.
      await w.workers.sweep(w.t.id);
      await w.workers.idle();
      expect(remote(dep)).toBe("paused");
    } finally {
      await cap(100000);
    }
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    expect(remote(dep)).toBe("active");
  }, 60_000);
});

describe("SCHEDULE", () => {
  test("SCHEDULE: a scheduled run of a person who lost the job role is refused at admission and the deployment paused", async () => {
    const x = await createWorker(w, { identityId: w.t.people.member.id, schedule: { cron: "0 21 * * *", timezone: "UTC" } });
    const dep = x.externalRefs.deploymentId as string;
    await w.h.db.migrator`delete from job_role_holders where tenant_id = ${w.t.id} and person_id = ${w.t.people.member.id} and job_role_id = ${w.t.jobRoles.sdr}`;
    try {
      const sid = await fire(dep);
      const r = await runOfSession(sid);
      expect(r.error_code).toBe("ineligible");
      expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.interrupt")).toHaveLength(1);
      expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.tool_confirmation" || e.type === "user.custom_tool_result")).toEqual([]);
      expect(remote(dep)).toBe("paused");
    } finally {
      await w.h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${w.t.id}, ${w.t.jobRoles.sdr}, ${w.t.people.member.id})
        on conflict do nothing`;
    }
    // Eligible again: the next sweep resumes the deployment.
    await w.workers.sweep(w.t.id);
    await w.workers.idle();
    expect(remote(dep)).toBe("active");
  }, 60_000);

  test("SCHEDULE: a workflow retired while its worker is active: the sweep interrupts the running session and pauses the deployment", async () => {
    const x = await createWorker(w, { workflowId: w.wfWeb.id, schedule: { cron: "0 20 * * *", timezone: "UTC" } });
    const dep = x.externalRefs.deploymentId as string;
    const sid = await fire(dep);
    expect((await runOfSession(sid)).ended_at).toBeNull();
    await w.h.db.migrator`update workflows set state = 'retired' where tenant_id = ${w.t.id} and id = ${w.wfWeb.id}`;
    try {
      await w.workers.sweep(w.t.id);
      await w.workers.idle();
      expect(w.fake.receivedBy(sid).filter((e) => e.type === "user.interrupt")).toHaveLength(1);
      expect(remote(dep)).toBe("paused");
    } finally {
      await w.h.db.migrator`update workflows set state = 'role' where tenant_id = ${w.t.id} and id = ${w.wfWeb.id}`;
    }
  }, 60_000);
});

describe("PROVISION", () => {
  test("PROVISION: the worker list filters by visibility before it limits: 1001 invisible workers first do not hide later visible ones", async () => {
    const x = await createWorker(w);
    await w.h.db.migrator`insert into workers (tenant_id, id, workflow_id, version, job_role_id, department_id, identity_type, identity_id,
        owner_person_id, state, session_budget_cents, template_hash, created_by, created_at, updated_at)
      select tenant_id, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, workflow_id, version, ${w.t.jobRoles.ap}, ${w.t.departments.finance},
        identity_type, identity_id, owner_person_id, 'retired', session_budget_cents, template_hash, created_by, created_at, updated_at
      from workers, generate_series(1, 1001) g where id = ${x.id}`;
    try {
      const member = await w.as("member");
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const r = await member.get(`/v1/workers?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.status).toBe(200);
        seen.push(...r.json.items.map((it: { id: string }) => it.id));
        cursor = r.json.page?.nextCursor ?? null;
        if (!cursor) break;
      }
      expect(seen).toContain(x.id);
      expect(seen.some((id) => id.startsWith("00000000-0000-4000-8000-"))).toBe(false);
    } finally {
      await w.h.db.migrator`delete from workers where tenant_id = ${w.t.id} and id::text like '00000000-0000-4000-8000-%'`;
    }
  }, 60_000);
});

describe("DIGEST", () => {
  test("DIGEST: the total cost counts every run of the window, not only the listed ones", async () => {
    const x = await createWorker(w);
    const now = w.h.clock.now();
    const ids = Array.from({ length: 201 }, (_, i) => ulid(now - 1000 - i));
    for (const id of ids) {
      await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, ended_at, state, stop_reason, cost_cents, budget_cents)
        values (${w.t.id}, ${id}, ${x.id}, 'manual', ${w.t.people.member2.id}, ${new Date(now - 1000)}, ${new Date(now - 500)}, 'done', 'end_turn', 1, 300)`;
    }
    const day = new Date(now + 12 * 3600_000).toISOString().slice(0, 10);
    const d = await (await w.as("member2")).get(`/v1/me/digest?day=${day}`);
    expect(d.status).toBe(200);
    expect(d.json.totalCostCents).toBe(201);
  }, 60_000);
});
