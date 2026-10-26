// PR #9 round 4, class-wide audit of differencing attacks on the group floor. Each test subtracts what the API shows
// with numbers from what it shows above it, and checks the remainder is never 1 to floor-1 people:
// - people with no department (or, in a department, no job role there) are in the parent total but in no child;
// - several small or empty children hide nothing when their sum is under the floor (an empty department is "under
//   the floor" for hs-1's suppress(), so it used to stand in for the complementary cell);
// - a job role read directly counts holders in other departments, which no department tree floors;
// - top workflows of a department minus those of the company give one workflow's seconds for the people outside it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { WF2, at, baselineSample, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, workingTime, type S205 } from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";
const SUPPRESSED = { suppressed: true, reason: "group_floor" };
type Child = { scope: { id: string }; value: { people: number } | { suppressed: true } };

const safe = (left: number) => left === 0 || left >= 5;

/** Parent total minus every child readable with numbers (listed in the parent, else read directly). */
async function hoursLeft(owner: Client, parent: string, childType: string, childIds: string[]): Promise<number> {
  const r = await owner.get(`/v1/metrics/hours-saved?scope=${parent}&${Q}`);
  expect(r.status).toBe(200);
  const listed = new Map((r.json.children as Child[]).map((c) => [c.scope.id, c.value]));
  let visible = 0;
  for (const id of childIds) {
    const direct = (await owner.get(`/v1/metrics/hours-saved?scope=${childType}:${id}&${Q}`)).json.total;
    const v = listed.get(id) ?? direct;
    // A child the parent hides must stay hidden when read directly.
    if (listed.has(id) && "suppressed" in v) expect(direct).toEqual(SUPPRESSED);
    if (!("suppressed" in v)) visible += v.people;
  }
  return (r.json.total as { people: number }).people - visible;
}

