import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { audits, email, handoverFor, offboard, run, stateOf, to, tx, world, type World } from "./world.ts";

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

const asMember = () => run(w, w.wf.sdr1, { type: "person", id: member }, member, w.t.connections.company);

describe("RESUME", () => {
  test("RESUME: while a hand-over is open, a run of the workflow is refused (forbidden) and audited", async () => {
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr1, { type: "person", id: w.extra.rep2 }, w.extra.rep2, w.rep2Gmail), [email(to())]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    const [ev] = await audits(w, "run.held");
    expect(ev).toMatchObject({ resource_type: "workflow", resource_id: w.wf.sdr1, detail: { identity: { type: "person", id: w.extra.rep2 } } });
    expect(await tx(w, (t) => w.continuity.runAs(t, w.wf.sdr1))).toEqual({ held: true, identity: null });
  });

  test("RESUME: a run as the frozen person's identity is refused (forbidden) and audited with the identity", async () => {
    const r = await w.broker.proposeBatch(w.t.id, asMember(), [email(to())]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    const evs = await audits(w, "run.identity_refused");
    expect(evs.length).toBe(1);
    expect(evs[0]).toMatchObject({ subject_person_id: member, actor_type: "system", detail: { identity: { type: "person", id: member }, workflowId: w.wf.sdr1 } });
  });

  test("RESUME: a role-identity run whose runner is the frozen person is refused too", async () => {
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr2, { type: "role_identity", id: w.identities.sdr }, member, w.t.connections.company), [email(to())]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect((await audits(w, "run.identity_refused")).length).toBe(2);
  });

  test("RESUME: after acceptance the run identity is the successor, and their run goes through", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h1}/assign`, { successor: { type: "person", personId: w.extra.rep2 } })).status).toBe(200);
    expect((await (await w.as("rep2")).post(`/v1/handovers/${h1}/accept`, {})).status).toBe(200);
    expect(await tx(w, (t) => w.continuity.runAs(t, w.wf.sdr1))).toEqual({
      held: false,
      identity: { type: "person", id: w.extra.rep2, connectionId: null, signature: null },
    });
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr1, { type: "person", id: w.extra.rep2 }, w.extra.rep2, w.rep2Gmail), [email(to())]);
    expect(r).toMatchObject({ ok: true, state: "pending" });
  });

  test("RESUME: with a role identity, runs use its company connection and signature", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h2}/assign`, { successor: { type: "role_identity", roleIdentityId: w.identities.sdr } })).status).toBe(200);
    const ident = await tx(w, (t) => w.continuity.runAs(t, w.wf.sdr2));
    expect(ident).toEqual({
      held: false,
      identity: { type: "role_identity", id: w.identities.sdr, connectionId: w.t.connections.company, signature: "-- Sales team" },
    });
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr2, { type: "role_identity", id: w.identities.sdr }, w.extra.rep2, ident.identity!.connectionId!), [email(to())]);
    expect(r).toMatchObject({ ok: true });
  });

  test("RESUME: the departed person's identity is never used, even after every hand-over is closed", async () => {
    const admin = await w.as("admin");
    expect((await admin.post(`/v1/handovers/${h1}/close`)).status).toBe(200);
    expect((await admin.post(`/v1/handovers/${h2}/close`)).status).toBe(200);
    expect(await stateOf(w, member)).toBe("departed");
    const r = await w.broker.proposeBatch(w.t.id, asMember(), [email(to())]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect((await audits(w, "run.identity_refused")).length).toBe(3);
    expect(await tx(w, (t) => w.continuity.runAs(t, w.wf.sdr1))).toMatchObject({ held: false, identity: { type: "person", id: w.extra.rep2 } });
  });

  test("RESUME: a workflow with no hand-over is untouched (no identity switch, runs as before)", async () => {
    expect(await tx(w, (t) => w.continuity.runAs(t, w.wf.ap))).toEqual({ held: false, identity: null });
    const m2 = w.t.people.member2.id;
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.ap, { type: "role_identity", id: w.identities.ap }, m2, (await apConnection())!, w.t.jobRoles.ap), [email(to())]);
    expect(r).toMatchObject({ ok: true });
  });

  test("RESUME: checkRun answers the same refusal in process (for runners other than the broker)", async () => {
    const refusal = await tx(w, (t) => w.continuity.checkRun(t, { workflowId: w.wf.sdr1, identity: { type: "person", id: member }, runnerPersonId: member }));
    expect(refusal).toMatchObject({ code: "forbidden" });
    const ok = await tx(w, (t) => w.continuity.checkRun(t, { workflowId: w.wf.sdr1, identity: { type: "person", id: w.extra.rep2 }, runnerPersonId: w.extra.rep2 }));
    expect(ok).toBeNull();
  });
});

async function apConnection(): Promise<string | undefined> {
  const [r] = await w.h.db.migrator`select connection_id from role_identities where id = ${w.identities.ap}`;
  return r?.connection_id as string | undefined;
}
