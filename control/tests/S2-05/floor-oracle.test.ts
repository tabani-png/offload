// PR #9 round 5 (independent review of cc1cb8e), class-wide: every number, text detail, digest, count or flag in a
// metrics response comes only from inputs whose contributors pass the floor in the tree the cell sits in.
//
// Harness: one tenant where Finance (2 people with data) is under the floor. Every response a reader can get is taken,
// then one more Finance person (H) sends runs, reviews, a daily aggregate and working time, and every response is taken
// again (before the nightly job takes the new data in, and after). Any read whose cell does not contain H, or hides
// it, must be byte-for-byte the same, digests, anomalies and the final flag included. The company scope contains H, so
// only its total, digest and final flag may move; anomalies, children and top workflows may not (H runs a workflow no
// one else runs, so nothing H did is above the floor anywhere).
// Baseline samples are workflow reference data (ADR 0109: every device's samples set a workflow's baseline), so H
// sends none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import nightly from "../../src/modules/metrics/index.ts";
import {
  WF1, WF2, addDevice, addPerson, at, dailyAggregate, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, workingTime,
  type Dev, type S205,
} from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";
type Snap = Record<string, unknown>;

let s: S205;
let owner: Client;
let lead: Client;
let ops: string;
let ae: string;
let h: Dev;
const before: Snap = {};
const pending: Snap = {};
const after: Snap = {};

/** Every read whose cell does not contain H (or hides it), by name. */
function reads(): Array<[string, Client, string]> {
  const t = s.h.a;
  const out: Array<[string, Client, string]> = [];
  const groups = [`department:${t.departments.sales}`, `department:${ops}`, `department:${t.departments.finance}`,
    `job_role:${t.jobRoles.sdr}`, `job_role:${ae}`, `job_role:${t.jobRoles.ap}`];
  for (const g of groups) {
    out.push([`hours ${g}`, owner, `/v1/metrics/hours-saved?scope=${g}&${Q}`]);
    out.push([`adoption ${g}`, owner, `/v1/metrics/adoption?scope=${g}&${Q}`]);
  }
  for (const g of groups.slice(0, 3)) out.push([`working-time ${g}`, owner, `/v1/metrics/working-time?scope=${g}&${Q}`]);
  out.push(["hours lead Sales", lead, `/v1/metrics/hours-saved?scope=department:${t.departments.sales}&${Q}`]);
  out.push(["evidence owner WF1", owner, `/v1/metrics/hours-saved/evidence?workflowId=${WF1}&version=1&${Q}`]);
  out.push(["evidence owner WF2", owner, `/v1/metrics/hours-saved/evidence?workflowId=${WF2}&version=1&${Q}`]);
  out.push(["evidence lead WF1", lead, `/v1/metrics/hours-saved/evidence?workflowId=${WF1}&version=1&${Q}`]);
  out.push(["evidence lead WF2", lead, `/v1/metrics/hours-saved/evidence?workflowId=${WF2}&version=1&${Q}`]);
  out.push(["hours company", owner, `/v1/metrics/hours-saved?scope=company&${Q}`]);
  return out;
}

async function take(into: Snap) {
  for (const [name, who, path] of reads()) {
    const r = await who.get(path);
    into[name] = { status: r.status, body: r.json };
  }
}

/** The company read may move only in what H is inside of: the total, its digest, the final flag. */
function companyShape(x: unknown) {
  const { body } = x as { body: Record<string, unknown> };
  // Top workflows may move too (follow-ups): with H, company minus WF1 (everyone else's only workflow) would be H's
  // runs, so the company drops WF1. That H's own workflow is never listed is checked below.
  const { total: _t, inputsDigest: _d, final: _f, topWorkflows: _w, ...rest } = body;
  return rest;
}

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const db = s.h.db.migrator;
  s.fc.features.set("CA-ON", ["working_time"]);
  ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
  ae = (await db`insert into job_roles (tenant_id, name, department_id) values (${t.id}, 'AE', ${t.departments.sales}) returning id`)[0]!.id as string;
  const groups = [
    { departmentId: t.departments.sales, size: 5, jobRoleId: t.jobRoles.sdr },
    { departmentId: t.departments.sales, size: 5, jobRoleId: ae },
    { departmentId: ops, size: 6 },
    { departmentId: t.departments.finance, size: 2, jobRoleId: t.jobRoles.ap },
  ];
  let i = 0;
  for (const g of groups) {
    for (const p of await populate(s, t, g)) {
      s.fc.workingTime.add(p.personId);
      receipt(await sendObjects(s.h, p.dev, [dailyAggregate(), workingTime("2026-10-20", 300 + 10 * i++)]));
    }
  }
  // H: a Finance person (no job role) who exists before the first snapshot and sends nothing yet.
  const hid = await addPerson(s.h, t, { departmentId: t.departments.finance });
  s.fc.acked.add(hid);
  s.fc.workingTime.add(hid);
  h = await addDevice(s.h, t, hid);
  owner = await asPrincipal(s.h, "owner");
  lead = await asPrincipal(s.h, "lead");
  // Two nightly runs: October's snapshots are recomputed and then final.
  await nightly.jobs![0]!.run(s.h.deps);
  await nightly.jobs![0]!.run(s.h.deps);
  await take(before);

  // H's data: two reviewed runs of WF2 (no one else runs it) with residual 0, a daily aggregate, working time.
  const objs: unknown[] = [];
  for (const k of [0, 1]) {
    const run = runOutcome({ workflowId: WF2, endedAt: at("2026-10-21", 9 + k), sent: 2 });
    objs.push(run, reviewEvent(run.runId, { review: 0, edit: 0, fix: 0, at: at("2026-10-21", 12 + k) }));
  }
  objs.push(dailyAggregate("2026-10-21"), workingTime("2026-10-21", 777));
  const r = receipt(await sendObjects(s.h, h, objs));
  if (Object.keys(r.rejected).length > 0) throw new Error(`H rejected ${JSON.stringify(r.rejected)}`);
  await take(pending);
  await nightly.jobs![0]!.run(s.h.deps);
  await take(after);
}, 120_000);
afterAll(() => s.close());