describe("FLOOR people in no department (company remainder)", () => {
  let s: S205;
  let owner: Client;
  let depts: string[];

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    s.fc.features.set("CA-ON", ["working_time"]);
    depts = [t.departments.sales, t.departments.finance];
    const groups = [
      { departmentId: t.departments.sales, size: 5 },
      { departmentId: t.departments.finance, size: 6 },
      // Two people with no department: in the company total, in no department.
      { departmentId: null as unknown as string, size: 2 },
    ];
    let i = 0;
    for (const g of groups) {
      for (const p of await populate(s, t, g)) {
        s.fc.workingTime.add(p.personId);
        receipt(await sendObjects(s.h, p.dev, [workingTime("2026-10-20", 300 + 10 * i++)]));
      }
    }
    owner = await asPrincipal(s.h, "owner");
  });
  afterAll(() => s.close());

  test("FLOOR: hours saved, company minus every readable department never gives the 2 people with no department", async () => {
    const r = await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`);
    expect(r.json.total.people).toBe(13);
    expect(safe(await hoursLeft(owner, "company", "department", depts))).toBe(true);
  });

  test("FLOOR: adoption, company minus every readable department never gives the 2 people with no department", async () => {
    const company = (await owner.get(`/v1/metrics/adoption?scope=company&${Q}`)).json.value;
    expect(company.peopleWithActiveWorkflow).toBe(13);
    let visible = 0;
    for (const d of depts) {
      const v = (await owner.get(`/v1/metrics/adoption?scope=department:${d}&${Q}`)).json.value;
      if (!("suppressed" in v)) visible += v.peopleWithActiveWorkflow;
    }
    expect(safe(company.peopleWithActiveWorkflow - visible)).toBe(true);
  });

  test("FLOOR: working time, company minus every readable department never gives the 2 people with no department", async () => {
    const company = (await owner.get(`/v1/metrics/working-time?scope=company&${Q}`)).json.value;
    expect(company.people).toBe(13);
    let visible = 0;
    for (const d of depts) {
      const v = (await owner.get(`/v1/metrics/working-time?scope=department:${d}&${Q}`)).json.value;
      if (!("suppressed" in v)) visible += v.people;
    }
    expect(safe(company.people - visible)).toBe(true);
  });
});

describe("FLOOR small and empty children, job roles held elsewhere, top workflows", () => {
  let s: S205;
  let owner: Client;
  let ae: string;
  let ops: string;
  let hr: string;

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    const db = s.h.db.migrator;
    ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
    // HR stays empty.
    hr = (await db`insert into departments (tenant_id, name) values (${t.id}, 'HR') returning id`)[0]!.id as string;
    ae = (await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, 'AE', ${t.departments.sales}) returning id`)[0]!.id as string;
    // Sales 12: 5 SDR, 5 AE, 2 with no job role. Ops 7: 5 hold Sales' AE role, 2 with none. Finance 3.
    await populate(s, t, { departmentId: t.departments.sales, size: 5, jobRoleId: t.jobRoles.sdr });
    const aes = await populate(s, t, { departmentId: t.departments.sales, size: 5, jobRoleId: ae });
    await populate(s, t, { departmentId: t.departments.sales, size: 2 });
    await populate(s, t, { departmentId: ops, size: 5, jobRoleId: ae });
    await populate(s, t, { departmentId: ops, size: 2 });
    const fin = await populate(s, t, { departmentId: t.departments.finance, size: 3 });
    // WF2: the 5 Sales AEs and 1 Finance person. Company WF2 has 6 people, Sales WF2 has 5.
    receipt(await sendObjects(s.h, aes[0]!.dev, [baselineSample([600, 620, 640, 660, 680], { workflowId: WF2 })]));
    for (const p of [...aes, fin[0]!]) {
      const run = runOutcome({ workflowId: WF2, endedAt: at("2026-10-22", 10), sent: 3 });
      receipt(await sendObjects(s.h, p.dev, [run, reviewEvent(run.runId, { review: 30, at: at("2026-10-22", 11) })]));
    }
    owner = await asPrincipal(s.h, "owner");
  });
  afterAll(() => s.close());

  test("FLOOR: company minus every readable department never gives Finance (3) when the other small department is empty", async () => {
    const all = [s.h.a.departments.sales, s.h.a.departments.finance, ops, hr];
    expect(safe(await hoursLeft(owner, "company", "department", all))).toBe(true);
  });

  test("FLOOR: a department minus every readable job role never gives its 2 people with no job role", async () => {
    const company = await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`);
    const sales = (company.json.children as Child[]).find((c) => c.scope.id === s.h.a.departments.sales)!.value;
    // Sales itself has to be visible for the department-level check to mean anything.
    expect(sales).toMatchObject({ people: 12 });
    expect(safe(await hoursLeft(owner, `department:${s.h.a.departments.sales}`, "job_role", [s.h.a.jobRoles.sdr, ae]))).toBe(true);
  });

  test("FLOOR: a job role held by people outside its department is suppressed when read directly (Ops minus AE outside Sales = 2)", async () => {
    const r = await owner.get(`/v1/metrics/hours-saved?scope=job_role:${ae}&${Q}`);
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual(SUPPRESSED);
    expect(r.json.topWorkflows).toEqual([]);
    expect((await owner.get(`/v1/metrics/adoption?scope=job_role:${ae}&${Q}`)).json.value).toEqual(SUPPRESSED);
  });

  test("FLOOR: a workflow is never listed both by the company and by a department when the difference is 1 to floor-1 people", async () => {
    const company = (await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`)).json;
    const sales = (await owner.get(`/v1/metrics/hours-saved?scope=department:${s.h.a.departments.sales}&${Q}`)).json;
    expect(sales.total.people).toBe(12);
    const inCompany = (company.topWorkflows as Array<{ workflowId: string }>).some((w) => w.workflowId === WF2);
    const inSales = (sales.topWorkflows as Array<{ workflowId: string }>).some((w) => w.workflowId === WF2);
    // Company minus Sales would be the Finance person's WF2 seconds, so both may not list it. Since round 6 a department's
    // list depends only on its own inputs: Sales (5 people) keeps WF2 and the company, with 1 person unaccounted, drops it.
    expect(inSales).toBe(true);
    expect(inCompany).toBe(false);
  });
});
