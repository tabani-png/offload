import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IllegalTransition, transition, type PersonEvent, type PersonState } from "../../src/modules/continuity/states.ts";
import { audits, offboard, stateOf, today, tx, world, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.close());

const LEGAL: Array<[PersonState, PersonEvent, PersonState]> = [
  ["active", "set_end_date", "leaving"],
  ["active", "freeze", "frozen"],
  ["leaving", "set_end_date", "leaving"],
  ["leaving", "clear_end_date", "active"],
  ["leaving", "freeze", "frozen"],
  ["frozen", "depart", "departed"],
];

const ILLEGAL: Array<[PersonState, PersonEvent]> = [
  ["active", "clear_end_date"],
  ["active", "depart"],
  ["leaving", "depart"],
  ["frozen", "freeze"],
  ["frozen", "set_end_date"],
  ["frozen", "clear_end_date"],
  ["departed", "freeze"],
  ["departed", "set_end_date"],
  ["departed", "clear_end_date"],
  ["departed", "depart"],
];

describe("STATES", () => {
  test.each(LEGAL)("STATES: %s --%s--> %s", (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  test.each(ILLEGAL)("STATES: %s --%s--> is illegal", (from, event) => {
    expect(() => transition(from, event)).toThrow(IllegalTransition);
  });

  test("STATES: an end date in the future makes the person leaving; everything keeps running", async () => {
    await w.as("member");
    const r = await offboard(w, w.t.people.member.id, { effectiveOn: today(w, 14), reason: "end_date" });
    expect(r.status).toBe(200);
    expect(w.h.deps.validator.validate("offload/stage2/person.schema.json", r.json)).toEqual({ ok: true });
    expect(r.json).toMatchObject({ id: w.t.people.member.id, state: "leaving", leavingOn: today(w, 14) });
    const [s] = await w.h.db.migrator`select count(*)::int as n from sessions where person_id = ${w.t.people.member.id} and revoked_at is null`;
    expect(s!.n).toBeGreaterThan(0);
  });

  test("STATES: offboarding a leaving person today freezes them", async () => {
    const r = await offboard(w, w.t.people.member.id, { reason: "admin" });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("frozen");
    expect(await stateOf(w, w.t.people.member.id)).toBe("frozen");
  });

  test("STATES: offboarding a frozen person again is 409 conflict", async () => {
    const r = await offboard(w, w.t.people.member.id);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
  });

  test("STATES: a departed person cannot be offboarded or frozen again", async () => {
    await w.h.db.migrator`update people set state = 'departed' where id = ${w.t.people.auditor.id}`;
    expect((await offboard(w, w.t.people.auditor.id)).status).toBe(409);
    // The port is idempotent: freezing someone who is not active or leaving changes nothing.
    const before = (await audits(w, "person.freeze")).length;
    await tx(w, (t) => w.continuity.freeze(t, w.t.people.auditor.id, { source: "admin" }));
    expect(await stateOf(w, w.t.people.auditor.id)).toBe("departed");
    expect((await audits(w, "person.freeze")).length).toBe(before);
  });

  test("STATES: you cannot offboard yourself, and an admin cannot offboard an owner", async () => {
    expect((await offboard(w, w.t.people.admin.id, {}, "admin")).status).toBe(409);
    expect((await offboard(w, w.t.people.owner.id, {}, "admin")).status).toBe(403);
    expect(await stateOf(w, w.t.people.owner.id)).toBe("active");
  });

  test("STATES: only owner and admin may offboard (RBAC matrix), unknown people are 404", async () => {
    for (const who of ["lead", "member2"] as const) expect((await offboard(w, w.extra.rep3, {}, who)).status).toBe(403);
    expect((await offboard(w, crypto.randomUUID())).status).toBe(404);
    expect((await offboard(w, w.t.people.member.id, { effectiveOn: "26-10-2026" })).status).toBe(400);
    expect((await offboard(w, w.extra.rep3, { reason: "fired" })).status).toBe(400);
    expect(await stateOf(w, w.extra.rep3)).toBe("active");
  });

  test("STATES: another tenant's person is 404", async () => {
    expect((await offboard(w, w.h.b.people.member.id)).status).toBe(404);
  });

  test("STATES: the end-date sweep freezes a leaving person whose end date has come", async () => {
    const c = await w.as("admin");
    const r = await c.patch(`/v1/people/${w.extra.rep3}`, { leavingOn: today(w, 1) });
    expect(r.status).toBe(200);
    expect(await stateOf(w, w.extra.rep3)).toBe("leaving");
    await w.continuity.sweep(w.t.id);
    expect(await stateOf(w, w.extra.rep3)).toBe("leaving");
    w.h.clock.advance(2 * 86_400_000);
    await w.continuity.sweep(w.t.id);
    await w.continuity.idle();
    expect(await stateOf(w, w.extra.rep3)).toBe("frozen");
    const [o] = await w.h.db.migrator`select state, reason from offboardings where person_id = ${w.extra.rep3}`;
    expect(o).toEqual({ state: "frozen", reason: "end_date" });
  });

  test("STATES: frozen becomes departed after 30 days even with hand-overs open", async () => {
    await w.continuity.sweep(w.t.id);
    expect(await stateOf(w, w.t.people.member.id)).toBe("frozen");
    w.h.clock.advance(31 * 86_400_000);
    await w.continuity.sweep(w.t.id);
    expect(await stateOf(w, w.t.people.member.id)).toBe("departed");
    const [o] = await w.h.db.migrator`select state, departed_at, proposals_kept_until from offboardings where person_id = ${w.t.people.member.id}`;
    expect(o!.state).toBe("departed");
    expect(o!.proposals_kept_until.getTime() - o!.departed_at.getTime()).toBe(90 * 86_400_000);
    expect((await audits(w, "person.departed")).some((e) => e.subject_person_id === w.t.people.member.id)).toBe(true);
  });
});
