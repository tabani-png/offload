import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { enrollDevice, asDevice } from "../helpers/harness.ts";
import { withTenant } from "../../src/db/tenant.ts";
import { audits, email, handoversOf, offboard, principal, run, stateOf, to, world, type World } from "./world.ts";

let w: World;
let member: string;
let deviceToken: string;
let approvedHash: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
});
afterAll(() => w.close());

async function counts() {
  const db = w.h.db.migrator;
  const one = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
  return {
    liveSessions: await one(db`select count(*)::int as n from sessions where person_id = ${member} and revoked_at is null`),
    activeDevices: await one(db`select count(*)::int as n from devices where person_id = ${member} and state = 'active'`),
    liveTokens: await one(db`select count(*)::int as n from approval_tokens where batch_hash = ${approvedHash} and revoked_at is null`),
    personalConnections: await one(db`select count(*)::int as n from connections where owner_person_id = ${member}
      and ownership <> 'company' and external_ref <> ''`),
    handovers: await one(db`select count(*)::int as n from handovers where person_id = ${member}`),
    freezeAudits: await one(db`select count(*)::int as n from audit_events where action = 'person.freeze' and subject_person_id = ${member}`),
  };
}

describe("FREEZE", () => {
  test("FREEZE: setup: the member has a session, a device, an approved batch with an unspent token, personal connections", async () => {
    const c = await w.as("member");
    deviceToken = (await enrollDevice(w.h, c)).token;
    expect((await asDevice(w.h, deviceToken)("GET", "/v1/sync/config")).status).toBe(200);
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr1, { type: "person", id: member }, member, w.personal.gmail), [email(to())]);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    approvedHash = r.batchHash;
    const lead = await principal(w, "lead");
    await withTenant(w.h.db.app, { tenantId: w.t.id, principalPersonId: lead.personId, accessRole: lead.accessRole }, (t) =>
      w.broker.approve(t, lead, approvedHash, { batchHash: approvedHash, itemKeys: null, edits: [] }),
    );
    expect(await counts()).toMatchObject({ liveSessions: 1, activeDevices: 1, liveTokens: 1, personalConnections: 3, handovers: 0 });
  });

  test("FREEZE: a partial failure rolls the whole freeze back (sessions, tokens, connections, state, audit) and pause is not called", async () => {
    // A real failure in the middle of the transaction: deleting the leaver's connections raises.
    await w.h.db.migrator.unsafe(`create function s210_refuse() returns trigger language plpgsql as $$
      begin raise exception 'connection store unavailable'; end $$;
      create trigger s210_refuse before delete on connections for each row execute function s210_refuse()`);
    try {
      const r = await offboard(w, member);
      expect(r.status).toBe(500);
    } finally {
      await w.h.db.migrator.unsafe("drop trigger s210_refuse on connections; drop function s210_refuse()");
    }
    expect(await stateOf(w, member)).toBe("active");
    expect(await counts()).toMatchObject({ liveSessions: 1, activeDevices: 1, liveTokens: 1, personalConnections: 3, handovers: 0, freezeAudits: 0 });
    expect(w.workers.afterCommit(member)).toEqual([]);
    const [o] = await w.h.db.migrator`select count(*)::int as n from offboardings where person_id = ${member}`;
    expect(o!.n).toBe(0);
  });

  test("FREEZE: one call: sessions and devices revoked, person frozen, tokens revoked, personal connections removed, hand-overs opened", async () => {
    const r = await offboard(w, member);
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("frozen");
    expect(await counts()).toMatchObject({ liveSessions: 0, activeDevices: 0, liveTokens: 0, personalConnections: 0, handovers: 2, freezeAudits: 1 });
    expect((await asDevice(w.h, deviceToken)("GET", "/v1/sync/config")).status).toBe(401);
  });

  test("FREEZE: WorkersPort.pauseFor is called after the commit (it sees the frozen person) and recorded", async () => {
    expect(w.workers.afterCommit(member).length).toBeGreaterThanOrEqual(1);
    const [o] = await w.h.db.migrator`select pause_pending, paused_at from offboardings where person_id = ${member}`;
    expect(o!.pause_pending).toBe(false);
    expect(o!.paused_at).not.toBeNull();
    const [ev] = await audits(w, "person.workers_paused");
    expect(ev).toMatchObject({ subject_person_id: member, actor_type: "system", detail: { workers: 1 } });
  });

  test("FREEZE: every effect is in one audited person.freeze event", async () => {
    const [ev] = (await audits(w, "person.freeze")).filter((e) => e.subject_person_id === member);
    expect(ev!.actor_id).toBe(w.t.people.admin.id);
    expect(ev!.detail).toMatchObject({ source: "admin", sessions: 1, devices: 1, connectionsRemoved: 3, handoversOpened: 2 });
    expect(ev!.detail.tokens).toBeGreaterThanOrEqual(1);
  });

  test("FREEZE: lock order: the broker's token.revoke (audit lock, step 10) comes after S2-10's row changes, then S2-10's queued events", async () => {
    const rows = (await w.h.db.migrator`select seq, action from audit_events where tenant_id = ${w.t.id} and subject_person_id = ${member}
      and action in ('token.revoke', 'connection.removed', 'handover.opened', 'person.freeze') order by seq`) as Array<{ action: string }>;
    const actions = rows.map((r) => r.action);
    const revoke = actions.indexOf("token.revoke");
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(actions.slice(revoke + 1).filter((a) => a === "connection.removed").length).toBe(3);
    expect(actions.slice(revoke + 1).filter((a) => a === "handover.opened").length).toBe(2);
    expect(actions[actions.length - 1]).toBe("person.freeze");
    expect(w.broker.lockRetries).toBe(0);
  });

  test("FREEZE: rep2's personal connection and the company connections are untouched", async () => {
    const rows = await w.h.db.migrator`select id, external_ref from connections where id in (${w.rep2Gmail}, ${w.t.connections.company})`;
    expect(rows.length).toBe(2);
    expect(rows.every((r: { external_ref: string }) => r.external_ref !== "")).toBe(true);
  });

  test("FREEZE: a connection still referenced by a batch is erased (no credential reference left), others are deleted", async () => {
    const rows = await w.h.db.migrator`select connection_id, mode, kind from removed_connections where person_id = ${member} order by connection_id`;
    const byId = Object.fromEntries(rows.map((r: { connection_id: string; mode: string }) => [r.connection_id, r.mode]));
    expect(byId).toEqual({ [w.personal.gmail]: "erased", [w.personal.linkedin]: "deleted", [w.personal.forbidden]: "deleted" });
    const [g] = await w.h.db.migrator`select external_ref, health from connections where id = ${w.personal.gmail}`;
    expect(g).toEqual({ external_ref: "", health: "failed" });
    for (const h of await handoversOf(w, member)) expect([...h.removed_connections].sort()).toEqual([w.personal.gmail, w.personal.linkedin, w.personal.forbidden].sort());
  });

  test("FREEZE: a WorkersPort failure after commit leaves the pause pending; the sweep retries it", async () => {
    w.workers.failAfterCommit = true;
    const r = await offboard(w, w.t.people.member2.id);
    expect(r.status).toBe(200);
    const [o] = await w.h.db.migrator`select pause_pending from offboardings where person_id = ${w.t.people.member2.id}`;
    expect(o!.pause_pending).toBe(true);
    w.workers.failAfterCommit = false;
    await w.continuity.sweep(w.t.id);
    const [p] = await w.h.db.migrator`select pause_pending, paused_at from offboardings where person_id = ${w.t.people.member2.id}`;
    expect(p!.pause_pending).toBe(false);
    expect(p!.paused_at).not.toBeNull();
  });
});
