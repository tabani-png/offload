// Codex review of 7532aa3 (PR #16): the end-date sweep re-checks the date under the person lock; hand-overs cover
// workflows the person ran, not only the ones of roles they hold now.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { email, handoversOf, offboard, run, stateOf, to, today, world, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.close());

describe("STATES", () => {
  test("STATES: an end date postponed while the sweep runs is honoured: the person is not frozen", async () => {
    const rep3 = w.extra.rep3;
    expect((await offboard(w, rep3, { effectiveOn: today(w, 5) })).status).toBe(200);
    expect(await stateOf(w, rep3)).toBe("leaving");
    await w.h.db.migrator`update people set leaving_on = ${today(w)}::date where id = ${rep3}`;
    const gate = await w.h.db.migrator.reserve();
    try {
      await gate`begin`;
      await gate`select 1 from people where id = ${rep3} for update`;
      const sweeping = w.continuity.sweep(w.t.id);
      await Bun.sleep(400);
      await gate`update people set leaving_on = ${today(w, 30)}::date where id = ${rep3}`;
      await gate`update offboardings set effective_on = ${today(w, 30)}::date where person_id = ${rep3}`;
      await gate`commit`;
      const out = await sweeping;
      expect(out.frozen).toBe(0);
    } finally {
      gate.release();
    }
    expect(await stateOf(w, rep3)).toBe("leaving");
    const [s] = await w.h.db.migrator`select count(*)::int as n from people where id = ${rep3} and pending_freeze_at is null`;
    expect(s!.n).toBe(1);
  });
});

describe("HANDOVER", () => {
  test("HANDOVER: a dept lead who ran a role workflow without holding the role gets a hand-over for it", async () => {
    const lead = w.t.people.lead.id;
    const [c] = await w.h.db.migrator`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
      values (${w.t.id}, 'gmail', 'personal-allowed', 'Lead Gmail', ${lead}, 'composio', 'acct_lead_gmail') returning id`;
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr1, { type: "person", id: lead }, lead, c!.id as string), [email(to())]);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect((await offboard(w, lead)).status).toBe(200);
    expect((await handoversOf(w, lead)).map((h) => h.workflow_id)).toContain(w.wf.sdr1);
  });

  test("HANDOVER: a person whose job role was removed before offboarding still gets hand-overs for the workflows they ran", async () => {
    const rep2 = w.extra.rep2;
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr2, { type: "person", id: rep2 }, rep2, w.rep2Gmail), [email(to())]);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    await w.h.db.migrator`delete from job_role_holders where person_id = ${rep2}`;
    expect((await offboard(w, rep2)).status).toBe(200);
    expect((await handoversOf(w, rep2)).map((h) => h.workflow_id)).toEqual([w.wf.sdr2]);
  });
});
