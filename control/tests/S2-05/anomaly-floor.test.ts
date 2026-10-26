// Codex re-review, PR #9 round 3 item 1: a group the floor hides must not leak one person's activity through the
// anomaly list ("one person in ...: residual 0 on X of Y", workflow ids of small baselines). That holds for a group
// report() suppresses itself and for one hidden by complementary suppression in the company tree. In visible groups a
// workflow-keyed anomaly is listed only when at least `floor` people in scope ran that workflow, as topWorkflows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { addDevice, addPerson, at, baselineSample, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, WF2, type S205 } from "./helpers.ts";

const SUPPRESSED = { suppressed: true, reason: "group_floor" };
const Q = "from=2026-10-01&to=2026-11-01";
const WF3 = "0a000000-0000-4000-8000-000000000003";

let s: S205;
let owner: Client;
let ops: string;
const hs = (scope: string) => owner.get(`/v1/metrics/hours-saved?scope=${scope}&${Q}`);

/** One person who runs WF2 (baseline n = 1) with every review at 0 seconds: both anomaly kinds fire on them. */
async function loner(departmentId: string) {
  const personId = await addPerson(s.h, s.h.a, { departmentId });
  s.fc.acked.add(personId);
  const dev = await addDevice(s.h, s.h.a, personId);
  const objs: Array<Record<string, unknown>> = [baselineSample([60], { workflowId: WF2 })];
  for (let k = 0; k < 3; k++) {
    const run = runOutcome({ workflowId: WF2, endedAt: at("2026-10-21", 9 + k) });
    objs.push(run, reviewEvent(run.runId, { review: 0, edit: 0, fix: 0 }));
  }
  const r = receipt(await sendObjects(s.h, dev, objs));
  if (Object.keys(r.rejected).length > 0) throw new Error(`loner rejected ${JSON.stringify(r.rejected)}`);
}

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  ops = (await s.h.db.migrator`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
  // Company: Sales 5 (4 + the Sales loner), Finance 1 (the Finance loner), Ops 6 who each run WF3 with no baseline.
  // Finance is under the floor; Sales (5) is the smallest other child, so it is hidden complementarily.
  await populate(s, t, { departmentId: t.departments.sales, size: 4 });
  await loner(t.departments.sales);
  await loner(t.departments.finance);
  for (const p of await populate(s, t, { departmentId: ops, size: 6 })) {
    receipt(await sendObjects(s.h, p.dev, [runOutcome({ workflowId: WF3, endedAt: at("2026-10-22", 10) })]));
  }
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("FLOOR anomalies of hidden groups (PR #9 round 3 item 1)", () => {
  test("FLOOR: a department under the floor (one person) shows no anomalies", async () => {
    const r = await hs(`department:${s.h.a.departments.finance}`);
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual(SUPPRESSED);
    expect(r.json.anomalies).toEqual([]);
    expect(r.json.topWorkflows).toEqual([]);
  });

  test("FLOOR: a department hidden by complementary suppression shows no anomalies", async () => {
    const company = await hs("company");
    expect(company.json.children.find((c: { scope: { id: string } }) => c.scope.id === s.h.a.departments.sales).value).toEqual(SUPPRESSED);
    const r = await hs(`department:${s.h.a.departments.sales}`);
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual(SUPPRESSED);
    expect(r.json.anomalies).toEqual([]);
    expect(JSON.stringify(r.json)).not.toContain(WF2);
  });

  test("FLOOR: in a visible group a workflow-keyed anomaly needs floor people in scope (WF2: 2 people, WF3: 6)", async () => {
    const r = await hs("company");
    expect(r.json.total.people).toBe(12);
    const ids = (r.json.anomalies as Array<{ workflowId: string | null }>).map((a) => a.workflowId);
    expect(ids).not.toContain(WF2);
    expect(ids).toContain(WF3);
    // The person-month anomaly's detail is one person's counts ("residual 0 on 4 of 4"): never in a group view
    // (PR #9 round 5), only in that person's own scope.
    expect((r.json.anomalies as Array<{ code: string }>).some((a) => a.code === "residual_zero_share")).toBe(false);
  });
});
