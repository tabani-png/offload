import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handoverFor, handoversOf, offboard, runnable, world, type World } from "./world.ts";

let w: World;
let member: string;
let h1: string;
let h2: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
  await offboard(w, member);
  h1 = await handoverFor(w, member, w.wf.sdr1);
  h2 = await handoverFor(w, member, w.wf.sdr2);
});
afterAll(() => w.close());

const person = (personId: string) => ({ successor: { type: "person", personId } });
const identity = (roleIdentityId: string) => ({ successor: { type: "role_identity", roleIdentityId } });

describe("SUCCESSOR", () => {
  test("SUCCESSOR: a person who does not hold the job role is refused (409), nothing changes", async () => {
    const admin = await w.as("admin");
    for (const p of [w.extra.rep3, w.t.people.member2.id, w.t.people.lead.id]) {
      const r = await admin.post(`/v1/handovers/${h1}/assign`, person(p));
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("conflict");
    }
    expect((await handoversOf(w, member)).find((h) => h.id === h1)!.state).toBe("open");
  });

  test("SUCCESSOR: the leaver themself, a frozen holder, an unknown person or another tenant's person is refused", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h1}/assign`, person(member))).status).toBe(409);
    expect((await admin.post(`/v1/handovers/${h1}/assign`, person(crypto.randomUUID()))).status).toBe(409);
    expect((await admin.post(`/v1/handovers/${h1}/assign`, person(w.h.b.people.member.id))).status).toBe(409);
    await w.h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${w.t.id}, ${w.t.jobRoles.sdr}, ${w.extra.rep3})`;
    await w.h.db.migrator`update people set state = 'frozen' where id = ${w.extra.rep3}`;
    expect((await admin.post(`/v1/handovers/${h1}/assign`, person(w.extra.rep3))).status).toBe(409);
  });

  test("SUCCESSOR: a malformed body is 400", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h1}/assign`, {})).status).toBe(400);
    expect((await admin.post(`/v1/handovers/${h1}/assign`, { successor: { type: "person" } })).status).toBe(400);
    expect((await admin.post(`/v1/handovers/${h1}/assign`, { ...person(w.extra.rep2), inFlight: "resend" })).status).toBe(400);
    expect((await admin.post(`/v1/handovers/${h1}/assign`, { ...person(w.extra.rep2), extra: 1 })).status).toBe(400);
  });

  test("SUCCESSOR: a job-role holder is assigned but must accept before anything runs", async () => {
    const admin = await w.as("admin");
    const r = await admin.post(`/v1/handovers/${h1}/assign`, person(w.extra.rep2));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: "assigned", successor: { type: "person", personId: w.extra.rep2 }, assignedBy: w.t.people.admin.id });
    expect(await runnable(w, w.wf.sdr1, { personId: w.extra.rep2 })).toBe(false);
  });

  test("SUCCESSOR: only the named successor can accept; anyone else gets 404", async () => {
    expect((await (await w.as("member2")).post(`/v1/handovers/${h1}/accept`, {})).status).toBe(404);
    expect((await (await w.as("admin")).post(`/v1/handovers/${h1}/accept`, {})).status).toBe(403);
  });

  test("SUCCESSOR: after the named successor accepts, the workflow runs again", async () => {
    const r = await (await w.as("rep2")).post(`/v1/handovers/${h1}/accept`, {});
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("assigned");
    expect(await runnable(w, w.wf.sdr1, { personId: w.extra.rep2 })).toBe(true);
    expect((await (await w.as("rep2")).post(`/v1/handovers/${h1}/accept`, {})).status).toBe(409);
  });

  test("SUCCESSOR: a successor who loses the job role before accepting cannot accept", async () => {
    const admin = await w.as("admin");
    const other = await w.h.db.migrator`insert into people (tenant_id, email, display_name, access_role, department_id, jurisdiction, source)
      values (${w.t.id}, ${`rep4@${w.t.id.slice(0, 8)}.example.com`}, 'rep4', 'member', ${w.t.departments.sales}, 'CA-ON', 'manual') returning id`;
    const rep4 = other[0]!.id as string;
    await w.h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${w.t.id}, ${w.t.jobRoles.sdr}, ${rep4})`;
    expect((await admin.post(`/v1/handovers/${h2}/assign`, person(rep4))).status).toBe(200);
    await w.h.db.migrator`delete from job_role_holders where person_id = ${rep4}`;
    const { createSession } = await import("../helpers/seed.ts");
    const cred = await createSession(w.h.db.migrator, w.t.id, rep4, w.h.clock.now());
    const r = await w.h.request("POST", `/v1/handovers/${h2}/accept`, { body: {}, headers: { Cookie: cred.cookie, "X-CSRF-Token": cred.csrf } });
    expect(r.status).toBe(409);
    expect(await runnable(w, w.wf.sdr2, { personId: w.extra.rep2 })).toBe(false);
  });

  test("SUCCESSOR: a role identity of another job role is refused; an unknown one too", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h2}/assign`, identity(w.identities.ap))).status).toBe(409);
    expect((await admin.post(`/v1/handovers/${h2}/assign`, identity(crypto.randomUUID()))).status).toBe(409);
  });

  test("SUCCESSOR: the job role's role identity needs no acceptance: the workflow runs as it at once", async () => {
    const admin = await w.as("admin");
    const r = await admin.post(`/v1/handovers/${h2}/assign`, identity(w.identities.sdr));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: "assigned", successor: { type: "role_identity", roleIdentityId: w.identities.sdr } });
    expect(await runnable(w, w.wf.sdr2, { identityId: w.identities.sdr })).toBe(true);
    expect((await (await w.as("rep2")).post(`/v1/handovers/${h2}/accept`, {})).status).toBe(404);
  });
});
