// S2-07 fix round 6 (PR #12 Codex review on 8cd854f, two P2s) and the class-wide audit behind them:
//   (a) a safety control (kill, stop, pause) is reachable by whoever may use it from the registry and org model, even
//       for a workflow with no batches or policies yet;
//   (b) the night is one local-calendar boundary (local noon): the night an instant belongs to and the instant a night
//       starts come from the same helpers, so the night cap holds across DST changes (America/Toronto spring-forward
//       and fall-back) and in a +5:30 zone.
// Every test here failed on 8cd854f.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as evaluate from "../../src/modules/policies/evaluate.ts";
import { client, email, overnightPolicy, overnightRun, propose, roleWorkflow, WF_AP, world, type World } from "./setup.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});
const db = () => w.h.db.migrator;
const QUARTER = 15 * 60_000;
const HOUR = 3600_000;

describe("S2-07 round 6 (a): kill switch scope comes from the registry, not from activity", () => {
  test("KILL: a dept lead stops a registered workflow of their department that has never run (201, then clears it)", async () => {
    const fresh = crypto.randomUUID();
    await roleWorkflow(w.h, w.t, fresh, w.t.jobRoles.sdr, w.t.departments.sales);
    const lead = await client(w, "lead");
    const r = await lead.post("/v1/kill-switches", { scope: "workflow", targetId: fresh, reason: "stop before it starts" });
    expect(r.status).toBe(201);
    expect((await lead.del(`/v1/kill-switches/workflow/${fresh}`)).status).toBe(200);
  });

  test("KILL: a dept lead stops a workflow proposed in their department (no job role yet)", async () => {
    const fresh = crypto.randomUUID();
    await db()`insert into workflows (tenant_id, id, name, state, proposed_by, proposer_department_id, local_workflow_id, proposal_hash,
        proposal_definition, proposed_at_ms, created_at_ms)
      values (${w.t.id}, ${fresh}, 'Proposed outreach', 'proposed', ${w.t.people.member.id}, ${w.t.departments.sales}, ${`local-${fresh}`},
        ${"b".repeat(64)}, '{}'::jsonb, 0, 0)`;
    const r = await (await client(w, "lead")).post("/v1/kill-switches", { scope: "workflow", targetId: fresh, reason: "stop" });
    expect(r.status).toBe(201);
  });

  test("RBAC: a dept lead still cannot stop another department's workflow (404)", async () => {
    const r = await (await client(w, "lead")).post("/v1/kill-switches", { scope: "workflow", targetId: WF_AP, reason: "not mine" });
    expect(r.status).toBe(404);
  });
});

// The night helpers: every instant belongs to exactly the night whose start (local noon) is the last one at or before it.
const nightStart = (evaluate as unknown as { nightStart?: (night: string, tz: string) => number }).nightStart;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);

describe("S2-07 round 6 (b): one night boundary, DST-proof", () => {
  const cases: Array<[string, string, number]> = [
    ["America/Toronto spring-forward", "America/Toronto", Date.UTC(2026, 2, 8, 0, 0)],
    ["America/Toronto fall-back", "America/Toronto", Date.UTC(2026, 10, 1, 0, 0)],
    ["Asia/Kolkata (+5:30)", "Asia/Kolkata", Date.UTC(2026, 9, 26, 0, 0)],
  ];
  for (const [name, tz, around] of cases) {
    test(`OVERNIGHT: ${name}: nightOf and nightStart agree on every quarter hour of three days`, () => {
      expect(typeof nightStart).toBe("function");
      for (let t = around - 36 * HOUR; t <= around + 36 * HOUR; t += QUARTER) {
        const night = evaluate.nightOf(t, tz);
        expect(nightStart!(night, tz)).toBeLessThanOrEqual(t);
        expect(nightStart!(nextDay(night), tz)).toBeGreaterThan(t);
        // A night starts at local noon of its date.
        const p = evaluate.localParts(nightStart!(night, tz), tz);
        expect([p.day, p.hour, p.minute]).toEqual([night, 12, 0]);
      }
    });
  }

  /** A preapproved policy, cap 1 a night, window always open, the tenant reporting in Toronto. */
  async function capOne(recipients: string[]) {
    await db()`update tenants set reporting_timezone = 'America/Toronto' where id = ${w.t.id}`;
    return overnightPolicy(w, {
      maxCommitsPerNight: 1,
      sendWindow: { startHour: 0, endHour: 24, days: [1, 2, 3, 4, 5, 6, 7], recipientTimezone: false },
      recipients: { emails: recipients, domains: [], repliesToThreadsStartedByIdentity: false },
    });
  }
  const sendAt = async (pid: string, t: number, to: string) => {
    w.h.clock.t = t;
    const calls = w.composio.calls.length;
    const r = await propose(w, [email(to)], overnightRun(pid));
    if (!r.ok) throw new Error(JSON.stringify(r));
    await w.broker.idle();
    return w.composio.calls.length - calls;
  };

  test("OVERNIGHT: fall-back morning (Toronto, 1 Nov 2026): the hour before noon is still last night, its cap holds", async () => {
    const pid = await capOne(["fb1@fund.com", "fb2@fund.com"]);
    // 10:30 EST and 11:30 EST on 1 Nov: both belong to the night of 31 Oct (it ends at local noon).
    expect(await sendAt(pid, Date.UTC(2026, 10, 1, 15, 30), "fb1@fund.com")).toBe(1);
    expect(await sendAt(pid, Date.UTC(2026, 10, 1, 16, 30), "fb2@fund.com")).toBe(0);
  });

  test("OVERNIGHT: spring-forward afternoon (Toronto, 8 Mar 2026): 12:30 EDT is a new night with its own cap", async () => {
    const pid = await capOne(["sf1@fund.com", "sf2@fund.com"]);
    // 20:00 EST on 7 Mar (night of 7 Mar) uses the cap; 12:30 EDT on 8 Mar is past local noon: the night of 8 Mar.
    expect(await sendAt(pid, Date.UTC(2026, 2, 8, 1, 0), "sf1@fund.com")).toBe(1);
    expect(await sendAt(pid, Date.UTC(2026, 2, 8, 16, 30), "sf2@fund.com")).toBe(1);
  });
});
