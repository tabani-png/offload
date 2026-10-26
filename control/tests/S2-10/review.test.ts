// Codex review of a235d21 (PR #16): offboarding never blocked by the workers service, any person successor accepts,
// the successor sees their own assignment, and the hand-over paths take the leaver's row before the hand-over's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { audits, handoverFor, offboard, stateOf, world, type World } from "./world.ts";

let w: World;
let member: string;
let h1: string;
let h2: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
  for (const who of [w.t.people.admin.id, w.t.people.lead.id]) {
    await w.h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${w.t.id}, ${w.t.jobRoles.sdr}, ${who})`;
  }
  await offboard(w, member);
  h1 = await handoverFor(w, member, w.wf.sdr1);
  h2 = await handoverFor(w, member, w.wf.sdr2);
});
afterAll(() => w.close());

describe("FREEZE", () => {
  test("FREEZE: the workers service down at freeze time does not block offboarding; the pause is retried until delivered", async () => {
    const m2 = w.t.people.member2.id;
    await w.as("member2");
    w.workers.failAlways = true;
    try {
      const r = await offboard(w, m2);
      expect(r.status).toBe(200);
      expect(await stateOf(w, m2)).toBe("frozen");
      const [s] = await w.h.db.migrator`select count(*)::int as n from sessions where person_id = ${m2} and revoked_at is null`;
      expect(s!.n).toBe(0);
      const [o] = await w.h.db.migrator`select pause_pending from offboardings where person_id = ${m2}`;
      expect(o!.pause_pending).toBe(true);
      expect((await audits(w, "person.freeze")).filter((e) => e.subject_person_id === m2).length).toBe(1);
      await w.continuity.sweep(w.t.id);
      const [still] = await w.h.db.migrator`select pause_pending from offboardings where person_id = ${m2}`;
      expect(still!.pause_pending).toBe(true);
    } finally {
      w.workers.failAlways = false;
    }
    await w.continuity.sweep(w.t.id);
    const [p] = await w.h.db.migrator`select pause_pending, paused_at from offboardings where person_id = ${m2}`;
    expect(p).toMatchObject({ pause_pending: false });
    expect(p!.paused_at).not.toBeNull();
    expect((await audits(w, "person.workers_paused")).filter((e) => e.subject_person_id === m2).length).toBe(1);
  });
});

describe("SUCCESSOR", () => {
  test("SUCCESSOR: an admin or dept lead named as successor can accept (S for every person column)", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h1}/assign`, { successor: { type: "person", personId: w.t.people.admin.id } })).status).toBe(200);
    expect((await admin.post(`/v1/handovers/${h2}/assign`, { successor: { type: "person", personId: w.t.people.lead.id } })).status).toBe(200);
    expect((await (await w.as("lead")).post(`/v1/handovers/${h1}/accept`, {})).status).toBe(404);
    expect((await admin.post(`/v1/handovers/${h1}/accept`, {})).status).toBe(200);
    expect((await (await w.as("lead")).post(`/v1/handovers/${h2}/accept`, {})).status).toBe(200);
  });
});

describe("AUDIT", () => {
  test("AUDIT: the named successor sees their assignment in their own access log", async () => {
    const assigned = await (await w.as("admin")).post(`/v1/handovers/${h2}/assign`, { successor: { type: "person", personId: w.t.people.lead.id } });
    expect(assigned.status).toBe(200);
    const r = await (await w.as("lead")).get(`/v1/me/access-log?action=handover.successor_named`);
    expect(r.status).toBe(200);
    const evs = r.json.items as Array<{ resource: { id: string }; subjectPersonId: string }>;
    expect(evs.map((e) => e.resource.id)).toContain(h2);
    expect(evs.every((e) => e.subjectPersonId === w.t.people.lead.id)).toBe(true);
  });
});

describe("HANDOVER", () => {
  test("HANDOVER: lock order: close takes the leaver's row before the hand-over row (no person-then-handover cycle with freeze)", async () => {
    // A ready hand-over (the job role's role identity needs no acceptance).
    expect((await (await w.as("admin")).post(`/v1/handovers/${h1}/assign`, { successor: { type: "role_identity", roleIdentityId: w.identities.sdr } })).status).toBe(200);
    // Hold the leaver's row from another connection; close must wait on it without holding the hand-over row.
    const held = await w.h.db.migrator.reserve();
    try {
      await held`begin`;
      await held`select 1 from people where id = ${member} for update`;
      const closing = (await w.as("admin")).post(`/v1/handovers/${h1}/close`, {});
      await Bun.sleep(300);
      const probe = await w.h.db.migrator.reserve();
      let handoverFree = false;
      try {
        await probe`begin`;
        await probe`set local lock_timeout = '200ms'`;
        await probe`select 1 from handovers where id = ${h1} for update`;
        handoverFree = true;
      } catch {
        handoverFree = false;
      } finally {
        await probe`rollback`;
        probe.release();
      }
      await held`rollback`;
      expect((await closing).status).toBe(200);
      expect(handoverFree).toBe(true);
    } finally {
      held.release();
    }
  });
});
