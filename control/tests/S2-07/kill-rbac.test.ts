// S2-07 KILL, RBAC, AUDIT: kill switches at tenant, person and workflow scope block approval and execution and follow
// the API.md clearing rules; only role-policy approvers approve and see item fields (ADR 0111 §6), every field view is
// audited; approve, reject, release, kill and trip leave audit events on a valid chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import { verifyChain } from "../../src/audit/audit.ts";
import { itemRef } from "../../src/modules/broker/stage1.ts";
import { approveHttp, approveToken, auditActions, client, email, items, overnightPolicy, overnightRun, propose, proposeOk, setRolePolicy, tx, WF, WF2, world, type World } from "./setup.ts";

let w: World;
let n = 0;
const to = () => `k${++n}@fund.com`;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const kill = async (who: Parameters<typeof client>[1], scope: string, targetId: string | null, reason = "stop") =>
  (await client(w, who)).post("/v1/kill-switches", { scope, targetId, reason });
const clear = async (who: Parameters<typeof client>[1], scope: string, targetId: string | null) =>
  (await client(w, who)).del(`/v1/kill-switches/${scope}/${targetId ?? "null"}`);

describe("S2-07 kill switches", () => {
  test("KILL: tenant scope blocks approval (409 kill_switch_active) until an owner clears it", async () => {
    const hash = await proposeOk(w, [email(to())]);
    expect((await kill("owner", "tenant", null)).status).toBe(201);
    const r = await approveHttp(w, "member", hash);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("kill_switch_active");
    // Admin cannot clear a tenant switch an owner set.
    expect((await clear("admin", "tenant", null)).status).toBe(403);
    expect((await clear("owner", "tenant", null)).status).toBe(200);
    expect((await approveHttp(w, "member", hash)).status).toBe(200);
  });

  test("KILL: an admin's tenant switch is cleared by an admin; a second active switch on the same target is 409", async () => {
    expect((await kill("admin", "tenant", null)).status).toBe(201);
    expect((await kill("owner", "tenant", null)).status).toBe(409);
    expect((await clear("admin", "tenant", null)).status).toBe(200);
    expect((await clear("admin", "tenant", null)).status).toBe(404);
  });

  test("KILL: person scope revokes the unspent token and blocks execution; queued batches stay queued", async () => {
    const member = w.t.people.member.id;
    const approved = await proposeOk(w, [email(to())]);
    const queued = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "member", approved);
    expect((await kill("admin", "person", member)).status).toBe(201);
    const calls = w.composio.calls.length;
    await expect(w.broker.commitApproved(w.t.id, approved, token)).rejects.toThrow();
    expect(w.composio.calls.length).toBe(calls);
    const [t] = await w.h.db.migrator`select revoked_at, revoked_reason from approval_tokens where tenant_id = ${w.t.id} and batch_hash = ${approved}`;
    expect(t!.revoked_reason).toBe("kill switch");
    expect((await items(w, queued))[0]!.state).toBe("pending");
    expect((await approveHttp(w, "lead", queued)).json.error.code).toBe("kill_switch_active");
    expect((await clear("admin", "person", member)).status).toBe(200);
  });

  test("KILL: workflow scope stops items already scheduled into the send window", async () => {
    const pid = await overnightPolicy(w, { workflowId: WF2, sendWindow: { startHour: 8, endHour: 9, days: [1, 2, 3, 4, 5, 6, 7], recipientTimezone: false }, recipients: { emails: ["kw@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false } });
    w.h.clock.t = Math.ceil(w.h.clock.now() / 86400000) * 86400000 + 20 * 3600_000;
    const r = await propose(w, [email("kw@fund.com")], { workflowId: WF2, ...overnightRun(pid) });
    await w.broker.idle();
    const hash = r.ok ? r.batchHash : "";
    expect((await items(w, hash))[0]!.token_id).not.toBeNull();
    expect((await kill("member", "workflow", WF2)).status).toBe(201);
    w.h.clock.advance(13 * 3600_000); // 09:00 next day... inside nothing yet; move into the window
    w.h.clock.t = Math.floor(w.h.clock.now() / 86400000) * 86400000 + 8 * 3600_000;
    const calls = w.composio.calls.length;
    await w.broker.runDue(w.t.id, hash);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
    expect((await clear("member", "workflow", WF2)).status).toBe(200);
  });

  test("KILL: the BrokerPort answers per scope; an unscoped question fails closed", async () => {
    const member = w.t.people.member.id;
    await tx(w, async (t) => {
      expect(await w.h.deps.ports.broker.killSwitchActive(t, { personId: member, workflowId: WF })).toBe(false);
      expect(await w.h.deps.ports.broker.killSwitchActive(t, {})).toBe(true);
    });
    expect((await kill("member", "person", member)).status).toBe(201);
    await tx(w, async (t) => {
      expect(await w.h.deps.ports.broker.killSwitchActive(t, { personId: member })).toBe(true);
      expect(await w.h.deps.ports.broker.killSwitchActive(t, { personId: w.t.people.member2.id })).toBe(false);
      expect(await w.broker.tenantKilled(t)).toBe(false);
    });
    // Set by the member: the member may clear it.
    expect((await clear("member", "person", member)).status).toBe(200);
  });

  test("KILL: a member sets only their own person and workflows, and clears only what they set", async () => {
    const member = w.t.people.member.id;
    expect((await kill("member", "tenant", null)).status).toBe(403);
    expect((await kill("member", "person", w.t.people.member2.id)).status).toBe(404);
    expect((await kill("member", "workflow", "9b6c2f1e-9a3d-4c1b-8e7f-1234567890ab")).status).toBe(404);
    expect((await kill("admin", "person", member)).status).toBe(201);
    expect((await clear("member", "person", member)).status).toBe(403);
    expect((await clear("admin", "person", member)).status).toBe(200);
  });

  test("KILL: a dept lead acts on people of their departments only", async () => {
    expect((await kill("lead", "person", w.t.people.member.id)).status).toBe(201);
    expect((await kill("lead", "person", w.t.people.member2.id)).status).toBe(404);
    expect((await kill("lead", "tenant", null)).status).toBe(403);
    expect((await clear("lead", "person", w.t.people.member.id)).status).toBe(200);
    expect((await (await client(w, "auditor")).post("/v1/kill-switches", { scope: "tenant", targetId: null, reason: "x" })).status).toBe(403);
  });

  test("KILL: the list shows tenant switches to everyone and person switches by scope", async () => {
    expect((await kill("admin", "person", w.t.people.member2.id, "finance pause")).status).toBe(201);
    const mine = await (await client(w, "member")).get("/v1/kill-switches");
    expect(mine.status).toBe(200);
    expect(mine.json.items.some((k: { targetId: string }) => k.targetId === w.t.people.member2.id)).toBe(false);
    const all = await (await client(w, "auditor")).get("/v1/kill-switches?limit=200");
    expect(all.json.items.some((k: { targetId: string; active: boolean }) => k.targetId === w.t.people.member2.id && k.active)).toBe(true);
    expect((await clear("admin", "person", w.t.people.member2.id)).status).toBe(200);
    const other = await (await client(w, "admin", w.h.b)).get("/v1/kill-switches");
    expect(other.json.items).toEqual([]);
  });

  test("KILL: revokeTokensOf / stopRunsFor revoke a person's unspent approvals and pause their policies", async () => {
    const hash = await proposeOk(w, [email(to())]);
    await approveToken(w, "member", hash);
    const pid = await overnightPolicy(w);
    const stopped = await tx(w, (t) => w.broker.stopRunsFor(t, w.t.people.member.id));
    expect(stopped.tokens).toBeGreaterThanOrEqual(1);
    expect(stopped.policies).toBeGreaterThanOrEqual(1);
    const [p] = await w.h.db.migrator`select state from overnight_policies where id = ${pid}`;
    expect(p!.state).toBe("paused");
    expect((await items(w, hash))[0]!.token_id).toBeNull();
    expect(await tx(w, (t) => w.h.deps.ports.broker.revokeTokensOf(t, w.t.people.member.id))).toBe(0);
  });
});

describe("S2-07 approvers and item visibility", () => {
  test("RBAC: runner and the department's lead approve; owner and admin are not approvers; another member sees nothing", async () => {
    const a = await proposeOk(w, [email(to())]);
    const b = await proposeOk(w, [email(to())]);
    expect((await approveHttp(w, "member", a)).status).toBe(200);
    expect((await approveHttp(w, "lead", b)).status).toBe(200);
    const c = await proposeOk(w, [email(to())]);
    const owner = await approveHttp(w, "owner", c);
    expect(owner.status).toBe(403);
    expect(owner.json.error.message).toBe("You are not an approver for this batch");
    expect((await approveHttp(w, "admin", c)).status).toBe(403);
    expect((await approveHttp(w, "member2", c)).status).toBe(404);
    expect((await approveHttp(w, "auditor", c)).status).toBe(403);
    expect((await (await client(w, "member", w.h.b)).post(`/v1/batches/${c}/approve`, { batchHash: c, itemKeys: null, edits: [] })).status).toBe(404);
  });

  test("RBAC: approvers = dept_lead: the runner may not approve their own batch", async () => {
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { approvers: "dept_lead" });
    try {
      const hash = await proposeOk(w, [email(to())]);
      expect((await approveHttp(w, "member", hash)).status).toBe(403);
      expect((await approveHttp(w, "lead", hash)).status).toBe(200);
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });

  test("RBAC: approvers = runner: the lead sees the batch but has no approve and no fields", async () => {
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { approvers: "runner" });
    try {
      const r = to();
      const hash = await proposeOk(w, [email(r)]);
      expect((await approveHttp(w, "lead", hash)).status).toBe(403);
      const seen = await (await client(w, "lead")).get(`/v1/batches/${hash}`);
      expect(seen.status).toBe(200);
      expect(seen.json.items[0].fields).toEqual([]);
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });

  test("RBAC: owner and admin see count, workflow and state but no recipients or bodies (ADR 0111 §6)", async () => {
    const r = to();
    const hash = await proposeOk(w, [email(r, "Secret subject", "Secret body")]);
    for (const who of ["owner", "admin"] as const) {
      const g = await (await client(w, who)).get(`/v1/batches/${hash}`);
      expect(g.status).toBe(200);
      expect(g.json).toMatchObject({ batchHash: hash, workflowId: WF, state: "pending" });
      expect(g.json.items).toHaveLength(1);
      expect(g.json.items[0].fields).toEqual([]);
      expect(g.json.items[0].key).toBe(itemRef(WF, r));
      expect(JSON.stringify(g.json)).not.toContain(r);
      expect(JSON.stringify(g.json)).not.toContain("Secret");
    }
    expect((await (await client(w, "auditor")).get(`/v1/batches/${hash}`)).status).toBe(403);
    expect((await (await client(w, "member2")).get(`/v1/batches/${hash}`)).status).toBe(404);
    const runner = await (await client(w, "member")).get(`/v1/batches/${hash}`);
    expect(runner.json.items[0].fields).toEqual(email(r, "Secret subject", "Secret body").fields);
  });

  test("RBAC: every field view is audited; a view without fields is not a field view", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const count = async () =>
      Number((await w.h.db.migrator`select count(*)::int as n from audit_events where tenant_id = ${w.t.id} and action = 'batch.fields_viewed'
        and detail->'batches' ? ${hash}`)[0]!.n);
    await (await client(w, "owner")).get(`/v1/batches/${hash}`);
    expect(await count()).toBe(0);
    await (await client(w, "lead")).get(`/v1/batches/${hash}`);
    expect(await count()).toBe(1);
    await (await client(w, "member")).get(`/v1/batches?state=pending`);
    expect(await count()).toBe(2);
    const [e] = await w.h.db.migrator`select actor_id from audit_events where tenant_id = ${w.t.id} and action = 'batch.fields_viewed'
      and resource_id = ${hash}`;
    expect(e!.actor_id).toBe(w.t.people.lead.id);
  });

  test("RBAC: GET /v1/batches lists only batches I may approve", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const has = async (who: Parameters<typeof client>[1]) =>
      ((await (await client(w, who)).get("/v1/batches?state=pending&limit=200")).json.items as Array<{ batchHash: string }>).some((b) => b.batchHash === hash);
    expect(await has("member")).toBe(true);
    expect(await has("lead")).toBe(true);
    expect(await has("owner")).toBe(false);
    expect(await has("admin")).toBe(false);
    expect(await has("member2")).toBe(false);
    expect((await (await client(w, "auditor")).get("/v1/batches")).status).toBe(403);
    expect((await (await client(w, "member")).get("/v1/batches?state=bogus")).status).toBe(400);
  });

  test("RBAC: reject is for approvers only", async () => {
    const hash = await proposeOk(w, [email(to())]);
    expect((await (await client(w, "owner")).post(`/v1/batches/${hash}/reject`, { reason: "no" })).status).toBe(403);
    expect((await (await client(w, "member2")).post(`/v1/batches/${hash}/reject`, { reason: "no" })).status).toBe(404);
    expect((await (await client(w, "lead")).post(`/v1/batches/${hash}/reject`, { reason: "no" })).status).toBe(200);
  });
});

describe("S2-07 audit", () => {
  test("AUDIT: approve, reject, release, kill and trip events are written on a valid chain", async () => {
    const a = await proposeOk(w, [email(to())]);
    await approveHttp(w, "member", a);
    const b = await proposeOk(w, [email(to())]);
    await (await client(w, "member")).post(`/v1/batches/${b}/reject`, { reason: "wrong week" });
    const r = to();
    const c = await proposeOk(w, [email(r)]);
    w.composio.mode = "throw";
    try {
      await approveHttp(w, "member", c);
    } finally {
      w.composio.mode = "ok";
    }
    await (await client(w, "member")).post(`/v1/batches/${c}/release`, { keys: [r] });
    await kill("owner", "workflow", WF);
    await clear("owner", "workflow", WF);
    const pid = await overnightPolicy(w, { workflowId: "2b6c2f1e-9a3d-4c1b-8e7f-1234567890ab" });
    await w.broker.reportNightSignals(w.t.id, pid, { negativeReplies: 9 });
    const actions = await auditActions(w);
    for (const x of ["batch.propose", "batch.approve", "batch.reject", "batch.release", "batch.item_sent", "batch.item_unknown", "kill.set", "kill.clear", "overnight.trip", "overnight.create"]) {
      expect(actions).toContain(x);
    }
    const v = await withTenant(w.h.db.app, { tenantId: w.t.id }, (t) => verifyChain(t));
    expect(v).toEqual({ ok: true });
    // The events read back through the audit log validate against audit-event.schema.json (responses are validated).
    const log = await (await client(w, "auditor")).get("/v1/audit-log?limit=200");
    expect(log.status).toBe(200);
  });

  test("AUDIT: the reject event names the actor and the reason, the approve event the approver kind", async () => {
    const hash = await proposeOk(w, [email(to())]);
    await (await client(w, "lead")).post(`/v1/batches/${hash}/reject`, { reason: "tone is off" });
    const [e] = await w.h.db.migrator`select actor_id, actor_role, subject_person_id, detail from audit_events
      where tenant_id = ${w.t.id} and action = 'batch.reject' and resource_id = ${hash}`;
    expect(e).toMatchObject({ actor_id: w.t.people.lead.id, actor_role: "dept_lead", subject_person_id: w.t.people.member.id, detail: { reason: "tone is off" } });
    const h2 = await proposeOk(w, [email(to())]);
    await approveHttp(w, "member", h2);
    const [ap] = await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action = 'batch.approve' and resource_id = ${h2}`;
    expect(ap!.detail).toMatchObject({ approverKind: "person", items: 1, edited: false });
  });

  test("AUDIT: audit events carry no recipient, subject or body", async () => {
    const rows = await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action like 'batch.%'`;
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/k\d+@fund\.com/);
    expect(text).not.toContain("Seed round follow-up");
  });
});
