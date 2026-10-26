// PR #9 round 6 (review of 7956e50).
// - The oracle again, with H running a workflow others run too (WF1). A department's top workflows must depend only on
//   its own inputs: Ops lost WF1 when a Finance person started it, because the workflow tree spanned every department.
//   It also covers person-scope reads, a lead reading another department, and the company adoption and working-time
//   reads (which contain H, so only H's own count may move there).
// - Evidence shows a baseline (samples, stats, run baselines) only when at least floor people sent samples for it.
// - Anomalies are filtered before the 100-entry cap, so dropped residual_zero_share entries cannot push others out.
// - Adoption is suppressed whole when the residual median lacks contributors (no fabricated 0).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import {
  WF1, WF2, addDevice, asPerson, addPerson, at, baselineSample, dailyAggregate, populate, receipt, reviewEvent, runOutcome, sendObjects,
  setup, workingTime, type Dev, type S205,
} from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";
const WF3 = "0a000000-0000-4000-8000-000000000003";
const WF4 = "0a000000-0000-4000-8000-000000000004";
const SUPPRESSED = { suppressed: true, reason: "group_floor" };
type Snap = Record<string, { status: number; body: Record<string, unknown> }>;

/** A person with an acknowledged device and nothing sent. */
async function person(s: S205, departmentId: string | null): Promise<{ personId: string; dev: Dev }> {
  const personId = await addPerson(s.h, s.h.a, { departmentId });
  s.fc.acked.add(personId);
  s.fc.workingTime.add(personId);
  return { personId, dev: await addDevice(s.h, s.h.a, personId) };
}

