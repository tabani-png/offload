// Codex review of 29b37b4 (PR #16): the end-date sweep never freezes the last live owner (owners lock + last-owner
// check, as the offboard endpoint); two leavers named as each other's successors lock their people rows in id order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { audits, handoverFor, offboard, today, world, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.close());

const liveOwners = async () => {
  const [n] = await w.h.db.migrator`select count(*)::int as n from people
    where tenant_id = ${w.t.id} and access_role = 'owner' and state in ('active', 'leaving')`;
  return n!.n as number;
};

describe("STATES", () => {
  test("STATES: two owners whose end dates both came are swept: one is frozen, one owner stays live, the deferral is recorded once", async () => {
    const db = w.h.db.migrator;
    const a = w.t.people.owner.id;
    const [row] = await db`insert into people (tenant_id, email, display_name, access_role, department_id, jurisdiction, source)
      values (${w.t.id}, ${`owner5@${w.t.id.slice(0, 8)}.example.com`}, 'owner5', 'owner', ${w.t.departments.sales}, 'CA-ON', 'manual') returning id`;
    const b = row!.id as string;
    // Each end date was accepted while the other owner was live; both are now due.
    await db`update people set state = 'leaving', leaving_on = ${today(w, -1)}::date where id in (${a}, ${b})`;
    expect(await liveOwners()).toBe(2);

    const out = await w.continuity.sweep(w.t.id);
    await w.continuity.idle();
    expect(out.frozen).toBe(1);
    expect(await liveOwners()).toBe(1);
    const [s] = await db`select count(*)::int as n from people where id in (${a}, ${b}) and state = 'frozen'`;
    expect(s!.n).toBe(1);
    const deferred = await audits(w, "person.freeze_deferred");
    expect(deferred.length).toBe(1);
    expect(deferred[0]!.detail).toMatchObject({ reason: "last_owner" });

    // A later sweep the same day still keeps the owner live and does not repeat the record.
    const again = await w.continuity.sweep(w.t.id);
    expect(again.frozen).toBe(0);
    expect(await liveOwners()).toBe(1);
    expect((await audits(w, "person.freeze_deferred")).length).toBe(1);
  });
});

describe("SUCCESSOR", () => {
  test("SUCCESSOR: two leavers assigned as each other's successors at once, then accepting at once: no deadlock", async () => {
    const db = w.h.db.migrator;
    const member = w.t.people.member.id;
    const rep2 = w.extra.rep2;
    // Both hold the SDR role and leave later: their hand-overs open early, and each may succeed the other.
    expect((await offboard(w, member, { effectiveOn: today(w, 20) })).status).toBe(200);
    expect((await offboard(w, rep2, { effectiveOn: today(w, 20) })).status).toBe(200);
    const hm = await handoverFor(w, member, w.wf.sdr1);
    const hr = await handoverFor(w, rep2, w.wf.sdr1);
    const admin = await w.as("admin");
    const lead = await w.as("lead");
    const person = (personId: string) => ({ successor: { type: "person", personId } });

    // Holding both rows lines the two calls up so each takes its first lock at the same moment.
    const together = async (calls: () => Array<Promise<{ status: number; json: any }>>) => {
      const gate = await db.reserve();
      try {
        await gate`begin`;
        await gate`select 1 from people where id in (${member}, ${rep2}) order by id for update`;
        const running = Promise.all(calls());
        await Bun.sleep(400);
        await gate`rollback`;
        return await running;
      } finally {
        gate.release();
      }
    };

    const assigned = await together(() => [
      admin.post(`/v1/handovers/${hm}/assign`, person(rep2)),
      lead.post(`/v1/handovers/${hr}/assign`, person(member)),
    ]);
    expect(assigned.map((r) => [r.status, r.json?.code ?? null])).toEqual([[200, null], [200, null]]);

    const memberC = await w.as("member");
    const rep2C = await w.as("rep2");
    const accepted = await together(() => [rep2C.post(`/v1/handovers/${hm}/accept`, {}), memberC.post(`/v1/handovers/${hr}/accept`, {})]);
    expect(accepted.map((r) => r.status)).toEqual([200, 200]);
    const [n] = await db`select count(*)::int as n from handovers where id in (${hm}, ${hr}) and accepted_at is not null`;
    expect(n!.n).toBe(2);
  });
});
