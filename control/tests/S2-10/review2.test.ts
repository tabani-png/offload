// Codex review of 7f2712f (PR #16): a hung workers service never holds the freeze open; two owners offboarding each
// other cannot both pass the last-owner check.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSession } from "../helpers/seed.ts";
import { stateOf, today, world, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  w.workers.release();
  await w.close();
});

describe("FREEZE", () => {
  test("FREEZE: a hung workers service does not hold the freeze open: revocations commit at once, the pause stays pending with a timeout", async () => {
    const m2 = w.t.people.member2.id;
    w.continuity.pauseTimeoutMs = 300;
    w.workers.hang = true;
    try {
      const req = (await w.as("admin")).post(`/v1/people/${m2}/offboard`, { effectiveOn: today(w), reason: "admin", note: "" });
      const r = await Promise.race([req, Bun.sleep(3000).then(() => null)]);
      expect(r?.status).toBe(200);
      expect(await stateOf(w, m2)).toBe("frozen");
      const [s] = await w.h.db.migrator`select count(*)::int as n from sessions where person_id = ${m2} and revoked_at is null`;
      expect(s!.n).toBe(0);
      // The after-commit pause times out instead of hanging; it stays pending for the sweep.
      const idle = await Promise.race([w.continuity.idle().then(() => true), Bun.sleep(3000).then(() => false)]);
      expect(idle).toBe(true);
      const [o] = await w.h.db.migrator`select pause_pending from offboardings where person_id = ${m2}`;
      expect(o!.pause_pending).toBe(true);
    } finally {
      w.workers.release();
    }
    await w.continuity.sweep(w.t.id);
    const [p] = await w.h.db.migrator`select pause_pending from offboardings where person_id = ${m2}`;
    expect(p!.pause_pending).toBe(false);
  });
});

describe("STATES", () => {
  test("STATES: two owners offboarding each other at once: one wins, the other is refused as the last owner", async () => {
    const db = w.h.db.migrator;
    const a = w.t.people.owner.id;
    const [row] = await db`insert into people (tenant_id, email, display_name, access_role, department_id, jurisdiction, source)
      values (${w.t.id}, ${`owner2@${w.t.id.slice(0, 8)}.example.com`}, 'owner2', 'owner', ${w.t.departments.sales}, 'CA-ON', 'manual') returning id`;
    const b = row!.id as string;
    const credA = await createSession(db, w.t.id, a, w.h.clock.now());
    const credB = await createSession(db, w.t.id, b, w.h.clock.now());
    const post = (cred: { cookie: string; csrf: string }, target: string) =>
      w.h.request("POST", `/v1/people/${target}/offboard`, {
        body: { effectiveOn: today(w), reason: "admin", note: "" },
        headers: { Cookie: cred.cookie, "X-CSRF-Token": cred.csrf },
      });
    // Gate: hold both owners' rows so both requests are inside their transactions before either can freeze.
    const gate = await db.reserve();
    let results: number[] = [];
    try {
      await gate`begin`;
      await gate`select 1 from people where id in (${a}, ${b}) order by id for update`;
      const both = Promise.all([post(credA, b), post(credB, a)]);
      await Bun.sleep(500);
      await gate`rollback`;
      results = (await both).map((r) => r.status).sort();
    } finally {
      gate.release();
    }
    await w.continuity.idle();
    expect(results).toEqual([200, 409]);
    const [n] = await db`select count(*)::int as n from people where tenant_id = ${w.t.id} and access_role = 'owner' and state in ('active', 'leaving')`;
    expect(n!.n).toBe(1);
  });
});