describe("FLOOR one more person in a suppressed group, running a shared workflow, changes nothing a reader can see", () => {
  let s: S205;
  let owner: Client;
  let lead: Client;
  let ops: string;
  let legal: string;
  let ae: string;
  let salesPerson: string;
  let opsPerson: string;
  let h: Dev;
  const before: Snap = {};
  const after: Snap = {};

  function reads(): Array<[string, Client, string]> {
    const t = s.h.a;
    const out: Array<[string, Client, string]> = [];
    const groups = [`department:${t.departments.sales}`, `department:${ops}`, `department:${legal}`, `department:${t.departments.finance}`,
      `job_role:${t.jobRoles.sdr}`, `job_role:${ae}`, `job_role:${t.jobRoles.ap}`];
    for (const g of groups) {
      out.push([`hours ${g}`, owner, `/v1/metrics/hours-saved?scope=${g}&${Q}`]);
      out.push([`adoption ${g}`, owner, `/v1/metrics/adoption?scope=${g}&${Q}`]);
    }
    for (const g of groups.slice(0, 4)) out.push([`working-time ${g}`, owner, `/v1/metrics/working-time?scope=${g}&${Q}`]);
    for (const p of [salesPerson, opsPerson]) {
      out.push([`hours person ${p}`, owner, `/v1/metrics/hours-saved?scope=person:${p}&${Q}`]);
      out.push([`working-time person ${p}`, owner, `/v1/metrics/working-time?scope=person:${p}&${Q}`]);
    }
    out.push(["hours lead Sales", lead, `/v1/metrics/hours-saved?scope=department:${t.departments.sales}&${Q}`]);
    out.push(["hours lead Ops", lead, `/v1/metrics/hours-saved?scope=department:${ops}&${Q}`]);
    out.push(["adoption lead Ops", lead, `/v1/metrics/adoption?scope=department:${ops}&${Q}`]);
    // The owner's evidence is company-wide, so it lists H's WF1 runs (runs in scope are listed, ADR 0109 §7); WF2 (H
    // alone) and WF3 (H never ran it) must not move.
    for (const wf of [WF2, WF3]) out.push([`evidence owner ${wf}`, owner, `/v1/metrics/hours-saved/evidence?workflowId=${wf}&version=1&${Q}`]);
    for (const wf of [WF1, WF2, WF3]) out.push([`evidence lead ${wf}`, lead, `/v1/metrics/hours-saved/evidence?workflowId=${wf}&version=1&${Q}`]);
    return out;
  }
  const company: Array<[string, string]> = [
    ["hours", `/v1/metrics/hours-saved?scope=company&${Q}`],
    ["adoption", `/v1/metrics/adoption?scope=company&${Q}`],
    ["working-time", `/v1/metrics/working-time?scope=company&${Q}`],
  ];

  async function take(into: Snap) {
    for (const [name, who, path] of reads()) {
      const r = await who.get(path);
      into[name] = { status: r.status, body: r.json };
    }
    for (const [name, path] of company) {
      const r = await owner.get(path);
      into[`company ${name}`] = { status: r.status, body: r.json };
    }
  }

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    const db = s.h.db.migrator;
    s.fc.features.set("CA-ON", ["working_time", "per_person_views"]);
    ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
    legal = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Legal') returning id`)[0]!.id as string;
    ae = (await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, 'AE', ${t.departments.sales}) returning id`)[0]!.id as string;
    // WF1: Sales 10, Ops 6, Finance 0. Legal (5, the complementary cell for Finance) and Finance (2) run WF3.
    const groups = [
      { departmentId: t.departments.sales, size: 5, jobRoleId: t.jobRoles.sdr },
      { departmentId: t.departments.sales, size: 5, jobRoleId: ae },
      { departmentId: ops, size: 6 },
      { departmentId: legal, size: 5, workflowId: WF3 },
      { departmentId: t.departments.finance, size: 2, jobRoleId: t.jobRoles.ap, workflowId: WF3 },
    ];
    let i = 0;
    for (const g of groups) {
      for (const p of await populate(s, t, g)) {
        s.fc.workingTime.add(p.personId);
        receipt(await sendObjects(s.h, p.dev, [dailyAggregate(), workingTime("2026-10-20", 300 + 10 * i++)]));
        if (g.departmentId === t.departments.sales) salesPerson = p.personId;
        if (g.departmentId === ops) opsPerson = p.personId;
      }
    }
    h = (await person(s, t.departments.finance)).dev;
    owner = await asPrincipal(s.h, "owner");
    lead = await asPrincipal(s.h, "lead");
    await take(before);
    // H: WF1 (shared with Sales and Ops) and WF2 (H's alone), reviewed with residual 0, a daily aggregate, working time.
    const objs: unknown[] = [];
    for (const [k, wf] of [WF1, WF1, WF2].entries()) {
      const run = runOutcome({ workflowId: wf, endedAt: at("2026-10-21", 9 + k), sent: 2 });
      objs.push(run, reviewEvent(run.runId, { review: 0, edit: 0, fix: 0, at: at("2026-10-21", 14 + k) }));
    }
    objs.push(dailyAggregate("2026-10-21"), workingTime("2026-10-21", 777));
    const r = receipt(await sendObjects(s.h, h, objs));
    if (Object.keys(r.rejected).length > 0) throw new Error(`H rejected ${JSON.stringify(r.rejected)}`);
    await take(after);
  }, 120_000);
  afterAll(() => s.close());

  test("FLOOR: the fixture is what it claims (Ops and Sales list WF1, Finance is suppressed, Legal is its complement)", () => {
    const top = (n: string) => (before[n]!.body.topWorkflows as Array<{ workflowId: string }>).map((w) => w.workflowId);
    expect(top(`hours department:${ops}`)).toContain(WF1);
    expect(top(`hours department:${s.h.a.departments.sales}`)).toContain(WF1);
    expect(before[`hours department:${s.h.a.departments.finance}`]!.body.total).toEqual(SUPPRESSED);
    expect(before[`hours department:${legal}`]!.body.total).toEqual(SUPPRESSED);
    expect(before["hours lead Ops"]!.status).toBe(404);
  });

  test("FLOOR: every read whose cell does not contain H, or hides it, is identical (person reads and a lead's 404 included)", () => {
    const diff = reads().map(([n]) => n).filter((n) => JSON.stringify(before[n]) !== JSON.stringify(after[n]));
    expect(diff).toEqual([]);
  });

  test("FLOOR: the company reads move only where H is counted: no child, anomaly or other workflow changes", () => {
    const b = before["company hours"]!.body, a = after["company hours"]!.body;
    expect(a.children).toEqual(b.children);
    expect(a.anomalies).toEqual(b.anomalies);
    const others = (x: Record<string, unknown>) => (x.topWorkflows as Array<{ workflowId: string }>).filter((w) => w.workflowId !== WF1);
    expect(others(a)).toEqual(others(b));
    const ad = (x: Snap) => x["company adoption"]!.body.value as { peopleWithActiveWorkflow: number };
    expect(ad(after).peopleWithActiveWorkflow).toBe(ad(before).peopleWithActiveWorkflow + 1);
    const wt = (x: Snap) => x["company working-time"]!.body.value as { people: number };
    expect(wt(after).people).toBe(wt(before).people + 1);
  });

  test("FLOOR: the company never lists WF1 with seconds the listed departments do not account for", () => {
    for (const snap of [before, after]) {
      const top = (n: string) => (snap[n]!.body.topWorkflows as Array<{ workflowId: string; seconds: number }>).find((w) => w.workflowId === WF1);
      const c = top("company hours");
      if (!c) continue;
      const depts = [`hours department:${s.h.a.departments.sales}`, `hours department:${ops}`, `hours department:${legal}`, `hours department:${s.h.a.departments.finance}`];
      const listed = depts.reduce((n, d) => n + (top(d)?.seconds ?? 0), 0);
      // What is left is the WF1 seconds of people in no listed department: 0, or never 1 to floor-1 people (here H).
      expect(c.seconds - listed).toBe(0);
    }
  });
});

describe("EVIDENCE raw baseline samples need floor senders", () => {
  let s: S205;
  let lead: Client;

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    // 5 Sales people run WF4 without sending samples; one Finance person sent WF4's only baseline.
    const fin = await person(s, t.departments.finance);
    receipt(await sendObjects(s.h, fin.dev, [baselineSample([400, 410, 420, 430, 440], { workflowId: WF4 })]));
    for (let i = 0; i < 5; i++) {
      const p = await person(s, t.departments.sales);
      const run = runOutcome({ workflowId: WF4, endedAt: at("2026-10-20", 9 + i) });
      receipt(await sendObjects(s.h, p.dev, [run, reviewEvent(run.runId)]));
    }
    lead = await asPrincipal(s.h, "lead");
  }, 60_000);
  afterAll(() => s.close());

  test("EVIDENCE: with fewer than floor baseline senders nothing of the baseline shows: no samples, no stats, no run baselines", async () => {
    // One sender's median is their own timing, and every listed run carries it as baselineSeconds (round 7).
    const r = await lead.get(`/v1/metrics/hours-saved/evidence?workflowId=${WF4}&version=1&${Q}`);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("group_floor");
    expect(JSON.stringify(r.json)).not.toContain("420");
  });

  test("EVIDENCE: the sender reads their own runs' evidence (member scope) whatever the count", async () => {
    const t = s.h.a;
    const solo = await person(s, t.departments.finance);
    receipt(await sendObjects(s.h, solo.dev, [baselineSample([500, 510, 520], { workflowId: WF3 })]));
    const run = runOutcome({ workflowId: WF3, endedAt: at("2026-10-22", 9) });
    receipt(await sendObjects(s.h, solo.dev, [run, reviewEvent(run.runId)]));
    const me = await asPerson(s.h, t, solo.personId);
    const r = await me.get(`/v1/metrics/hours-saved/evidence?workflowId=${WF3}&version=1&${Q}`);
    expect(r.status).toBe(200);
    expect(r.json.runs.length).toBe(1);
  });
});

describe("FLOOR anomalies are filtered before the 100-entry cap", () => {
  let s: S205;
  let owner: Client;

  beforeAll(async () => {
    s = await setup();
    // 9 people, each with one reviewed run (residual 0) a month for 12 months, of a workflow with no baseline: 108
    // residual_zero_share entries (never shown in a group view) that sort before WF2's small_baseline.
    for (let i = 0; i < 9; i++) {
      const p = await person(s, s.h.a.departments.sales);
      const objs: unknown[] = [];
      for (let m = 0; m < 12; m++) {
        const y = m < 2 ? 2025 : 2026;
        const mm = String(m < 2 ? 11 + m : m - 1).padStart(2, "0");
        const run = runOutcome({ workflowId: WF2, endedAt: at(`${y}-${mm}-15`, 9 + i) });
        objs.push(run, reviewEvent(run.runId, { review: 0, edit: 0, fix: 0, at: at(`${y}-${mm}-15`, 20) }));
      }
      receipt(await sendObjects(s.h, p.dev, objs));
    }
    owner = await asPrincipal(s.h, "owner");
  }, 60_000);
  afterAll(() => s.close());

  test("FLOOR: a small_baseline anomaly of a workflow 9 people ran is listed even behind 108 hidden entries", async () => {
    const r = await owner.get("/v1/metrics/hours-saved?scope=company&from=2025-11-01&to=2026-11-01");
    expect(r.status).toBe(200);
    expect(r.json.total.people).toBe(9);
    expect((r.json.anomalies as Array<{ code: string; workflowId: string }>).map((a) => `${a.code} ${a.workflowId}`)).toEqual([`small_baseline ${WF2}`]);
  });
});

describe("FLOOR adoption is suppressed whole when the residual median lacks contributors", () => {
  let s: S205;
  let owner: Client;

  beforeAll(async () => {
    s = await setup();
    // 5 people with runs, one of them reviewed.
    for (let i = 0; i < 5; i++) {
      const p = await person(s, s.h.a.departments.sales);
      const run = runOutcome({ endedAt: at("2026-10-20", 9 + i) });
      receipt(await sendObjects(s.h, p.dev, i === 0 ? [run, reviewEvent(run.runId)] : [run]));
    }
    owner = await asPrincipal(s.h, "owner");
  }, 60_000);
  afterAll(() => s.close());

  test("FLOOR: company adoption with fewer than floor people with a reviewed success is fully suppressed, never a made-up 0", async () => {
    // The schema has no per-field marker, and a 0 median would read as a measurement (ADR 0005), so the whole cell goes.
    const r = await owner.get(`/v1/metrics/adoption?scope=company&${Q}`);
    expect(r.status).toBe(200);
    expect(r.json.value).toEqual(SUPPRESSED);
  });
});

describe("FLOOR a job role listing a workflow its department does not list leaves no residue at the company", () => {
  let s: S205;
  let owner: Client;
  let ops: string;
  let legal: string;
  const roles: string[] = [];

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    const db = s.h.db.migrator;
    ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
    legal = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Legal') returning id`)[0]!.id as string;
    for (const n of ["R1", "R2", "R3"]) {
      roles.push((await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, ${n}, ${legal}) returning id`)[0]!.id as string);
    }
    // WF1: Sales 5, Ops 5, Legal 8 (R3 6, R1 1, R2 1). R1 and R2 have 3 people each (visible together in Legal's tree),
    // so R3 is shown; Legal does not list WF1 (2 people outside R3), but R3 does. Finance 5 on WF3 keeps every
    // department visible.
    await populate(s, t, { departmentId: t.departments.sales, size: 5 });
    await populate(s, t, { departmentId: ops, size: 5 });
    await populate(s, t, { departmentId: t.departments.finance, size: 5, workflowId: WF3 });
    await populate(s, t, { departmentId: legal, size: 6, jobRoleId: roles[2]! });
    for (const r of [roles[0]!, roles[1]!]) {
      await populate(s, t, { departmentId: legal, size: 1, jobRoleId: r });
      await populate(s, t, { departmentId: legal, size: 2, jobRoleId: r, workflowId: WF3 });
    }
    owner = await asPrincipal(s.h, "owner");
  }, 120_000);
  afterAll(() => s.close());

  const wf1 = async (scope: string) =>
    ((await owner.get(`/v1/metrics/hours-saved?scope=${scope}&${Q}`)).json.topWorkflows as Array<{ workflowId: string; seconds: number }>)
      .find((w) => w.workflowId === WF1);

  test("FLOOR: Legal does not list WF1 while its role R3 does (the shape under test)", async () => {
    expect(await wf1(`department:${legal}`)).toBeUndefined();
    expect(await wf1(`job_role:${roles[2]}`)).toBeDefined();
  });

  test("FLOOR: company WF1 minus every listed department and every listed role of an unlisted department is 0, or the company does not list it", async () => {
    const c = await wf1("company");
    if (!c) return;
    let listed = 0;
    for (const d of [s.h.a.departments.sales, ops, s.h.a.departments.finance]) listed += (await wf1(`department:${d}`))?.seconds ?? 0;
    for (const r of roles) listed += (await wf1(`job_role:${r}`))?.seconds ?? 0;
    expect(c.seconds - listed).toBe(0);
  });
});