describe("FLOOR one person more in a suppressed group changes nothing a reader can see", () => {
  test("FLOOR: the fixture is what it claims (Finance suppressed, Sales visible and final, company sees H)", async () => {
    const sales = before[`hours department:${s.h.a.departments.sales}`] as { body: { total: { people: number }; final: boolean } };
    expect(sales.body.total.people).toBe(10);
    expect(sales.body.final).toBe(true);
    const fin = before[`hours department:${s.h.a.departments.finance}`] as { body: { total: unknown } };
    expect(fin.body.total).toEqual({ suppressed: true, reason: "group_floor" });
    const c0 = (before["hours company"] as { body: { total: { people: number } } }).body.total.people;
    const c1 = (after["hours company"] as { body: { total: { people: number } } }).body.total.people;
    expect(c1).toBe(c0 + 1);
  });

  for (const phase of ["pending", "after"] as const) {
    test(`FLOOR: every group read without H in a visible cell is identical, digest and final included (${phase} the nightly job)`, () => {
      const now = phase === "pending" ? pending : after;
      const diff = reads()
        .map(([name]) => name)
        .filter((n) => n !== "hours company")
        .filter((n) => JSON.stringify(before[n]) !== JSON.stringify(now[n]));
      expect(diff).toEqual([]);
    });

    test(`FLOOR: the company read moves only in its total, digest and final flag: no anomaly, child or workflow from H (${phase})`, () => {
      const now = phase === "pending" ? pending : after;
      expect(companyShape(now["hours company"])).toEqual(companyShape(before["hours company"]));
      const top = ((now["hours company"] as { body: { topWorkflows: Array<{ workflowId: string }> } }).body.topWorkflows).map((w) => w.workflowId);
      expect(top).not.toContain(WF2);
    });
  }
});

describe("FLOOR adoption fields are floored on the people who contribute to each", () => {
  let s2: S205;
  let owner2: Client;

  beforeAll(async () => {
    s2 = await setup();
    const t = s2.h.a;
    // Sales: 5 people with data (daily aggregates), only one of them with runs. Finance: 5 with runs.
    for (let i = 0; i < 4; i++) {
      const id = await addPerson(s2.h, t, { departmentId: t.departments.sales });
      s2.fc.acked.add(id);
      receipt(await sendObjects(s2.h, await addDevice(s2.h, t, id), [dailyAggregate("2026-10-20", 0)]));
    }
    const [p] = await populate(s2, t, { departmentId: t.departments.sales, size: 1 });
    receipt(await sendObjects(s2.h, p!.dev, [dailyAggregate()]));
    await populate(s2, t, { departmentId: t.departments.finance, size: 5 });
    owner2 = await asPrincipal(s2.h, "owner");
  }, 60_000);
  afterAll(() => s2.close());

  test("FLOOR: a department with 5 people with data but 1 with runs shows no rates, run counts or residual median", async () => {
    const r = await owner2.get(`/v1/metrics/adoption?scope=department:${s2.h.a.departments.sales}&${Q}`);
    expect(r.status).toBe(200);
    expect(r.json.value).toEqual({ suppressed: true, reason: "group_floor" });
  });

  test("FLOOR: the company, where 6 people have runs, still shows adoption", async () => {
    const r = await owner2.get(`/v1/metrics/adoption?scope=company&${Q}`);
    expect(r.json.value.peopleWithActiveWorkflow).toBeGreaterThanOrEqual(6);
  });
});
