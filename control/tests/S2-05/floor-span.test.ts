// S2-05 follow-ups (after PR #9). Found by the S2-11 agent on seeded data: company total − Sales − the listed top
// workflow "Invoice matching" = Legal's 4-person hours. Each figure passed the floor alone; listed workflows and listed
// departments combined were never checked. The oracle here takes every hours figure a reader can see (company,
// department and job-role totals, their children, top workflows at each level), as sets of (person, workflow) cells,
// and subtracts every combination of up to four of them from each one: what is left must hold 0 or at least floor
// people.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { WF1, WF2, at, baselineSample, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";
const FLOOR = 5;
const WF3 = "0a000000-0000-4000-8000-000000000003";
const INVOICE = "0a000000-0000-4000-8000-0000000000aa";

interface Who { dept: string; role: string | null; wfs: string[] }
type Cell = { people: number; seconds: number } | { suppressed: true; reason?: string };
type Report = { total: Cell; children: Array<{ scope: { type: string; id: string }; value: Cell }>; topWorkflows: Array<{ workflowId: string }> };

/** Every figure a reader can see in hours reports, as sets of person|workflow cells. */
async function figures(owner: Client, who: Map<string, Who>, depts: string[], roles: string[]): Promise<Array<{ name: string; cells: Set<string> }>> {
  const all = [...who.entries()].flatMap(([p, w]) => w.wfs.map((wf) => ({ p, wf, ...w })));
  const set = (f: (c: (typeof all)[number]) => boolean) => new Set(all.filter(f).map((c) => `${c.p}|${c.wf}`));
  const out: Array<{ name: string; cells: Set<string> }> = [];
  const read = async (scope: string) => (await owner.get(`/v1/metrics/hours-saved?scope=${scope}&${Q}`)).json as Report;
  const add = (r: Report, name: string, inScope: (c: (typeof all)[number]) => boolean) => {
    if ("suppressed" in r.total) return;
    out.push({ name, cells: set(inScope) });
    for (const ch of r.children) {
      if ("suppressed" in ch.value) continue;
      const id = ch.scope.id;
      out.push({ name: `${name}>${id}`, cells: set((c) => inScope(c) && (ch.scope.type === "department" ? c.dept === id : c.role === id)) });
    }
    for (const w of r.topWorkflows) out.push({ name: `${name}.${w.workflowId}`, cells: set((c) => inScope(c) && c.wf === w.workflowId) });
  };
  add(await read("company"), "company", () => true);
  for (const d of depts) add(await read(`department:${d}`), `dept ${d}`, (c) => c.dept === d);
  for (const r of roles) add(await read(`job_role:${r}`), `role ${r}`, (c) => c.role === r);
  return out;
}

/** Each figure minus every combination of up to four others: the people left must be 0 or at least the floor. */
function isolated(figs: Array<{ name: string; cells: Set<string> }>): string[] {
  const bad: string[] = [];
  const pick = (from: number, chosen: number[], base: number) => {
    if (chosen.length > 0) {
      const coef = new Map<string, number>();
      for (const c of figs[base]!.cells) coef.set(c, 1);
      for (const i of chosen) for (const c of figs[i]!.cells) coef.set(c, (coef.get(c) ?? 0) - 1);
      const people = new Set([...coef].filter(([, v]) => v !== 0).map(([c]) => c.split("|")[0]));
      if (people.size > 0 && people.size < FLOOR) bad.push(`${figs[base]!.name} - ${chosen.map((i) => figs[i]!.name).join(" - ")} = ${people.size} people`);
    }
    if (chosen.length === 4) return;
    for (let i = from; i < figs.length; i++) if (i !== base) pick(i + 1, [...chosen, i], base);
  };
  for (let b = 0; b < figs.length; b++) pick(0, [], b);
  return bad;
}

