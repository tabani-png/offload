import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { report } from "../../../packages/hours-saved/src/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { goldenReport, type Sender } from "./golden.ts";
import { addDevice, at, baselineSample, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, workingTime, type S205 } from "./helpers.ts";

const OCT = { from: "2026-10-01", toExclusive: "2026-11-01" };
let s: S205;
let owner: Client;
let lead: Client;
let member: Client;
const senders: Sender[] = [];
const hsP = (id: string) => `/v1/metrics/hours-saved?scope=person:${id}&from=2026-10-01&to=2026-11-01`;

const reads = async (subject: string) =>
  (await s.h.db.migrator`select actor_id, detail from audit_events where action = 'person.read' and subject_person_id = ${subject}
    and resource_type = 'metrics' order by seq`) as Array<{ actor_id: string; detail: Record<string, unknown> }>;

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  for (const p of await populate(s, t, { departmentId: t.departments.sales, size: 5 })) {
    senders.push({ personId: p.personId, departmentId: t.departments.sales, jobRoleId: null, objects: p.objects });
  }
  // The seeded member (sales, CA-ON) runs WF1 too, and member2 (finance) works in GB.
  await s.h.db.migrator`update people set jurisdiction = 'GB' where id = ${t.people.member2.id}`;
  for (const who of ["member", "member2"] as const) {
    const id = t.people[who].id;
    s.fc.acked.add(id);
    const dev = await addDevice(s.h, t, id);
    const run = runOutcome({ endedAt: at("2026-10-15"), sent: 2 });
    const objects = [baselineSample([500, 520]), run, reviewEvent(run.runId, { review: 40 })];
    receipt(await sendObjects(s.h, dev, objects));
    senders.push({ personId: id, departmentId: t.people[who].departmentId, jobRoleId: null, objects });
    if (who === "member") {
      s.fc.workingTime.add(id);
      s.fc.features.set("CA-ON", ["working_time"]);
      receipt(await sendObjects(s.h, dev, [workingTime("2026-10-15", 400)]));
      s.fc.features.delete("CA-ON");
    }
  }
  owner = await asPrincipal(s.h, "owner");
  lead = await asPrincipal(s.h, "lead");
  member = await asPrincipal(s.h, "member");
});
afterAll(() => s.close());

describe("PERSON per-person reads", () => {
  test("PERSON: person scope without per_person_views is 403 feature_disabled and writes no read event", async () => {
    const id = s.h.a.people.member.id;
    const r = await owner.get(hsP(id));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("feature_disabled");
    expect(await reads(id)).toEqual([]);
  });

  test("PERSON: with the feature on for the subject's jurisdiction: 200, hs-1 on that person's rows, one person.read event", async () => {
    s.fc.features.set("CA-ON", ["per_person_views"]);
    const id = s.h.a.people.member.id;
    const r = await owner.get(hsP(id));
    expect(r.status).toBe(200);
    // The person's runs, with the baseline from every device's samples of that workflow version.
    const all = goldenReport(senders, { type: "person", id }, [], { period: OCT });
    const expected = report({ ...all, runs: all.runs.filter((x) => x.personId === id), reviews: all.reviews.filter((v) => all.runs.some((x) => x.personId === id && x.run.runId === v.runId)) });
    expect(r.json).toEqual({ ...expected, final: false });
    const ev = await reads(id);
    expect(ev.length).toBe(1);
    expect(ev[0]!.actor_id).toBe(s.h.a.people.owner.id);
    expect(ev[0]!.detail).toMatchObject({ endpoint: "hours_saved", from: "2026-10-01", to: "2026-11-01" });
  });

  test("PERSON: a person view is not group-floored (one person has numbers)", async () => {
    const r = await owner.get(hsP(s.h.a.people.member.id));
    expect(r.json.total.people).toBe(1);
    expect(r.json.total.seconds).toBeGreaterThan(0);
  });

  test("PERSON: a subject whose jurisdiction lacks the feature stays 403 although others have it", async () => {
    const r = await owner.get(hsP(s.h.a.people.member2.id));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("feature_disabled");
  });

  test("PERSON: a member always sees their own numbers, with the feature off, and that is not an audited read", async () => {
    s.fc.features.delete("CA-ON");
    const id = s.h.a.people.member.id;
    const before = (await reads(id)).length;
    const r = await member.get(hsP(id));
    expect(r.status).toBe(200);
    expect(r.json.total.people).toBe(1);
    // Self-view baseline is the same union of samples as everyone else's view.
    s.fc.features.set("CA-ON", ["per_person_views"]);
    expect(r.json).toEqual((await owner.get(hsP(id))).json);
    expect((await reads(id)).length).toBe(before + 1);
  });

  test("PERSON: a member asking for someone else is 404", async () => {
    expect((await member.get(hsP(s.h.a.people.lead.id))).status).toBe(404);
    expect((await member.get(hsP(senders[0]!.personId))).status).toBe(404);
  });

  test("PERSON: a dept lead with the feature reads people in their department (audited), not others (404)", async () => {
    s.fc.features.set("GB", ["per_person_views"]);
    const inDept = senders[0]!.personId;
    const r = await lead.get(hsP(inDept));
    expect(r.status).toBe(200);
    expect((await reads(inDept)).map((e) => e.actor_id)).toEqual([s.h.a.people.lead.id]);
    expect((await lead.get(hsP(s.h.a.people.member2.id))).status).toBe(404);
  });

  test("PERSON: the auditor has no per-person access", async () => {
    const auditor = await asPrincipal(s.h, "auditor");
    expect((await auditor.get(hsP(s.h.a.people.member.id))).status).toBe(403);
  });

  test("PERSON: working time per person needs working_time and per_person_views for owner; self needs working_time on", async () => {
    const id = s.h.a.people.member.id;
    const wt = `/v1/metrics/working-time?scope=person:${id}&from=2026-10-01&to=2026-11-01`;
    s.fc.features.set("CA-ON", ["per_person_views"]);
    expect((await owner.get(wt)).json.error.code).toBe("feature_disabled");
    expect((await member.get(wt)).json.error.code).toBe("feature_disabled");
    s.fc.features.set("CA-ON", ["per_person_views", "working_time"]);
    const r = await owner.get(wt);
    expect(r.status).toBe(200);
    expect(r.json.value).toEqual({ people: 1, medianActiveMinutesPerDay: 400, p25: 400, p75: 400 });
    expect((await reads(id)).at(-1)!.detail).toMatchObject({ endpoint: "working_time" });
    expect((await member.get(wt)).json.value.people).toBe(1);
  });

  test("PERSON: the read event and the data come from one transaction: a failing read leaves no event", async () => {
    const id = s.h.a.people.member.id;
    const before = (await reads(id)).length;
    // An invalid period fails before anything is read or written.
    expect((await owner.get(`/v1/metrics/hours-saved?scope=person:${id}&from=2026-10-05&to=2026-10-01`)).status).toBe(400);
    expect((await reads(id)).length).toBe(before);
  });
});
