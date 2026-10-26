import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { audits, email, handoversOf, offboard, promote, run, share, to, world, type World } from "./world.ts";

let w: World;
let member: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
});
afterAll(() => w.close());

describe("LINKEDIN", () => {
  test("LINKEDIN: the leaver's personal LinkedIn connection is deleted on freeze, listed on the hand-over, audited", async () => {
    expect((await offboard(w, member)).status).toBe(200);
    const [c] = await w.h.db.migrator`select count(*)::int as n from connections where id = ${w.personal.linkedin}`;
    expect(c!.n).toBe(0);
    const [rc] = await w.h.db.migrator`select kind, mode from removed_connections where connection_id = ${w.personal.linkedin}`;
    expect(rc).toEqual({ kind: "linkedin_personal", mode: "deleted" });
    for (const h of await handoversOf(w, member)) expect(h.removed_connections).toContain(w.personal.linkedin);
    const ev = (await audits(w, "connection.removed")).find((e) => e.resource_id === w.personal.linkedin);
    expect(ev).toMatchObject({ subject_person_id: member, detail: { kind: "linkedin_personal", mode: "deleted" } });
  });

  test("LINKEDIN: the deleted connection cannot be re-bound to a commit step at promotion", async () => {
    const id = await share(w.h, w.t, w.extra.rep2, "member", "Re-bind attempt");
    const admin = await w.as("admin");
    const r = await admin.post(`/v1/workflows/${id}/promote`, {
      jobRoleId: w.t.jobRoles.sdr,
      departmentId: w.t.departments.sales,
      fromVersion: 1,
      bindings: [{ stepId: "send_intro", connectionId: w.personal.linkedin, disable: false }],
    });
    expect([400, 409]).toContain(r.status);
    const [s] = await w.h.db.migrator`select state from workflows where id = ${id}`;
    expect(s!.state).toBe("proposed");
  });

  test("LINKEDIN: nor in a new version of a role workflow", async () => {
    const admin = await w.as("admin");
    const v1 = (await admin.get(`/v1/workflows/${w.wf.sdr1}/versions/1`)).json;
    const { definitionHash } = await import("../../src/modules/registry/hash.ts");
    const { ulid } = await import("../../src/schema/encoding.ts");
    const { id: _i, kind: _k, createdAt: _c, definitionHash: _h, ...def } = v1;
    def.version = 2;
    def.steps = def.steps.map((s: { id: string; connection: unknown }) =>
      s.id === "send_intro" ? { ...s, connection: { kind: "linkedin_personal", ownership: "personal-forbidden", connectionId: w.personal.linkedin, label: "LinkedIn" } } : s,
    );
    const body = { id: ulid(), kind: "workflow_proposal", createdAt: w.h.clock.now(), ...def, definitionHash: definitionHash(def) };
    const r = await admin.post(`/v1/workflows/${w.wf.sdr1}/versions`, body);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("forbidden_binding");
  });

  test("LINKEDIN: nor used by the broker for a commit", async () => {
    const r = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr2, { type: "person", id: w.extra.rep2 }, w.extra.rep2, w.personal.linkedin), [email(to())]);
    expect(r.ok).toBe(false);
  });

  test("LINKEDIN: a successor's own LinkedIn is never bound to a commit step either", async () => {
    const [c] = await w.h.db.migrator`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
      values (${w.t.id}, 'linkedin_personal', 'personal-allowed', 'Rep2 LinkedIn', ${w.extra.rep2}, 'composio', 'acct_rep2_li') returning id`;
    const id = await share(w.h, w.t, w.extra.rep2, "member", "Successor LinkedIn");
    const r = await (await w.as("admin")).post(`/v1/workflows/${id}/promote`, {
      jobRoleId: w.t.jobRoles.sdr,
      departmentId: w.t.departments.sales,
      fromVersion: 1,
      bindings: [{ stepId: "send_intro", connectionId: c!.id, disable: false }],
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("forbidden_binding");
    const p = await w.broker.proposeBatch(w.t.id, run(w, w.wf.sdr2, { type: "person", id: w.extra.rep2 }, w.extra.rep2, c!.id as string), [email(to())]);
    expect(p).toMatchObject({ ok: false });
  });

  test("LINKEDIN: promoting the same proposal with a company connection still works (the rule is narrow)", async () => {
    const id = await share(w.h, w.t, w.extra.rep2, "member", "Fine binding");
    await promote(await w.as("admin"), id, w.t.jobRoles.sdr, w.t.departments.sales, w.t.connections.company);
  });
});
