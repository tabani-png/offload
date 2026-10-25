import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildRows, baselinesFor, cellOf, median, selectRows } from "../../../packages/hours-saved/src/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { goldenInputs, type Sender } from "./golden.ts";
import { addDevice, addPerson, dailyAggregate, populate, receipt, sendObjects, setup, workingTime, type S205 } from "./helpers.ts";

const OCT = { from: "2026-10-01", toExclusive: "2026-11-01" };
let s: S205;
let owner: Client;
const senders: Sender[] = [];
const MINUTES = [300, 360, 420, 480, 540, 600];

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const people = await populate(s, t, { departmentId: t.departments.sales, size: 6, runsEach: 2 });
  for (const p of people) senders.push({ personId: p.personId, departmentId: t.departments.sales, jobRoleId: null, objects: p.objects });
  // Working time on in CA-ON: six CA-ON sales people send one day each; one DE person's day must never count.
  s.fc.features.set("CA-ON", ["working_time"]);
  for (const [i, p] of people.entries()) {
    s.fc.workingTime.add(p.personId);
    receipt(await sendObjects(s.h, p.dev, [workingTime("2026-10-20", MINUTES[i]!)]));
  }
  const de = await addPerson(s.h, t, { departmentId: t.departments.sales, jurisdiction: "DE" });
  s.fc.ackAll([de]);
  s.fc.workingTime.add(de);
  s.fc.features.set("DE", ["working_time"]);
  receipt(await sendObjects(s.h, await addDevice(s.h, t, de), [workingTime("2026-10-20", 1)]));
  s.fc.features.delete("DE");
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("ADOPTION and WTIME", () => {
  test("ADOPTION: company adoption is computed from the stored rows with hs-1's run rows", async () => {
    const r = await owner.get("/v1/metrics/adoption?scope=company&from=2026-10-01&to=2026-11-01");
    expect(r.status).toBe(200);
    const g = goldenInputs(senders, { period: OCT });
    const rows = selectRows(buildRows(g.runs, g.reviews, baselinesFor(g.samples, [], g.runs)), { type: "company", id: null }, OCT, "UTC");
    const cell = cellOf(rows);
    const total = Object.values(cell.runs).reduce((a, b) => a + b, 0);
    const residuals = rows.filter((x) => x.outcome === "success" && x.residual !== null).map((x) => x.residual!).sort((a, b) => a - b);
    const [head] = await s.h.db.migrator`select count(*)::int as n from people where tenant_id = ${s.h.a.id} and state in ('active', 'leaving')`;
    expect(r.json).toEqual({
      scope: { type: "company", id: null },
      period: OCT,
      value: {
        peopleWithActiveWorkflow: 6,
        peopleTotal: head!.n,
        workflowsActive: 1,
        runsPerWeek: Math.round((total * 7 * 100) / 31) / 100,
        successRate: 1,
        rejectionRate: 0,
        medianResidualSeconds: median(residuals),
      },
    });
  });

  test("ADOPTION: daily aggregates count people with an active workflow even without runs in the period", async () => {
    const p = await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.finance });
    s.fc.acked.add(p);
    const dev = await addDevice(s.h, s.h.a, p);
    receipt(await sendObjects(s.h, dev, [dailyAggregate("2026-10-05", 1)]));
    const r = await owner.get("/v1/metrics/adoption?scope=company&from=2026-10-01&to=2026-11-01");
    expect(r.json.value.peopleWithActiveWorkflow).toBe(7);
  });

  test("ADOPTION: a dept lead reads own departments only; members are forbidden; person scope is not an adoption scope", async () => {
    const lead = await asPrincipal(s.h, "lead");
    expect((await lead.get(`/v1/metrics/adoption?scope=department:${s.h.a.departments.sales}`)).status).toBe(200);
    expect((await lead.get(`/v1/metrics/adoption?scope=department:${s.h.a.departments.finance}`)).status).toBe(404);
    expect((await (await asPrincipal(s.h, "member")).get("/v1/metrics/adoption?scope=company")).status).toBe(403);
    expect((await owner.get(`/v1/metrics/adoption?scope=person:${s.h.a.people.member.id}`)).status).toBe(400);
    const r = await owner.get("/v1/metrics/adoption?scope=company");
    expect(s.h.deps.validator.validate("offload/stage2/adoption-report.schema.json", r.json)).toEqual({ ok: true });
  });

  test("WTIME: company working time takes median and quartiles over person-days of people whose jurisdiction has it", async () => {
    const r = await owner.get("/v1/metrics/working-time?scope=company&from=2026-10-01&to=2026-11-01");
    expect(r.status).toBe(200);
    // The DE person's 1-minute day is left out: working_time is off in DE now.
    expect(r.json.value).toEqual({ people: 6, medianActiveMinutesPerDay: median(MINUTES), p25: 360, p75: 540 });
    expect(s.h.deps.validator.validate("offload/stage2/working-time-report.schema.json", r.json)).toEqual({ ok: true });
  });

  test("WTIME: fewer than 5 people with working-time data is suppressed; a lead cannot ask for the company", async () => {
    const r = await owner.get("/v1/metrics/working-time?scope=company&from=2026-11-01&to=2026-12-01");
    expect(r.json.value).toEqual({ suppressed: true, reason: "group_floor" });
    const lead = await asPrincipal(s.h, "lead");
    expect((await lead.get("/v1/metrics/working-time?scope=company")).status).toBe(404);
  });

  test("WTIME: turning working_time off for a jurisdiction drops its people from the group view", async () => {
    // Only DE has it now: the one DE person's day is under the floor; the CA-ON days are dropped.
    s.fc.features.set("DE", ["working_time"]);
    s.fc.features.delete("CA-ON");
    const r = await owner.get("/v1/metrics/working-time?scope=company&from=2026-10-01&to=2026-11-01");
    expect(r.json.value).toEqual({ suppressed: true, reason: "group_floor" });
    s.fc.features.set("CA-ON", ["working_time"]);
  });
});
