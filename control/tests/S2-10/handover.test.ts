import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handoverFor, handoversOf, offboard, runnable, stateOf, today, world, type World } from "./world.ts";

let w: World;
let member: string;
let m2: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
  m2 = w.t.people.member2.id;
});
afterAll(() => w.close());

const HANDOVER = "offload/stage2/handover.schema.json";
const assignTo = (personId: string) => ({ successor: { type: "person", personId } });

describe("HANDOVER", () => {
  test("HANDOVER: leaving opens one hand-over per role workflow early, and the workflows keep running", async () => {
    expect((await offboard(w, member, { effectiveOn: today(w, 10), reason: "end_date" })).status).toBe(200);
    const hs = await handoversOf(w, member);
    expect(hs.map((h) => h.workflow_id).sort()).toEqual([w.wf.sdr1, w.wf.sdr2].sort());
    expect(hs.every((h) => h.state === "open" && h.in_flight === "pause")).toBe(true);
    expect(await runnable(w, w.wf.sdr1, { personId: member })).toBe(true);
    expect(await runnable(w, w.wf.sdr1, { personId: w.extra.rep2 })).toBe(true);
  });

  test("HANDOVER: no hand-over for the unpromoted proposal (kept for the admin) or another person's workflow", async () => {
    const ids = (await handoversOf(w, member)).map((h) => h.workflow_id);
    expect(ids).not.toContain(w.proposalId);
    expect(ids).not.toContain(w.wf.ap);
  });

  test("HANDOVER: freezing after leaving keeps exactly one hand-over per workflow", async () => {
    expect((await offboard(w, member)).status).toBe(200);
    expect((await handoversOf(w, member)).length).toBe(2);
    expect((await offboard(w, m2)).status).toBe(200);
    expect((await handoversOf(w, m2)).map((h) => h.workflow_id)).toEqual([w.wf.ap]);
  });

  test("HANDOVER: until assigned, the workflow does not run for anyone (isRunnableBy false)", async () => {
    expect(await runnable(w, w.wf.sdr1, { personId: w.extra.rep2 })).toBe(false);
    expect(await runnable(w, w.wf.sdr1, { identityId: w.identities.sdr })).toBe(false);
    expect(await runnable(w, w.wf.ap, { identityId: w.identities.ap })).toBe(false);
  });

  test("HANDOVER: admin lists every hand-over; responses match handover.schema.json", async () => {
    const r = await (await w.as("admin")).get("/v1/handovers");
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBe(3);
    for (const it of r.json.items) expect(w.h.deps.validator.validate(HANDOVER, it)).toEqual({ ok: true });
    expect(r.json.page.nextCursor).toBeNull();
    const open = await (await w.as("admin")).get("/v1/handovers?state=open");
    expect(open.json.items.length).toBe(3);
    expect((await (await w.as("admin")).get("/v1/handovers?state=closed")).json.items).toEqual([]);
    expect((await (await w.as("admin")).get("/v1/handovers?state=nope")).status).toBe(400);
  });

  test("HANDOVER: pages through the list with an opaque cursor", async () => {
    const admin = await w.as("admin");
    const first = await admin.get("/v1/handovers?limit=2");
    expect(first.json.items.length).toBe(2);
    const next = await admin.get(`/v1/handovers?limit=2&cursor=${encodeURIComponent(first.json.page.nextCursor)}`);
    expect(next.json.items.length).toBe(1);
    expect(next.json.page.nextCursor).toBeNull();
  });

  test("HANDOVER: a dept lead sees and assigns only their department's hand-overs", async () => {
    const lead = await w.as("lead");
    const r = await lead.get("/v1/handovers");
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { workflowId: string }) => i.workflowId).sort()).toEqual([w.wf.sdr1, w.wf.sdr2].sort());
    const finance = await handoverFor(w, m2, w.wf.ap);
    expect((await lead.post(`/v1/handovers/${finance}/assign`, { successor: { type: "role_identity", roleIdentityId: w.identities.ap } })).status).toBe(404);
    expect((await lead.post(`/v1/handovers/${finance}/close`)).status).toBe(404);
    const sales = await handoverFor(w, member, w.wf.sdr2);
    expect((await lead.post(`/v1/handovers/${sales}/assign`, assignTo(w.extra.rep2))).status).toBe(200);
  });

  test("HANDOVER: members cannot list or assign; auditors read but cannot assign", async () => {
    const id = await handoverFor(w, member, w.wf.sdr1);
    const rep = await w.as("rep2");
    expect((await rep.get("/v1/handovers")).status).toBe(403);
    expect((await rep.post(`/v1/handovers/${id}/assign`, assignTo(w.extra.rep2))).status).toBe(403);
    const aud = await w.as("auditor");
    expect((await aud.get("/v1/handovers")).status).toBe(200);
    expect((await aud.post(`/v1/handovers/${id}/assign`, assignTo(w.extra.rep2))).status).toBe(403);
    expect((await (await w.as("admin")).post(`/v1/handovers/${crypto.randomUUID()}/assign`, assignTo(w.extra.rep2))).status).toBe(404);
  });

  test("HANDOVER: another tenant never sees these hand-overs", async () => {
    const { asPrincipal } = await import("../helpers/harness.ts");
    const other = await asPrincipal(w.h, "admin", w.h.b);
    expect((await other.get("/v1/handovers")).json.items).toEqual([]);
    const id = await handoverFor(w, member, w.wf.sdr1);
    expect((await other.post(`/v1/handovers/${id}/close`)).status).toBe(404);
  });

  test("HANDOVER: close rules: an open hand-over and an unaccepted one cannot close", async () => {
    const admin = await w.as("admin");
    const open = await handoverFor(w, member, w.wf.sdr1);
    let r = await admin.post(`/v1/handovers/${open}/close`);
    expect(r.status).toBe(409);
    const unaccepted = await handoverFor(w, member, w.wf.sdr2);
    r = await admin.post(`/v1/handovers/${unaccepted}/close`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
  });

  test("HANDOVER: an accepted hand-over closes; a closed one cannot close or be reassigned", async () => {
    const admin = await w.as("admin");
    const id = await handoverFor(w, member, w.wf.sdr2);
    expect((await (await w.as("rep2")).post(`/v1/handovers/${id}/accept`, {})).status).toBe(200);
    const r = await admin.post(`/v1/handovers/${id}/close`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, state: "closed" });
    expect((await admin.post(`/v1/handovers/${id}/close`)).status).toBe(409);
    expect((await admin.post(`/v1/handovers/${id}/assign`, assignTo(w.extra.rep2))).status).toBe(409);
  });

  test("HANDOVER: closing the last open hand-over makes the person departed", async () => {
    const admin = await w.as("admin");
    const id = await handoverFor(w, member, w.wf.sdr1);
    expect((await admin.post(`/v1/handovers/${id}/assign`, { successor: { type: "role_identity", roleIdentityId: w.identities.sdr } })).status).toBe(200);
    expect(await stateOf(w, member)).toBe("frozen");
    expect((await admin.post(`/v1/handovers/${id}/close`)).status).toBe(200);
    expect(await stateOf(w, member)).toBe("departed");
    expect(await stateOf(w, m2)).toBe("frozen");
  });
});
