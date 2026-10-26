// S2-07 POLICY and LINKEDIN: role policies decide what may be proposed; a personal LinkedIn (or personal-forbidden)
// binding is refused at propose and again at execute.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { approveHttp, asRole, client, email, items, propose, proposeOk, world, type World } from "./setup.ts";

let w: World;
let n = 0;
const to = () => `p${++n}@fund.com`;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const rolePolicyBody = (jobRoleId: string, over: Record<string, unknown> = {}) => ({
  jobRoleId,
  allowedCapabilities: ["mail.send", "crm.note"],
  approvers: "runner_or_dept_lead",
  sessionBudgetCents: 750,
  dailyBudgetCents: 4200,
  maxItemsPerBatch: 3,
  models: { design: "claude-opus-5-5", steps: "claude-sonnet-5-5" },
  updatedAt: 0,
  updatedBy: "00000000-0000-4000-8000-000000000000",
  ...over,
});

describe("S2-07 role policies", () => {
  test("POLICY: budgets, approvers and models are stored and returned; updatedAt/updatedBy are the server's", async () => {
    const admin = await client(w, "admin");
    const put = await admin.put(`/v1/policies/job-roles/${w.t.jobRoles.ap}`, rolePolicyBody(w.t.jobRoles.ap));
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ sessionBudgetCents: 750, dailyBudgetCents: 4200, maxItemsPerBatch: 3, updatedBy: w.t.people.admin.id, updatedAt: w.h.clock.now() });
    const get = await (await client(w, "auditor")).get(`/v1/policies/job-roles/${w.t.jobRoles.ap}`);
    expect(get.status).toBe(200);
    expect(get.json).toEqual(put.json);
  });

  test("POLICY: the body's jobRoleId must be the path's; unknown fields are 400", async () => {
    const admin = await client(w, "admin");
    expect((await admin.put(`/v1/policies/job-roles/${w.t.jobRoles.ap}`, rolePolicyBody(w.t.jobRoles.sdr))).status).toBe(400);
    expect((await admin.put(`/v1/policies/job-roles/${w.t.jobRoles.ap}`, { ...rolePolicyBody(w.t.jobRoles.ap), extra: 1 })).status).toBe(400);
  });

  test("POLICY: scope: a member reads only job roles they hold; a lead writes only their departments; a member never writes", async () => {
    const member = await client(w, "member");
    expect((await member.get(`/v1/policies/job-roles/${w.t.jobRoles.sdr}`)).status).toBe(200);
    expect((await member.get(`/v1/policies/job-roles/${w.t.jobRoles.ap}`)).status).toBe(404);
    expect((await member.put(`/v1/policies/job-roles/${w.t.jobRoles.sdr}`, rolePolicyBody(w.t.jobRoles.sdr))).status).toBe(403);
    const lead = await client(w, "lead");
    expect((await lead.put(`/v1/policies/job-roles/${w.t.jobRoles.ap}`, rolePolicyBody(w.t.jobRoles.ap))).status).toBe(404);
    const other = await client(w, "member", w.h.b);
    expect((await other.get(`/v1/policies/job-roles/${w.t.jobRoles.sdr}`)).status).toBe(404);
  });

  test("POLICY: a capability outside allowedCapabilities is rejected at propose", async () => {
    const r = await propose(w, [{ ...email(to()), capability: "ticket.reply" }]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(!r.ok && r.message).toContain("ticket.reply is not allowed");
  });

  test("POLICY: more items than maxItemsPerBatch is rejected", async () => {
    const r = await propose(w, [email(to()), email(to()), email(to()), email(to()), email(to()), email(to())]);
    expect(r).toMatchObject({ ok: false, code: "validation_failed" });
  });

  test("POLICY: a job role without a role policy commits nothing", async () => {
    const [jr] = await w.h.db.migrator`insert into job_roles (tenant_id, name, department_id) values (${w.t.id}, 'Fresh', ${w.t.departments.sales}) returning id`;
    const r2 = await propose(w, [email(to())], { jobRoleId: jr!.id as string });
    expect(r2).toMatchObject({ ok: false, code: "forbidden" });
    expect(!r2.ok && r2.message).toContain("no role policy");
  });

  test("POLICY: an allowed capability the connection cannot express is refused (no allowlisted tool)", async () => {
    const r = await propose(w, [{ key: "x@fund.com", capability: "chat.post", fields: [["to", "x@fund.com"], ["subject", ""], ["body", "hi"], ["verb", "post_message"], ["channel", "C1"]] }]);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("POLICY: an item that the capability's schema cannot hold is refused (Instantly lead without a campaign)", async () => {
    const r = await propose(w, [{ key: "y@fund.com", capability: "outreach.add_lead", fields: [["to", "y@fund.com"], ["subject", ""], ["body", ""], ["verb", "add_to_campaign"]] }], asRole(w.conns.roleOrg, w.conns.org));
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("POLICY: a read-only vault connection never commits; a personal connection sends only as its owner", async () => {
    expect(await propose(w, [email(to())], { connectionId: w.conns.vault })).toMatchObject({ ok: false, code: "forbidden_binding" });
    const lead = w.t.people.lead.id;
    expect(await propose(w, [email(to())], { identity: { type: "person", id: lead }, runnerPersonId: lead })).toMatchObject({ ok: false, code: "forbidden_binding" });
    expect(await propose(w, [email(to())], { identity: { type: "person", id: lead } })).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("POLICY: a role identity sends only through its own company connection", async () => {
    const ok = await propose(w, [email(to())], { identity: { type: "role_identity", id: w.conns.roleIdentity }, connectionId: w.t.connections.company });
    expect(ok.ok).toBe(true);
    const bad = await propose(w, [email(to())], { identity: { type: "role_identity", id: w.conns.roleIdentity }, connectionId: w.conns.org });
    expect(bad).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("POLICY: a frozen person's run proposes nothing", async () => {
    await w.h.db.migrator`update people set state = 'frozen' where id = ${w.t.people.member2.id}`;
    const m2 = w.t.people.member2.id;
    const r = await propose(w, [email(to())], { identity: { type: "person", id: m2 }, runnerPersonId: m2, connectionId: w.t.connections.company });
    expect(r).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("POLICY: the same run proposing the same items gets the same pending batch back (idempotent)", async () => {
    const it = [email(to())];
    const runId = "01JBT0000000000000000000AA";
    const a = await proposeOk(w, it, { runId });
    const b = await propose(w, it, { runId });
    expect(b).toMatchObject({ ok: true, batchHash: a, state: "pending" });
    const c = await propose(w, it);
    expect(c).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("S2-07 LinkedIn and forbidden bindings", () => {
  test("LINKEDIN: any commit through linkedin_personal is rejected at propose", async () => {
    const r = await propose(w, [email(to())], { connectionId: w.conns.memberLinkedin });
    expect(r).toMatchObject({ ok: false, code: "forbidden_binding" });
    expect(!r.ok && r.message).toContain("LinkedIn");
    const [row] = await w.h.db.migrator`select count(*)::int as n from batches where tenant_id = ${w.t.id} and connection_id = ${w.conns.memberLinkedin}`;
    expect(row!.n).toBe(0);
  });

  test("LINKEDIN: a connection that became linkedin_personal after approval is refused at execute (nothing called)", async () => {
    const [c] = await w.h.db.migrator`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
      values (${w.t.id}, 'gmail', 'personal-allowed', 'switch', ${w.t.people.member.id}, 'composio', 'acct_switch') returning id`;
    const r = to();
    const hash = await proposeOk(w, [email(r)], { connectionId: c!.id as string });
    await w.h.db.migrator`update connections set kind = 'linkedin_personal' where id = ${c!.id}`;
    const before = w.composio.calls.length;
    expect((await approveHttp(w, "member", hash)).status).toBe(200);
    expect(w.composio.calls.length).toBe(before);
    const [it] = await items(w, hash);
    expect(it!.state).toBe("failed_before_send");
    expect(it!.error).toContain("LinkedIn");
  });

  test("LINKEDIN: a personal-forbidden connection is refused", async () => {
    expect(await propose(w, [email(to())], { connectionId: w.conns.forbidden })).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("LINKEDIN: rejections are audited without content", async () => {
    const [e] = await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action = 'batch.propose_rejected'
      and detail->>'code' = 'forbidden_binding' order by seq desc limit 1`;
    expect(e).toBeDefined();
    expect(JSON.stringify(e!.detail)).not.toContain("@fund.com");
  });
});
