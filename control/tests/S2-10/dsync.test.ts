import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { audits, handoversOf, stateOf, world, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.close());

const user = (dirId: string, email: string, state = "active") => ({
  id: dirId,
  directory_id: w.t.directoryId,
  organization_id: w.t.workosOrgId,
  emails: [{ primary: true, value: email }],
  first_name: "Dana",
  last_name: "Lee",
  state,
});

async function deliver(event: string, data: Record<string, unknown>) {
  const hook = await w.h.workos.webhook(event, data);
  const r = await w.h.request("POST", "/webhooks/workos", { body: hook.body, headers: hook.headers });
  await w.continuity.idle();
  return r;
}

describe("DSYNC", () => {
  test("DSYNC: a directory deactivation (S2-01 webhook) ends in a frozen person with every continuity effect", async () => {
    const member = w.t.people.member.id;
    await w.as("member");
    expect((await deliver("dsync.user.updated", user("dir_member", w.t.people.member.email))).status).toBe(204);
    expect(await stateOf(w, member)).toBe("active");
    expect((await deliver("dsync.user.updated", user("dir_member", w.t.people.member.email, "inactive"))).status).toBe(204);
    expect(await stateOf(w, member)).toBe("frozen");
    expect((await handoversOf(w, member)).map((h) => h.workflow_id).sort()).toEqual([w.wf.sdr1, w.wf.sdr2].sort());
    const [o] = await w.h.db.migrator`select state, reason, pause_pending from offboardings where person_id = ${member}`;
    expect(o).toEqual({ state: "frozen", reason: "directory_deactivated", pause_pending: false });
    const [li] = await w.h.db.migrator`select count(*)::int as n from connections where id = ${w.personal.linkedin}`;
    expect(li!.n).toBe(0);
    const [s] = await w.h.db.migrator`select count(*)::int as n from sessions where person_id = ${member} and revoked_at is null`;
    expect(s!.n).toBe(0);
    const [ev] = (await audits(w, "person.freeze")).filter((e) => e.subject_person_id === member);
    expect(ev).toMatchObject({ actor_type: "system", detail: { source: "directory", detail: "inactive", handoversOpened: 2 } });
    expect(w.workers.afterCommit(member).length).toBeGreaterThanOrEqual(1);
  });

  test("DSYNC: a redelivered deactivation changes nothing more", async () => {
    const before = await w.h.db.migrator`select count(*)::int as n from audit_events where action = 'person.freeze'`;
    await deliver("dsync.user.updated", user("dir_member", w.t.people.member.email, "inactive"));
    await deliver("dsync.user.deleted", user("dir_member", w.t.people.member.email, "inactive"));
    const after = await w.h.db.migrator`select count(*)::int as n from audit_events where action = 'person.freeze'`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await handoversOf(w, w.t.people.member.id)).length).toBe(2);
  });

  test("DSYNC: a failing freeze fails the webhook (5xx), leaves the person active, and WorkOS's retry applies it", async () => {
    const m2 = w.t.people.member2.id;
    await deliver("dsync.user.updated", user("dir_m2", w.t.people.member2.email));
    await w.h.db.migrator.unsafe(`create function s210_refuse() returns trigger language plpgsql as $$
      begin raise exception 'hand-over store unavailable'; end $$;
      create trigger s210_refuse before insert on handovers for each row execute function s210_refuse()`);
    const evt = user("dir_m2", w.t.people.member2.email, "inactive");
    const hook = await w.h.workos.webhook("dsync.user.updated", evt);
    try {
      const r = await w.h.request("POST", "/webhooks/workos", { body: hook.body, headers: hook.headers });
      expect(r.status).toBe(500);
    } finally {
      await w.h.db.migrator.unsafe("drop trigger s210_refuse on handovers; drop function s210_refuse()");
    }
    await w.continuity.idle();
    expect(await stateOf(w, m2)).toBe("active");
    const retry = await w.h.request("POST", "/webhooks/workos", { body: hook.body, headers: hook.headers });
    await w.continuity.idle();
    expect(retry.status).toBe(204);
    expect(await stateOf(w, m2)).toBe("frozen");
    expect((await handoversOf(w, m2)).map((h) => h.workflow_id)).toEqual([w.wf.ap]);
  });
});