async function group(s: S205, who: Map<string, Who>, o: { dept: string; role?: string; size: number; wfs: string[]; sent?: number }) {
  const people = await populate(s, s.h.a, { departmentId: o.dept, size: o.size, workflowId: o.wfs[0]!, ...(o.role ? { jobRoleId: o.role } : {}) });
  for (const p of people) {
    who.set(p.personId, { dept: o.dept, role: o.role ?? null, wfs: o.wfs });
    const extra = o.wfs.slice(1).flatMap((wf, k) => {
      const run = runOutcome({ workflowId: wf, endedAt: at("2026-10-21", 9 + k), sent: o.sent ?? 3 });
      return [run, reviewEvent(run.runId, { at: at("2026-10-21", 20) })];
    });
    if (extra.length > 0) receipt(await sendObjects(s.h, p.dev, extra));
  }
  return people;
}

describe("FLOOR seeded case: company − Sales − a listed workflow = a hidden department", () => {
  let s: S205;
  let owner: Client;
  let legal: string;
  const who = new Map<string, Who>();

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    legal = (await s.h.db.migrator`insert into departments (tenant_id, name) values (${t.id}, 'Legal') returning id`)[0]!.id as string;
    // Sales 5 on WF1; Finance 5 on invoice matching only (fewer seconds, so it is the cell hidden beside Legal);
    // Legal 4 on WF1, under the floor.
    await group(s, who, { dept: t.departments.sales, size: 5, wfs: [WF1] });
    const fin = await group(s, who, { dept: t.departments.finance, size: 5, wfs: [INVOICE] });
    receipt(await sendObjects(s.h, fin[0]!.dev, [baselineSample([200, 210, 220, 230, 240], { workflowId: INVOICE })]));
    await group(s, who, { dept: legal, size: 4, wfs: [WF1] });
    owner = await asPrincipal(s.h, "owner");
  }, 60_000);
  afterAll(() => s.close());

  test("FLOOR: the shape: Sales listed, Finance and Legal hidden", async () => {
    const r = (await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`)).json as Report;
    const v = (id: string) => r.children.find((c) => c.scope.id === id)!.value;
    expect("suppressed" in v(s.h.a.departments.sales)).toBe(false);
    expect(v(s.h.a.departments.finance)).toEqual({ suppressed: true, reason: "group_floor" });
    expect(v(legal)).toEqual({ suppressed: true, reason: "group_floor" });
  });

  test("FLOOR: no combination of listed department totals and listed workflows isolates Legal", async () => {
    const figs = await figures(owner, who, [s.h.a.departments.sales, s.h.a.departments.finance, legal], [s.h.a.jobRoles.sdr, s.h.a.jobRoles.ap]);
    expect(isolated(figs)).toEqual([]);
  });
});

describe("FLOOR generic oracle: departments, job roles and shared workflows", () => {
  let s: S205;
  let owner: Client;
  let ops: string;
  let legal: string;
  let ae: string;
  const who = new Map<string, Who>();

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    const db = s.h.db.migrator;
    ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
    legal = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Legal') returning id`)[0]!.id as string;
    ae = (await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, 'AE', ${t.departments.sales}) returning id`)[0]!.id as string;
    await group(s, who, { dept: t.departments.sales, role: t.jobRoles.sdr, size: 5, wfs: [WF1, WF2] });
    await group(s, who, { dept: t.departments.sales, role: ae, size: 5, wfs: [WF1] });
    // Ops: 5 on WF1, 1 on WF1 and WF3: Ops total minus Ops' WF1 would be that one person's WF3.
    await group(s, who, { dept: ops, size: 5, wfs: [WF1] });
    await group(s, who, { dept: ops, size: 1, wfs: [WF1, WF3] });
    await group(s, who, { dept: t.departments.finance, role: t.jobRoles.ap, size: 3, wfs: [WF2] });
    await group(s, who, { dept: legal, size: 5, wfs: [WF3] });
    owner = await asPrincipal(s.h, "owner");
  }, 120_000);
  afterAll(() => s.close());

  test("FLOOR: every figure minus any combination of up to four others leaves 0 or at least floor people", async () => {
    const t = s.h.a;
    const figs = await figures(owner, who, [t.departments.sales, ops, t.departments.finance, legal], [t.jobRoles.sdr, ae, t.jobRoles.ap]);
    expect(figs.length).toBeGreaterThan(5);
    expect(isolated(figs)).toEqual([]);
  }, 120_000);
});
