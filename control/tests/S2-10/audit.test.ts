import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { audits, handoverFor, offboard, world, type World } from "./world.ts";

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
  const admin = await w.as("admin");
  await admin.post(`/v1/handovers/${h1}/assign`, { successor: { type: "person", personId: w.extra.rep2 }, inboxStep: "google_alias" });
  await (await w.as("rep2")).post(`/v1/handovers/${h1}/accept`, {});
  await (await w.as("lead")).post(`/v1/handovers/${h2}/assign`, { successor: { type: "role_identity", roleIdentityId: w.identities.sdr } });
  await admin.post(`/v1/handovers/${h1}/close`);
});
afterAll(() => w.close());

describe("AUDIT", () => {
  test("AUDIT: assignment records who assigned which successor, in-flight choice and inbox step", async () => {
    const evs = await audits(w, "handover.assigned");
    expect(evs.length).toBe(2);
    expect(evs[0]).toMatchObject({
      actor_type: "person",
      actor_id: w.t.people.admin.id,
      subject_person_id: member,
      resource_type: "handover",
      resource_id: h1,
      detail: { workflowId: w.wf.sdr1, successor: { type: "person", personId: w.extra.rep2 }, inFlight: "pause", inboxStep: "google_alias" },
    });
    expect(evs[1]).toMatchObject({ actor_id: w.t.people.lead.id, resource_id: h2, detail: { successor: { type: "role_identity", roleIdentityId: w.identities.sdr } } });
  });

  test("AUDIT: acceptance is the successor's own event", async () => {
    const [ev] = await audits(w, "handover.accepted");
    expect(ev).toMatchObject({ actor_type: "person", actor_id: w.extra.rep2, resource_id: h1, detail: { workflowId: w.wf.sdr1 } });
  });

  test("AUDIT: resume names the identity sending resumes under", async () => {
    const evs = await audits(w, "handover.resumed");
    const byHandover = Object.fromEntries(evs.map((e) => [e.resource_id, e.detail]));
    expect(byHandover[h1]).toMatchObject({ workflowId: w.wf.sdr1, identity: { type: "person", id: w.extra.rep2 } });
    expect(byHandover[h2]).toMatchObject({ workflowId: w.wf.sdr2, identity: { type: "role_identity", id: w.identities.sdr } });
  });

  test("AUDIT: hand-over open and close are audited", async () => {
    expect((await audits(w, "handover.opened")).map((e) => e.resource_id).sort()).toEqual([h1, h2].sort());
    const [closed] = await audits(w, "handover.closed");
    expect(closed).toMatchObject({ actor_id: w.t.people.admin.id, resource_id: h1 });
  });

  test("AUDIT: the hand-over history (handover_events) mirrors it with the acting identity and is append-only", async () => {
    const rows = await w.h.db.migrator`select kind, actor_type, actor_id from handover_events where handover_id = ${h1} order by id`;
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["opened", "assigned", "accepted", "resumed", "closed"]);
    expect(rows[2]).toMatchObject({ actor_type: "person", actor_id: w.extra.rep2 });
    const refused = async (q: () => Promise<unknown>) => {
      try {
        await q();
        return "allowed";
      } catch (e) {
        return String((e as Error).message);
      }
    };
    expect(await refused(() => w.h.db.migrator.unsafe("update handover_events set kind = 'opened'"))).toMatch(/append-only/);
    expect(await refused(() => w.h.db.migrator.unsafe("delete from handover_events"))).toMatch(/append-only/);
  });

  test("AUDIT: the offboarding request itself is audited with what was decided (the note stays on the offboarding row)", async () => {
    const [ev] = await audits(w, "person.offboard");
    expect(ev).toMatchObject({ actor_id: w.t.people.admin.id, subject_person_id: member, detail: { reason: "admin", state: "frozen" } });
  });

  test("AUDIT: the audit chain still verifies", async () => {
    const r = await (await w.as("owner")).get("/v1/audit-log/verify");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });
});
