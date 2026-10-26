// Codex review of a7fad80: a run's overnight policy is one its runner owns (role identities too), never one picked by
// sort order; a run's result and cost reach its policy once even when finish and recovery report it at the same time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorkers } from "../../src/modules/workers/orchestrator.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { createWorker, overnightPolicy, requiresAction, running, world, type World } from "./setup.ts";

let w: World;

beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.workers.interruptAll(w.t.id, { tenant: true });
  await w.workers.idle();
  await w.close();
});

const importedRun = async (deploymentId: string) => {
  const sid = w.fake.fire(deploymentId)!;
  await w.workers.pollDeployments(w.t.id);
  await w.workers.idle();
  return (await w.h.db.migrator`select runner_person_id, overnight_policy_id from worker_runs where session_ref = ${sid}`)[0]!;
};

describe("SCHEDULE", () => {
  test("SCHEDULE: a role-identity run never takes an overnight policy another person owns", async () => {
    // The member's policy for this workflow version; the worker below runs as the role identity, owned by the admin.
    const memberPolicy = await overnightPolicy(w);
    try {
      const x = await createWorker(w, { schedule: { cron: "0 22 * * *", timezone: "UTC" } });
      const r = await importedRun(x.externalRefs.deploymentId as string);
      expect(r.runner_person_id).not.toBe(w.t.people.member.id);
      expect(r.overnight_policy_id).not.toBe(memberPolicy);
      expect(r.overnight_policy_id).toBeNull();
    } finally {
      await w.h.db.migrator`update overnight_policies set state = 'paused' where id = ${memberPolicy}`;
    }
  }, 60_000);

  test("SCHEDULE: a runner with two active policies for the version gets neither (no pick by sort order)", async () => {
    const a = await overnightPolicy(w);
    const b = await overnightPolicy(w);
    try {
      const x = await createWorker(w, { identityId: w.t.people.member.id, schedule: { cron: "0 21 * * *", timezone: "UTC" } });
      const r = await importedRun(x.externalRefs.deploymentId as string);
      expect(r.runner_person_id).toBe(w.t.people.member.id);
      expect(r.overnight_policy_id).toBeNull();
    } finally {
      await w.h.db.migrator`update overnight_policies set state = 'paused' where id in (${a}, ${b})`;
    }
  }, 60_000);
});

describe("BUDGET", () => {
  test("BUDGET: two recoveries at once report a failed run's result and cost to its policy once", async () => {
    const policyId = await overnightPolicy(w);
    const x = await createWorker(w, { identityId: w.t.people.member.id });
    const id = ulid(w.h.clock.now());
    const at = new Date(w.h.clock.now());
    await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, ended_at, state, stop_reason,
        budget_cents, cost_cents, overnight, overnight_policy_id)
      values (${w.t.id}, ${id}, ${x.id}, 'schedule', ${w.t.people.member.id}, ${at}, ${at}, 'failed', 'error', 300, 40, true, ${policyId})`;
    const counted = async () => Number((await w.h.db.migrator`select coalesce(sum(budget_cents), 0)::int as c from overnight_counters where policy_id = ${policyId}`)[0]!.c);
    const before = await counted();
    await Promise.all([w.workers.recover(w.t.id), w.workers.recover(w.t.id), w.workers.recover(w.t.id)]);
    const [p] = await w.h.db.migrator`select state, consecutive_failures from overnight_policies where id = ${policyId}`;
    // One failure, not three: the breaker (2 in a row) has not tripped.
    expect(Number(p!.consecutive_failures)).toBe(1);
    expect(p!.state).toBe("active");
    expect((await counted()) - before).toBe(40);
    const [r] = await w.h.db.migrator`select policy_reported_at, policy_cost_cents from worker_runs where id = ${id}`;
    expect(r!.policy_reported_at).not.toBeNull();
    expect(Number(r!.policy_cost_cents)).toBe(40);
  }, 60_000);
});

describe("SCHEDULE", () => {
  test("SCHEDULE: two polls at once import a deployment run once, and neither fails", async () => {
    const x = await createWorker(w, { identityId: w.t.people.member.id, schedule: { cron: "0 20 * * *", timezone: "UTC" } });
    const sid = w.fake.fire(x.externalRefs.deploymentId as string)!;
    await Promise.all([w.workers.pollDeployments(w.t.id), w.workers.pollDeployments(w.t.id)]);
    await w.workers.idle();
    expect((await w.h.db.migrator`select count(*)::int as n from worker_runs where session_ref = ${sid}`)[0]!.n).toBe(1);
  }, 60_000);
});

describe("SESSION", () => {
  test("SESSION: two consumers of one session (two processes) act on an event once", async () => {
    const x = await createWorker(w, { identityId: w.t.people.member.id });
    // A session already running, its tool request not yet answered, and no consumer attached anywhere.
    const s = await w.fake.api().createSession({
      agent: { type: "agent", id: x.externalRefs.agentId, version: 1 },
      environment_id: x.externalRefs.environmentId,
      vault_ids: [],
      budget: { type: "limit", max_list_cost: { amount: "300", currency: "USD" } },
      title: "two consumers",
      metadata: {},
    } as never);
    const id = ulid(w.h.clock.now());
    await w.h.db.migrator`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, started_at, state, budget_cents, session_ref, first_sent_at)
      values (${w.t.id}, ${id}, ${x.id}, 'manual', ${w.t.people.member.id}, ${new Date(w.h.clock.now())}, 'running', 300, ${s.id}, ${new Date(w.h.clock.now())})`;
    await w.h.db.migrator`insert into session_cursors (tenant_id, session_id, run_id) values (${w.t.id}, ${s.id}, ${id})`;
    w.fake.inject(s.id, [running, { id: "evt_two_1", type: "agent.mcp_tool_use", mcp_server_name: "gmail", name: "search_emails", input: { query: "x" }, evaluated_permission: "ask" }, requiresAction(["evt_two_1"])]);
    const other = createWorkers(w.h.deps);
    other.configure({ api: w.fake.api() });
    try {
      await Promise.all([w.workers.resume(w.t.id, id), other.resume(w.t.id, id)]);
      await Promise.all([w.workers.idle(), other.idle()]);
      expect(w.fake.sent(s.id).filter((e) => e.type === "user.tool_confirmation" && e.tool_use_id === "evt_two_1")).toHaveLength(1);
    } finally {
      other.shutdown();
    }
  }, 60_000);
});
