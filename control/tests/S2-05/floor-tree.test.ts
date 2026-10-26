// Review wave B, PR #9 items 1-2: complementary suppression must hold across reads. Reading a department or job role
// directly must not undo what the company report hid, or the hidden cell comes back by subtraction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { populate, receipt, sendObjects, setup, workingTime, type S205 } from "./helpers.ts";

const SUPPRESSED = { suppressed: true, reason: "group_floor" };
const Q = "from=2026-10-01&to=2026-11-01";

let s: S205;
let owner: Client;
let ops: string;
let ae: string;
let analyst: string;
const hs = (scope: string) => owner.get(`/v1/metrics/hours-saved?scope=${scope}&${Q}`);
const adoption = (scope: string) => owner.get(`/v1/metrics/adoption?scope=${scope}&${Q}`);
const wtime = (scope: string) => owner.get(`/v1/metrics/working-time?scope=${scope}&${Q}`);
const child = (r: { json: { children: Array<{ scope: { id: string }; value: unknown }> } }, id: string) =>
  r.json.children.find((c) => c.scope.id === id)!.value;

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const db = s.h.db.migrator;
  ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
  ae = (await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, 'AE', ${t.departments.sales}) returning id`)[0]!.id as string;
  analyst = (await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, 'Ops analyst', ${ops}) returning id`)[0]!.id as string;
  s.fc.features.set("CA-ON", ["working_time"]);
  // A = Sales 10 (5 SDR, 5 AE), B = Finance 4, C = Ops 8 (6 Ops analysts, 2 who hold Sales' SDR role).
  const groups = [
    { departmentId: t.departments.sales, size: 5, jobRoleId: t.jobRoles.sdr },
    { departmentId: t.departments.sales, size: 5, jobRoleId: ae },
    { departmentId: t.departments.finance, size: 4 },
    { departmentId: ops, size: 6, jobRoleId: analyst },
    { departmentId: ops, size: 2, jobRoleId: t.jobRoles.sdr },
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

describe("FLOOR complementary suppression across reads (review wave B #9 items 1-2)", () => {
  test("FLOOR: the company report hides Finance (4) and, complementarily, Ops (8)", async () => {
    const r = await hs("company");
    expect(child(r, s.h.a.departments.finance)).toEqual(SUPPRESSED);
    expect(child(r, ops)).toEqual(SUPPRESSED);
    expect((child(r, s.h.a.departments.sales) as { people: number }).people).toBe(10);
    expect(r.json.total.people).toBe(22);
  });

  test("FLOOR: reading the complementarily hidden department directly is suppressed too, with no numbers", async () => {
    const r = await hs(`department:${ops}`);
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual(SUPPRESSED);
    expect(r.json.topWorkflows).toEqual([]);
    for (const c of r.json.children) expect(c.value).toEqual(SUPPRESSED);
    expect(JSON.stringify(r.json.children)).not.toContain("seconds");
  });

  test("FLOOR: a job role inside a hidden department is suppressed when read directly", async () => {
    expect((await hs(`job_role:${analyst}`)).json.total).toEqual(SUPPRESSED);
  });

  test("FLOOR: no combination of reads gives Finance's seconds (company minus every visible department cell)", async () => {
    const company = (await hs("company")).json.total.seconds as number;
    const visible: number[] = [];
    for (const id of [s.h.a.departments.sales, s.h.a.departments.finance, ops]) {
      const v = (await hs(`department:${id}`)).json.total;
      if (!("suppressed" in v)) visible.push(v.seconds as number);
    }
    // Only Sales is visible; company minus Sales is Finance and Ops together, never Finance alone.
    expect(visible.length).toBe(1);
    expect(company - visible[0]!).toBeGreaterThan(0);
  });

  test("FLOOR: a job role whose holders outside its department are under the floor is suppressed (SDR minus Sales.SDR = 2 Ops people)", async () => {
    const sales = await hs(`department:${s.h.a.departments.sales}`);
    expect((child(sales, s.h.a.jobRoles.sdr) as { people: number }).people).toBe(5);
    expect((await hs(`job_role:${s.h.a.jobRoles.sdr}`)).json.total).toEqual(SUPPRESSED);
  });

  test("FLOOR: visible cells keep their numbers (Sales, and the AE role read directly equals Sales.AE)", async () => {
    const sales = await hs(`department:${s.h.a.departments.sales}`);
    expect(sales.json.total.people).toBe(10);
    const direct = await hs(`job_role:${ae}`);
    expect(direct.json.total).toEqual(child(sales, ae));
    expect(direct.json.total.people).toBe(5);
  });

  test("FLOOR: adoption of the complementarily hidden department is suppressed; Sales is not", async () => {
    expect((await adoption(`department:${ops}`)).json.value).toEqual(SUPPRESSED);
    expect((await adoption(`job_role:${analyst}`)).json.value).toEqual(SUPPRESSED);
    expect((await adoption(`job_role:${s.h.a.jobRoles.sdr}`)).json.value).toEqual(SUPPRESSED);
    const sales = await adoption(`department:${s.h.a.departments.sales}`);
    expect(sales.json.value.peopleWithActiveWorkflow).toBe(10);
    expect((await adoption(`job_role:${ae}`)).json.value.peopleWithActiveWorkflow).toBe(5);
  });

  test("FLOOR: working time of the complementarily hidden department is suppressed; Sales is not", async () => {
    expect((await wtime(`department:${ops}`)).json.value).toEqual(SUPPRESSED);
    expect((await wtime(`department:${s.h.a.departments.finance}`)).json.value).toEqual(SUPPRESSED);
    expect((await wtime(`department:${s.h.a.departments.sales}`)).json.value.people).toBe(10);
    expect((await wtime("company")).json.value.people).toBe(22);
  });
});
