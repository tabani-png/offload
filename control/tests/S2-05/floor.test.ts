import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { report } from "../../../packages/hours-saved/src/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { goldenReport, type Sender } from "./golden.ts";
import { addPerson, populate, setup, type S205 } from "./helpers.ts";

const SUPPRESSED = { suppressed: true, reason: "group_floor" };
const OCT = { from: "2026-10-01", toExclusive: "2026-11-01" };

let s: S205;
let owner: Client;
let ops: string;
const senders: Sender[] = [];
const hs = (scope: string) => `/v1/metrics/hours-saved?scope=${scope}&from=2026-10-01&to=2026-11-01`;

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const [d] = await s.h.db.migrator`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`;
  ops = d!.id as string;
  // Sales 5, Finance 4, Ops 6 people with data.
  for (const [dept, size] of [[t.departments.sales, 5], [t.departments.finance, 4], [ops, 6]] as const) {
    for (const p of await populate(s, t, { departmentId: dept, size })) senders.push({ personId: p.personId, departmentId: dept, jobRoleId: null, objects: p.objects });
  }
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

const child = (r: { json: { children: Array<{ scope: { id: string }; value: unknown }> } }, id: string) =>
  r.json.children.find((c) => c.scope.id === id)!.value;

describe("FLOOR group floor of 5 people with data, complementary suppression", () => {
  test("FLOOR: a department with 4 people with data is a suppressed cell with no numbers (200, not 422)", async () => {
    const r = await owner.get(hs("company"));
    expect(r.status).toBe(200);
    expect(child(r, s.h.a.departments.finance)).toEqual(SUPPRESSED);
    expect(JSON.stringify(child(r, s.h.a.departments.finance))).not.toContain("seconds");
  });

  test("FLOOR: complementary suppression hides the smallest other child so the total cannot reveal the small one", async () => {
    const r = await owner.get(hs("company"));
    expect(child(r, s.h.a.departments.sales)).toEqual(SUPPRESSED);
    expect((child(r, ops) as { people: number }).people).toBe(6);
    expect(r.json.total.people).toBe(15);
  });

  test("FLOOR: the suppressed tree is exactly hs-1's suppress() on the same rows", async () => {
    const children = [
      { scope: { type: "department" as const, id: s.h.a.departments.finance }, label: "Finance" },
      { scope: { type: "department" as const, id: ops }, label: "Ops" },
      { scope: { type: "department" as const, id: s.h.a.departments.sales }, label: "Sales" },
    ];
    const r = await owner.get(hs("company"));
    expect(r.json).toEqual({ ...report(goldenReport(senders, { type: "company", id: null }, children, { period: OCT })), final: false });
  });

  test("FLOOR: asking for the 4-person department itself gives a suppressed total, no children numbers, no top workflows", async () => {
    const r = await owner.get(hs(`department:${s.h.a.departments.finance}`));
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual(SUPPRESSED);
    expect(r.json.topWorkflows).toEqual([]);
    for (const c of r.json.children) expect(c.value).toEqual(SUPPRESSED);
  });

  test("FLOOR: the floor counts people with data in the period, not headcount", async () => {
    for (let i = 0; i < 3; i++) await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.finance });
    const [n] = await s.h.db.migrator`select count(*)::int as n from people where department_id = ${s.h.a.departments.finance}`;
    expect(n!.n).toBeGreaterThanOrEqual(7);
    expect(child(await owner.get(hs("company")), s.h.a.departments.finance)).toEqual(SUPPRESSED);
    // A period with no data has nobody in it, whatever the headcount.
    const sep = await owner.get("/v1/metrics/hours-saved?scope=company&from=2026-09-01&to=2026-10-01");
    expect(sep.json.total).toEqual(SUPPRESSED);
  });

  test("FLOOR: top workflows list only workflows at least 5 people ran", async () => {
    const r = await owner.get(hs("company"));
    expect(r.json.topWorkflows.length).toBe(1);
    const fin = await owner.get(hs(`department:${ops}`));
    expect(fin.json.topWorkflows.length).toBe(1);
  });

  test("FLOOR: adoption under the floor is suppressed; at the floor it has numbers", async () => {
    const fin = await owner.get(`/v1/metrics/adoption?scope=department:${s.h.a.departments.finance}&from=2026-10-01&to=2026-11-01`);
    expect(fin.status).toBe(200);
    expect(fin.json.value).toEqual(SUPPRESSED);
    const sales = await owner.get(`/v1/metrics/adoption?scope=department:${s.h.a.departments.sales}&from=2026-10-01&to=2026-11-01`);
    expect(sales.json.value.peopleWithActiveWorkflow).toBe(5);
  });

  test("FLOOR: a tenant floor raised to 6 suppresses the 5-person department (configurable upward)", async () => {
    await s.h.db.migrator`update tenants set group_floor = 6 where id = ${s.h.a.id}`;
    const r = await owner.get(hs(`department:${s.h.a.departments.sales}`));
    expect(r.json.total).toEqual(SUPPRESSED);
    expect((await owner.get(hs(`department:${ops}`))).json.total.people).toBe(6);
    await s.h.db.migrator`update tenants set group_floor = 5 where id = ${s.h.a.id}`;
  });
});
