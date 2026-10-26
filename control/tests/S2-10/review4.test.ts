// Codex review of 2c19bf7 (PR #16): one owners lock shared with people PATCH; the hand-over hold is enforced when a
// batch executes, not only when it is proposed; the early-hand-over sweep re-reads the end date under the person lock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import { ComposioCliExecutor } from "../../src/modules/broker/executors.ts";
import { FakeComposio } from "../S2-07/setup.ts";
import { createSession } from "../helpers/seed.ts";
import { email, handoversOf, offboard, principal, run, stateOf, to, today, tx, world, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.close());

describe("STATES", () => {
  test("STATES: offboarding one owner while the other is demoted (people PATCH): one of them is refused, an owner remains", async () => {
    const db = w.h.db.migrator;
    const a = w.t.people.owner.id;
    const [row] = await db`insert into people (tenant_id, email, display_name, access_role, department_id, jurisdiction, source)
      values (${w.t.id}, ${`owner3@${w.t.id.slice(0, 8)}.example.com`}, 'owner3', 'owner', ${w.t.departments.sales}, 'CA-ON', 'manual') returning id`;
    const b = row!.id as string;
    const credA = await createSession(db, w.t.id, a, w.h.clock.now());
    const credB = await createSession(db, w.t.id, b, w.h.clock.now());
    const headers = (cred: { cookie: string; csrf: string }) => ({ Cookie: cred.cookie, "X-CSRF-Token": cred.csrf });
    const gate = await db.reserve();
    let results: number[] = [];
    try {
      await gate`begin`;
      await gate`select 1 from people where id in (${a}, ${b}) order by id for update`;
      const both = Promise.all([
        w.h.request("PATCH", `/v1/people/${b}`, { body: { accessRole: "admin" }, headers: headers(credA) }),
        w.h.request("POST", `/v1/people/${a}/offboard`, { body: { effectiveOn: today(w), reason: "admin", note: "" }, headers: headers(credB) }),
      ]);
      await Bun.sleep(500);
      await gate`rollback`;
      results = (await both).map((r) => r.status).sort();
    } finally {
      gate.release();
    }
    await w.continuity.idle();
    expect(results).toEqual([200, 409]);
    const [n] = await db`select count(*)::int as n from people where tenant_id = ${w.t.id} and access_role = 'owner' and state in ('active', 'leaving')`;
    expect(n!.n).toBeGreaterThanOrEqual(1);
  });

  test("STATES: an end date cleared while the early-hand-over sweep runs is honoured: no offboarding, no hand-overs", async () => {
    const rep3 = w.extra.rep3;
    await w.h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${w.t.id}, ${w.t.jobRoles.sdr}, ${rep3})`;
    await w.h.db.migrator`update people set state = 'leaving', leaving_on = ${today(w, 10)}::date where id = ${rep3}`;
    const gate = await w.h.db.migrator.reserve();
    try {
      await gate`begin`;
      await gate`select 1 from people where id = ${rep3} for update`;
      const sweeping = w.continuity.sweep(w.t.id);
      await Bun.sleep(400);
      await gate`update people set state = 'active', leaving_on = null where id = ${rep3}`;
      await gate`commit`;
      const out = await sweeping;
      expect(out.leavingOpened).toBe(0);
    } finally {
      gate.release();
    }
    expect(await stateOf(w, rep3)).toBe("active");
    expect((await handoversOf(w, rep3)).length).toBe(0);
    const [o] = await w.h.db.migrator`select count(*)::int as n from offboardings where person_id = ${rep3}`;
    expect(o!.n).toBe(0);
  });
});

describe("INFLIGHT", () => {
  test("INFLIGHT: a batch approved before the freeze for a now-held workflow does not send", async () => {
    const fake = new FakeComposio();
    w.broker.configure({ executors: { composio: new ComposioCliExecutor(fake) } });
    const rep2 = w.extra.rep2;
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr1, { type: "person", id: rep2 }, rep2, w.rep2Gmail), [email(to())]);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    const lead = await principal(w, "lead");
    const { token } = await withTenant(w.h.db.app, { tenantId: w.t.id, principalPersonId: lead.personId, accessRole: lead.accessRole }, (t) =>
      w.broker.approve(t, lead, r.batchHash, { batchHash: r.batchHash, itemKeys: null, edits: [] }),
    );
    expect((await offboard(w, w.t.people.member.id)).status).toBe(200);
    expect(await tx(w, (t) => w.continuity.held(t, w.wf.sdr1))).toBe("awaiting_handover");
    await w.broker.commitApproved(w.t.id, r.batchHash, token).catch(() => null);
    await w.broker.idle();
    expect(fake.tools().length).toBe(0);
    const [s] = await w.h.db.migrator`select count(*)::int as n from batch_items where batch_hash = ${r.batchHash} and state in ('sending', 'sent', 'unknown')`;
    expect(s!.n).toBe(0);
  });
});
