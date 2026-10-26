import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { evidence } from "../../../packages/hours-saved/src/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { goldenInputs, type Sender } from "./golden.ts";
import { WF1, WF2, addDevice, at, baselineSample, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

const OCT = { from: "2026-10-01", toExclusive: "2026-11-01" };
let s: S205;
let owner: Client;
const senders: Sender[] = [];
const ev = (extra = "", wf = WF1) => `/v1/metrics/hours-saved/evidence?workflowId=${wf}&version=1&from=2026-10-01&to=2026-11-01${extra}`;

function golden(filter: (x: Sender) => boolean) {
  const inputs = goldenInputs(senders, { period: OCT, workflow: { workflowId: WF1, version: 1 } });
  const all = goldenInputs(senders, { period: OCT });
  return evidence({
    ...inputs,
    runs: inputs.runs.filter((r) => filter(senders.find((x) => x.personId === r.personId)!)),
    samples: all.samples.filter((x) => x.workflowId === WF1),
    estimates: [],
    period: OCT,
    timezone: "UTC",
    workflowId: WF1,
    version: 1,
  });
}

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  for (const [dept, size] of [[t.departments.sales, 5], [t.departments.finance, 5]] as const) {
    for (const p of await populate(s, t, { departmentId: dept, size, runsEach: 2 })) senders.push({ personId: p.personId, departmentId: dept, jobRoleId: null, objects: p.objects });
  }
  // The seeded member (sales) runs WF1 once and is the only person who ran WF2.
  const m = t.people.member.id;
  s.fc.acked.add(m);
  const dev = await addDevice(s.h, t, m);
  const run = runOutcome({ endedAt: at("2026-10-12") });
  const run2 = runOutcome({ workflowId: WF2, endedAt: at("2026-10-13") });
  const objects = [run, reviewEvent(run.runId), baselineSample([400], { workflowId: WF2 }), run2];
  receipt(await sendObjects(s.h, dev, objects));
  senders.push({ personId: m, departmentId: t.departments.sales, jobRoleId: null, objects });
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("EVIDENCE run lists behind a total", () => {
  test("EVIDENCE: owner gets every run of the version in the period, equal to hs-1 evidence() on the same rows", async () => {
    const r = await owner.get(ev("&limit=200"));
    expect(r.status).toBe(200);
    expect(r.json).toEqual(golden(() => true));
    expect(r.json.runs.length).toBe(21);
  });

  test("EVIDENCE: a dept lead lists only runs of people in their departments; the baseline still counts every sample", async () => {
    const lead = await asPrincipal(s.h, "lead");
    const r = await lead.get(ev("&limit=200"));
    expect(r.status).toBe(200);
    const sales = s.h.a.departments.sales;
    expect(r.json).toEqual(golden((x) => x.departmentId === sales));
    expect(r.json.runs.length).toBe(11);
    expect(r.json.baseline.n).toBe((await owner.get(ev())).json.baseline.n);
  });

  test("EVIDENCE: a member lists only their own runs, even for a workflow nobody else ran", async () => {
    const member = await asPrincipal(s.h, "member");
    const r = await member.get(ev());
    expect(r.json.runs.length).toBe(1);
    const only = await member.get(ev("", WF2));
    expect(only.status).toBe(200);
    expect(only.json.runs.length).toBe(1);
    expect(only.json.runs[0].note).toBe("not_reviewed_yet");
  });

  test("EVIDENCE: fewer people than the floor in scope is 422 group_floor (except own runs)", async () => {
    const r = await owner.get(ev("", WF2));
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("group_floor");
    const auditor = await asPrincipal(s.h, "auditor");
    expect((await auditor.get(ev("", WF2))).status).toBe(422);
    expect((await auditor.get(ev())).status).toBe(200);
  });

  test("EVIDENCE: refs are opaque: the 32-hex refs the devices sent, and no person or device id anywhere", async () => {
    const r = await owner.get(ev("&limit=200"));
    const sent = new Set(senders.flatMap((x) => x.objects.filter((o) => o.kind === "baseline_sample" && o.workflowId === WF1)
      .flatMap((o) => (o.instances as Array<{ instanceRef: string }>).map((i) => i.instanceRef))));
    expect(r.json.baseline.samples.length).toBe(sent.size);
    for (const smp of r.json.baseline.samples) {
      expect(smp.instanceRef).toMatch(/^[0-9a-f]{32}$/);
      expect(sent.has(smp.instanceRef)).toBe(true);
    }
    const text = JSON.stringify(r.json);
    for (const x of senders) expect(text.includes(x.personId)).toBe(false);
    const devices = await s.h.db.migrator`select id from devices`;
    for (const d of devices) expect(text.includes(d.id)).toBe(false);
  });

  test("EVIDENCE: pages chain by an opaque cursor without overlap or gaps", async () => {
    const full = (await owner.get(ev("&limit=200"))).json.runs.map((x: { runId: string }) => x.runId);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await owner.get(ev(`&limit=4${cursor ? `&cursor=${cursor}` : ""}`));
      expect(r.status).toBe(200);
      expect(r.json.runs.length).toBeLessThanOrEqual(4);
      seen.push(...r.json.runs.map((x: { runId: string }) => x.runId));
      cursor = r.json.page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(6);
    expect(seen).toEqual(full);
    expect((await owner.get(ev())).json.page.nextCursor).toBeNull();
  });

  test("EVIDENCE: limit outside 1..200, a bad cursor or a missing workflowId/version is 400", async () => {
    expect((await owner.get(ev("&limit=0"))).status).toBe(400);
    expect((await owner.get(ev("&limit=201"))).status).toBe(400);
    expect((await owner.get(ev("&cursor=%%%"))).status).toBe(400);
    expect((await owner.get("/v1/metrics/hours-saved/evidence?version=1")).status).toBe(400);
    expect((await owner.get(`/v1/metrics/hours-saved/evidence?workflowId=${WF1}`)).status).toBe(400);
    expect((await owner.get(`/v1/metrics/hours-saved/evidence?workflowId=${WF1}&version=0`)).status).toBe(400);
  });

  test("EVIDENCE: the response matches hours-saved-evidence.schema.json", async () => {
    const r = await owner.get(ev());
    expect(s.h.deps.validator.validate("offload/stage2/hours-saved-evidence.schema.json", r.json)).toEqual({ ok: true });
    expect(r.json.computation).toBe("hs-1");
  });
});
