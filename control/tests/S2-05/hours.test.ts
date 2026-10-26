import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { report, reportInputsDigest } from "../../../packages/hours-saved/src/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { goldenReport, type Sender } from "./golden.ts";
import { WF2, at, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

let s: S205;
const senders: Sender[] = [];
let owner: Client;
const OCT = { from: "2026-10-01", toExclusive: "2026-11-01" };
const q = (scope: string, extra = "") => `/v1/metrics/hours-saved?scope=${scope}&from=2026-10-01&to=2026-11-01${extra}`;

/** The company's children as S2-05 lists them: departments by name. */
const deptChildren = () => [
  { scope: { type: "department" as const, id: s.h.a.departments.finance }, label: "Finance" },
  { scope: { type: "department" as const, id: s.h.a.departments.sales }, label: "Sales" },
];

async function track(people: Awaited<ReturnType<typeof populate>>, departmentId: string, jobRoleId: string) {
  for (const p of people) senders.push({ personId: p.personId, departmentId, jobRoleId, objects: p.objects });
}

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  await track(await populate(s, t, { departmentId: t.departments.sales, jobRoleId: t.jobRoles.sdr, size: 5 }), t.departments.sales, t.jobRoles.sdr);
  await track(
    await populate(s, t, { departmentId: t.departments.finance, jobRoleId: t.jobRoles.ap, size: 6, workflowId: WF2, runsEach: 3 }),
    t.departments.finance,
    t.jobRoles.ap,
  );
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("HOURS endpoint = packages/hours-saved on the same rows", () => {
  test("HOURS: company scope equals hs-1 on the same rows (golden, digest included)", async () => {
    const r = await owner.get(q("company"));
    expect(r.status).toBe(200);
    const expected = report(goldenReport(senders, { type: "company", id: null }, deptChildren(), { period: OCT }));
    expect(r.json).toEqual({ ...expected, final: false });
    expect(r.json.total.people).toBe(11);
    expect(r.json.total.seconds).toBeGreaterThan(0);
  });

  test("HOURS: department scope equals hs-1, and its children are the department's job roles", async () => {
    const sales = s.h.a.departments.sales;
    const r = await owner.get(q(`department:${sales}`));
    const children = [{ scope: { type: "job_role" as const, id: s.h.a.jobRoles.sdr }, label: "SDR" }];
    // Below the company the digest covers only the scope's own inputs (PR #9 round 5): the golden of Sales' senders.
    const own = reportInputsDigest(goldenReport(senders.filter((x) => x.departmentId === sales), { type: "department", id: sales }, children, { period: OCT }));
    expect(r.json).toEqual({ ...report(goldenReport(senders, { type: "department", id: sales }, children, { period: OCT })), inputsDigest: own, final: false });
    expect(r.json.children.map((c: { label: string }) => c.label)).toEqual(["SDR"]);
  });

  test("HOURS: job_role scope equals hs-1", async () => {
    const ap = s.h.a.jobRoles.ap;
    const r = await owner.get(q(`job_role:${ap}`));
    const own = reportInputsDigest(goldenReport(senders.filter((x) => x.jobRoleId === ap), { type: "job_role", id: ap }, [], { period: OCT }));
    expect(r.json).toEqual({ ...report(goldenReport(senders, { type: "job_role", id: ap }, [], { period: OCT })), inputsDigest: own, final: false });
    expect(r.json.total.people).toBe(6);
  });

  test("HOURS: the company's visible children add up to its total", async () => {
    const r = await owner.get(q("company"));
    const sum = r.json.children.reduce((a: number, c: { value: { seconds: number } }) => a + c.value.seconds, 0);
    expect(sum).toBe(r.json.total.seconds);
    expect(r.json.total.byGrade.A + r.json.total.byGrade.B + r.json.total.byGrade.C).toBe(r.json.total.seconds);
  });

  test("HOURS: the response matches hours-saved-report.schema.json, hs-1, the tenant's timezone, defaults to this month", async () => {
    const r = await owner.get("/v1/metrics/hours-saved?scope=company");
    expect(r.json.computation).toBe("hs-1");
    expect(r.json.period).toEqual({ from: "2026-10-01", toExclusive: "2026-11-01", timezone: "UTC" });
    expect(s.h.deps.validator.validate("offload/stage2/hours-saved-report.schema.json", r.json)).toEqual({ ok: true });
    expect((await owner.get("/v1/metrics/hours-saved")).json.scope).toEqual({ type: "company", id: null });
  });

  test("HOURS: a review event arriving later turns a not-reviewed run into saved time", async () => {
    const p = senders[0]!;
    const dev = (await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, jobRoleId: s.h.a.jobRoles.sdr, size: 1, runsEach: 0 }))[0]!;
    senders.push({ personId: dev.personId, departmentId: s.h.a.departments.sales, jobRoleId: s.h.a.jobRoles.sdr, objects: dev.objects });
    const run = runOutcome({ endedAt: at("2026-10-21") });
    receipt(await sendObjects(s.h, dev.dev, [run]));
    senders.at(-1)!.objects.push(run);
    const before = await owner.get(q("company"));
    const rev = reviewEvent(run.runId, { review: 15 });
    receipt(await sendObjects(s.h, dev.dev, [rev]));
    senders.at(-1)!.objects.push(rev);
    const after = await owner.get(q("company"));
    expect(after.json.total.seconds).toBeGreaterThan(before.json.total.seconds);
    expect(after.json).toEqual({ ...report(goldenReport(senders, { type: "company", id: null }, deptChildren(), { period: OCT })), final: false });
    expect(p.personId).not.toBe(dev.personId);
  });

  test("HOURS: a run updated from failed to success counts once, as success", async () => {
    const dev = (await populate(s, s.h.a, { departmentId: s.h.a.departments.finance, jobRoleId: s.h.a.jobRoles.ap, size: 1, runsEach: 0, workflowId: WF2 }))[0]!;
    const run = runOutcome({ workflowId: WF2, outcome: "failed", sent: 0, endedAt: at("2026-10-22") });
    const rev = reviewEvent(run.runId);
    receipt(await sendObjects(s.h, dev.dev, [run, rev]));
    const later = { ...run, outcome: "success", items: { ...run.items, total: 2, sent: 2 } };
    receipt(await sendObjects(s.h, dev.dev, [later]));
    senders.push({ personId: dev.personId, departmentId: s.h.a.departments.finance, jobRoleId: s.h.a.jobRoles.ap, objects: [...dev.objects, run, rev, later] });
    const r = await owner.get(q("company"));
    const golden = report(goldenReport(senders, { type: "company", id: null }, deptChildren(), { period: OCT }));
    expect(r.json.total.runs).toEqual((golden.total as { runs: unknown }).runs);
    expect(r.json.total.seconds).toBe((golden.total as { seconds: number }).seconds);
  });

  test("HOURS: runs outside the period are left out; bad periods are 400", async () => {
    const r = await owner.get("/v1/metrics/hours-saved?scope=company&from=2026-09-01&to=2026-10-01");
    expect(r.json.total).toEqual({ suppressed: true, reason: "group_floor" });
    expect((await owner.get("/v1/metrics/hours-saved?scope=company&from=2026-10-31&to=2026-10-01")).status).toBe(400);
    expect((await owner.get("/v1/metrics/hours-saved?scope=company&from=2026-1-1")).status).toBe(400);
    expect((await owner.get("/v1/metrics/hours-saved?scope=company&from=2024-01-01&to=2026-01-01")).status).toBe(400);
  });

  test("HOURS: dept lead sees own department only; member is forbidden; auditor sees the company", async () => {
    const lead = await asPrincipal(s.h, "lead");
    expect((await lead.get(q(`department:${s.h.a.departments.sales}`))).status).toBe(200);
    expect((await lead.get(q(`department:${s.h.a.departments.finance}`))).status).toBe(404);
    expect((await lead.get(q("company"))).status).toBe(404);
    expect((await lead.get(q(`job_role:${s.h.a.jobRoles.ap}`))).status).toBe(404);
    expect((await lead.get(q(`job_role:${s.h.a.jobRoles.sdr}`))).status).toBe(200);
    expect((await (await asPrincipal(s.h, "member")).get(q("company"))).status).toBe(403);
    expect((await (await asPrincipal(s.h, "auditor")).get(q("company"))).status).toBe(200);
  });

  test("HOURS: unknown or malformed scopes are 404 / 400", async () => {
    expect((await owner.get(q(`department:${crypto.randomUUID()}`))).status).toBe(404);
    expect((await owner.get(q(`department:${s.h.b.departments.sales}`))).status).toBe(404);
    expect((await owner.get(q("team:x"))).status).toBe(400);
    expect((await owner.get(q("department:nope"))).status).toBe(400);
  });
});
