// Codex review of 86d4dd0: a lost session's settled cost reaches metrics and its overnight policy's counter (the
// unreported delta, once); a scheduled run imported late starts when the platform started it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { digestDayOf } from "../../src/modules/workers/digest.ts";
import type { Step } from "../../src/modules/workers/fake-managed-agents.ts";
import type { ManagedAgentsApi } from "../../src/modules/workers/managed-agents.ts";
import { DIGEST, WORKER_RUN, createWorker, overnightPolicy, running, world, type World } from "./setup.ts";

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

describe("CUSTOM", () => {
  test("CUSTOM: offload_report promises only what a reader shows: the summary is on the run, not in the digest", async () => {
    const x = await createWorker(w);
    const tool = (w.fake.ops("agents.create").at(-1)!.body!.tools as Array<Record<string, any>>).find((t) => t.name === "offload_report")!;
    expect(tool.description).not.toMatch(/digest/i);
    w.fake.queue([
      { await: "user.message" },
      { emit: [running, { id: "evt_rep_r6", type: "agent.custom_tool_use", name: "offload_report", input: { summary: "Drafted two follow-ups." } }, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_rep_r6"] } }] },
      { await: "user.custom_tool_result", where: (e) => e.custom_tool_use_id === "evt_rep_r6" },
      { emit: [{ type: "session.status_idle", stop_reason: { type: "end_turn" } }] },
    ]);
    const c = await w.as("member");
    const r = await c.post(`/v1/workers/${x.id}/runs`, {});
    expect(r.status).toBe(201);
    await w.workers.idle();
    const sid = [...w.fake.sessions.values()].pop()!.id;
    const result = w.fake.sent(sid).find((e) => e.type === "user.custom_tool_result")!;
    expect(result.content[0].text).not.toMatch(/digest/i);
    expect((await c.get(`/v1/worker-runs/${r.json.id}`)).json.summary).toBe("Drafted two follow-ups.");
  }, 60_000);
});

describe("CUSTOM", () => {
  const ask = (id: string, question: string): Step[] => [
    { emit: [running, { id, type: "agent.custom_tool_use", name: "offload_need_human", input: { question } }, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [id] } }] },
    { await: "user.custom_tool_result", where: (e) => e.custom_tool_use_id === id },
  ];

  test("CUSTOM: offload_need_human's question is on the run and in the digest, with its run, workflow and time; only then is the agent told a person sees it", async () => {
    const x = await createWorker(w);
    w.fake.queue([{ await: "user.message" }, ...ask("evt_q_1", "Which pricing tier should I quote?"), { emit: [{ type: "session.status_idle", stop_reason: { type: "end_turn" } }] }]);
    const c = await w.as("member");
    const t0 = w.h.clock.now();
    const r = await c.post(`/v1/workers/${x.id}/runs`, {});
    expect(r.status).toBe(201);
    await w.workers.idle();
    const sid = [...w.fake.sessions.values()].pop()!.id;
    const result = w.fake.sent(sid).find((e) => e.type === "user.custom_tool_result")!;
    expect(result.content[0].text).toMatch(/person will see/i);
    const run = (await c.get(`/v1/worker-runs/${r.json.id}`)).json;
    expect(w.h.deps.validator.validate(WORKER_RUN, run)).toEqual({ ok: true });
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0].question).toBe("Which pricing tier should I quote?");
    expect(run.questions[0].askedAt).toBeGreaterThanOrEqual(t0);
    const d = (await c.get(`/v1/me/digest?day=${digestDayOf(w.h.clock.now(), "UTC")}`)).json;
    expect(w.h.deps.validator.validate(DIGEST, d)).toEqual({ ok: true });
    expect(d.questions).toContainEqual({ runId: r.json.id, workflowId: w.wf.id, question: "Which pricing tier should I quote?", askedAt: run.questions[0].askedAt });
  }, 60_000);

  test("CUSTOM: a question that cannot be stored (the run's 20 are used) is not promised to a person", async () => {
    const x = await createWorker(w);
    const steps: Step[] = [{ await: "user.message" }];
    for (let i = 1; i <= 21; i++) steps.push(...ask(`evt_q_many_${i}`, `Question ${i}?`));
    steps.push({ emit: [{ type: "session.status_idle", stop_reason: { type: "end_turn" } }] });
    w.fake.queue(steps);
    const c = await w.as("member");
    const r = await c.post(`/v1/workers/${x.id}/runs`, {});
    await w.workers.idle();
    const sid = [...w.fake.sessions.values()].pop()!.id;
    const results = w.fake.sent(sid).filter((e) => e.type === "user.custom_tool_result");
    expect(results).toHaveLength(21);
    expect(results[19]!.content[0].text).toMatch(/person will see/i);
    expect(results[20]!.content[0].text).not.toMatch(/person will see/i);
    expect(results[20]!.is_error).toBe(true);
    expect((await c.get(`/v1/worker-runs/${r.json.id}`)).json.questions).toHaveLength(20);
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
