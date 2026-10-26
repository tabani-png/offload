import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { digestText } from "../../src/modules/workers/index.ts";
import { DIGEST, createWorker, email, endTurn, manualRun, overnightPolicy, proposeScript, running, world, type World } from "./setup.ts";

let w: World;
let worker: Record<string, any>;
let day: string;
let policyId: string;

beforeAll(async () => {
  w = await world();
  worker = await createWorker(w);
  // 1: a batch waiting for approval (cost 42). 2: nothing to approve (cost 8). 3: capped (cost 300).
  w.fake.queue(proposeScript([email("anna@northzone.com"), email("ben@northzone.com")], { cost: 42 }));
  await manualRun(w, worker.id, { recipients: ["anna@northzone.com", "ben@northzone.com"] });
  w.fake.queue([{ await: "user.message" }, { emit: [running, endTurn], cost: 8 }]);
  await manualRun(w, worker.id, undefined);
  w.fake.queue([{ await: "user.message" }, { emit: [running, { type: "session.status_idle", stop_reason: { type: "budget_reached" } }], cost: 300 }]);
  await manualRun(w, worker.id, undefined);
  // 4: an overnight run whose item the policy auto-approves (allowlisted recipient, window always open).
  policyId = await overnightPolicy(w);
  const mine = await createWorker(w, { identityId: w.t.people.member.id, schedule: { cron: "0 22 * * *", timezone: "UTC" } });
  w.fake.queue(proposeScript([email("anna@northzone.com", "Overnight note")], { cost: 11 }));
  w.fake.fire(mine.externalRefs.deploymentId);
  await w.workers.pollDeployments(w.t.id);
  await w.workers.idle();
  await w.broker.idle();
  day = new Date(w.h.clock.now() + 12 * 3600_000).toISOString().slice(0, 10);
});
afterAll(() => w.close());

const digest = async (who: "member" | "member2" | "lead" | "auditor" = "member", q = `?day=${day}`) => (await w.as(who)).get(`/v1/me/digest${q}`);

describe("DIGEST", () => {
  test("DIGEST: the digest validates against digest.schema.json", async () => {
    const d = await digest();
    expect(d.status).toBe(200);
    expect(w.h.deps.validator.validate(DIGEST, d.json)).toEqual({ ok: true });
    expect(d.json).toMatchObject({ personId: w.t.people.member.id, day, suggestions: [] });
  });

  test("DIGEST: costs sum: totalCostCents is the sum of the runs' costs", async () => {
    const d = (await digest()).json;
    expect(d.ran.map((r: { costCents: number }) => r.costCents).sort((a: number, b: number) => a - b)).toEqual([8, 11, 42, 300]);
    expect(d.totalCostCents).toBe(d.ran.reduce((s: number, r: { costCents: number }) => s + r.costCents, 0));
    expect(d.totalCostCents).toBe(361);
  });

  test("DIGEST: ran lists each run with its outcome and the drafts it made", async () => {
    const d = (await digest()).json;
    const outcomes = d.ran.map((r: { outcome: string; drafts: number }) => [r.outcome, r.drafts]).sort();
    expect(outcomes).toEqual([["capped", 0], ["success", 0], ["success", 1], ["success", 2]]);
  });

  test("DIGEST: waiting lists the pending batch with its item count; auto-committed names the policy", async () => {
    const d = (await digest()).json;
    expect(d.waiting).toHaveLength(1);
    expect(d.waiting[0]).toMatchObject({ workflowId: w.wf.id, items: 2 });
    expect(d.autoCommitted).toEqual([{ batchHash: expect.stringMatching(/^[0-9a-f]{64}$/), policyId, items: 1 }]);
    expect(d.trips).toEqual([]);
  });

  test("DIGEST: another person's digest does not show my runs; a day outside the window is empty", async () => {
    const other = (await digest("member2")).json;
    expect(other).toMatchObject({ ran: [], waiting: [], autoCommitted: [], trips: [], totalCostCents: 0 });
    const before = (await digest("member", "?day=2026-10-20")).json;
    expect(before.ran).toEqual([]);
    expect(before.totalCostCents).toBe(0);
  });

  test("DIGEST: day defaults to today in the tenant's timezone; bad days are 400; the auditor has no digest", async () => {
    const d = await digest("member", "");
    expect(d.status).toBe(200);
    expect(d.json.day).toBe(day);
    expect((await digest("member", "?day=2026-02-31")).status).toBe(400);
    expect((await digest("member", "?day=yesterday")).status).toBe(400);
    expect((await digest("auditor")).status).toBe(403);
  });

  test("DIGEST: the email template is plain text with the totals and no recipients or bodies", async () => {
    const d = (await digest()).json;
    const text = digestText(d);
    expect(text).toContain("4 runs");
    expect(text).toContain("$3.61");
    expect(text).toContain("1 batch waiting");
    expect(text).not.toContain("@");
    expect(text).not.toContain("short follow-up");
  });

  test("DIGEST: each digest read is audited, always about the reader themselves", async () => {
    await digest();
    const rows = await w.h.db.migrator`select actor_id, subject_person_id from audit_events where action = 'digest.read'`;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r: { actor_id: string; subject_person_id: string }) => r.subject_person_id === r.actor_id)).toBe(true);
    expect(rows.some((r: { subject_person_id: string }) => r.subject_person_id === w.t.people.member.id)).toBe(true);
  });
});

describe("RETENTION", () => {
  test("DIGEST: retention deletes sessions 30 days after the run ended, and only those", async () => {
    const before = [...w.fake.sessions.values()].filter((s) => s.deleted).length;
    await w.workers.retention(w.t.id);
    expect([...w.fake.sessions.values()].filter((s) => s.deleted).length).toBe(before);
    w.h.clock.advance(31 * 24 * 3600_000);
    await w.workers.retention(w.t.id);
    const ended = await w.h.db.migrator`select session_ref, session_deleted_at from worker_runs where tenant_id = ${w.t.id} and ended_at is not null`;
    expect(ended.length).toBeGreaterThan(0);
    for (const r of ended) {
      expect(r.session_deleted_at).not.toBeNull();
      expect(w.fake.sessions.get(r.session_ref as string)!.deleted).toBe(true);
    }
    expect((await w.h.db.migrator`select count(*)::int as n from session_events where tenant_id = ${w.t.id}`)[0]!.n).toBe(0);
    const n = w.fake.ops("sessions.delete").length;
    await w.workers.retention(w.t.id);
    expect(w.fake.ops("sessions.delete").length).toBe(n);
  });
});
