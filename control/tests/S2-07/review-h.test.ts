// S2-07 follow-ups (independent reviewer's P3 list after PR #12): kill-switch clear rights, a person kill covers the
// approver, audit events for every state change in the send path, the night counter upsert and the full connection
// fingerprint. Every test here failed on origin/main (bf8b5c9).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { approveToken, auditActions, client, email, items, overnightPolicy, overnightRun, propose, proposeOk, tx, WF, WF2, WF3, world, type World } from "./setup.ts";

let w: World;
const DAY = 24 * 3600_000;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
let n = 0;
const to = () => `h${++n}@fund.com`;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});
const db = () => w.h.db.migrator;
afterEach(async () => {
  // No switch outlives its test.
  await db()`update kill_switches set active = false, cleared_at = now() where tenant_id = ${w.t.id} and active`;
});

const kill = async (who: Parameters<typeof client>[1], scope: string, targetId: string | null) =>
  (await client(w, who)).post("/v1/kill-switches", { scope, targetId, reason: "stop" });
const clear = async (who: Parameters<typeof client>[1], scope: string, targetId: string | null) =>
  (await client(w, who)).del(`/v1/kill-switches/${scope}/${targetId ?? "null"}`);
/** Audit actions written since `from`. */
const since = async (from: number) => (await auditActions(w)).slice(from);

describe("S2-07 follow-up 1: who may clear a kill switch", () => {
  test("KILL: nobody clears a switch that targets themselves (dept lead, member, admin); another admin or owner does", async () => {
    for (const who of ["lead", "member", "admin"] as const) {
      const me = w.t.people[who].id;
      expect((await kill(who, "person", me)).status).toBe(201);
      expect((await clear(who, "person", me)).status).toBe(403);
      expect((await clear("owner", "person", me)).status).toBe(200);
    }
  });

  test("KILL: a switch an owner or admin set is cleared only by an owner or admin", async () => {
    expect((await kill("admin", "workflow", WF)).status).toBe(201);
    expect((await clear("lead", "workflow", WF)).status).toBe(403);
    expect((await clear("owner", "workflow", WF)).status).toBe(200);
  });

  test("KILL: a dept lead clears a switch a member of their department set", async () => {
    expect((await kill("member", "workflow", WF)).status).toBe(201);
    expect((await clear("lead", "workflow", WF)).status).toBe(200);
  });
});

describe("S2-07 follow-up 2: a person kill covers the approver", () => {
  test("KILL: a person switch on the approver revokes their unspent approval", async () => {
    const hash = await proposeOk(w, [email(to())]);
    await approveToken(w, "lead", hash);
    expect((await kill("admin", "person", w.t.people.lead.id)).status).toBe(201);
    const [t] = await db()`select revoked_at from approval_tokens where tenant_id = ${w.t.id} and batch_hash = ${hash}`;
    expect(t!.revoked_at).not.toBeNull();
    expect((await items(w, hash))[0]!.token_id).toBeNull();
  });

  test("ITEM: execute refuses an approval whose approver is killed (switch set below the API, no revocation)", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "lead", hash);
    await db()`insert into kill_switches (tenant_id, scope, target_id, set_by, set_by_role, set_at, reason)
      values (${w.t.id}, 'person', ${w.t.people.lead.id}, ${w.t.people.admin.id}, 'admin', now(), 'approver stopped')`;
    const calls = w.composio.calls.length;
    await w.broker.commitApproved(w.t.id, hash, token).catch(() => undefined);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });
});

const freshEvening = () => {
  w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 20 * 3600_000;
};
const narrowWindow = { startHour: 8, endHour: 9, days: ALL_DAYS, recipientTimezone: false };
async function scheduledByPolicy(addr: string, workflowId: string) {
  freshEvening();
  const pid = await overnightPolicy(w, { workflowId, sendWindow: narrowWindow, recipients: { emails: [addr], domains: [], repliesToThreadsStartedByIdentity: false } });
  const r = await propose(w, [email(addr)], { workflowId, ...overnightRun(pid) });
  if (!r.ok || r.autoApproved !== 1) throw new Error(`not auto-approved: ${JSON.stringify(r)}`);
  await w.broker.idle();
  const [it] = await items(w, r.batchHash);
  return { pid, hash: r.batchHash, at: it!.scheduled_for!.getTime() };
}

describe("S2-07 follow-up 3: every state change in the send path is audited", () => {
  test("AUDIT: reconcile marking a stale send unknown writes batch.item_reconciled", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "member", hash);
    w.composio.mode = "hang";
    const running = w.broker.commitApproved(w.t.id, hash, token);
    for (let i = 0; i < 200 && (await items(w, hash))[0]!.state !== "sending"; i++) await Bun.sleep(5);
    w.composio.mode = "ok";
    const from = (await auditActions(w)).length;
    w.h.clock.advance(11 * 60_000);
    expect(await w.broker.reconcile(w.t.id)).toBe(1);
    expect(await since(from)).toContain("batch.item_reconciled");
    w.composio.finishHung();
    await running;
  });

  test("AUDIT: revoking a batch's approvals writes batch.tokens_revoked", async () => {
    const hash = await proposeOk(w, [email(to())]);
    await approveToken(w, "lead", hash);
    const from = (await auditActions(w)).length;
    await tx(w, async (t) => {
      await w.broker.revokeForKill(t, "workflow", WF, "kill switch");
      // revokeForKill queues its events; its caller writes them after its last row lock (the kill route does).
      await w.broker.flushAudits(t);
    });
    expect(await since(from)).toContain("batch.tokens_revoked");
  });

  test("AUDIT: an expired approval swept from its items writes batch.tokens_swept", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const { token } = await approveToken(w, "lead", hash);
    w.h.clock.advance(25 * 3600_000);
    const from = (await auditActions(w)).length;
    // The commit of an expired approval refuses (409) after sweeping it from its items, and that sweep is committed.
    await w.broker.commitApproved(w.t.id, hash, token).catch(() => undefined);
    expect((await items(w, hash))[0]!.token_id).toBeNull();
    expect(await since(from)).toContain("batch.tokens_swept");
  });

  test("AUDIT: execute taking back a paused policy's approvals writes batch.policy_unlinked", async () => {
    const { pid, hash, at } = await scheduledByPolicy("h-paused@fund.com", WF2);
    await db()`update overnight_policies set state = 'paused' where tenant_id = ${w.t.id} and id = ${pid}`;
    w.h.clock.t = at;
    const from = (await auditActions(w)).length;
    await w.broker.runDue(w.t.id, hash);
    expect((await items(w, hash))[0]!.token_id).toBeNull();
    expect(await since(from)).toContain("batch.policy_unlinked");
  });
});

describe("S2-07 follow-up 4 and 5: night counter upsert, full connection fingerprint", () => {
  test("OVERNIGHT: a send counts even when the night's counter row is missing", async () => {
    const { pid, hash, at } = await scheduledByPolicy("h-count@fund.com", WF3);
    await db()`delete from overnight_counters where tenant_id = ${w.t.id} and policy_id = ${pid}`;
    w.h.clock.t = at;
    await w.broker.runDue(w.t.id, hash);
    expect((await items(w, hash))[0]!.state).toBe("sent");
    const [c] = await db()`select coalesce(sum(sends), 0)::int as n from overnight_counters where tenant_id = ${w.t.id} and policy_id = ${pid}`;
    expect(c!.n).toBe(1);
  });

  test("OVERNIGHT: binding the commit connection to a job role after the policy saw it trips the breaker", async () => {
    freshEvening();
    const role = { identity: { type: "role_identity" as const, id: w.conns.roleIdentity }, connectionId: w.t.connections.company };
    const pid = await overnightPolicy(w, { recipients: { emails: ["h-fp1@fund.com", "h-fp2@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false } });
    const first = await propose(w, [email("h-fp1@fund.com")], { ...role, ...overnightRun(pid) });
    expect(first).toMatchObject({ ok: true });
    await w.broker.idle();
    await db()`update connections set job_role_id = ${w.t.jobRoles.sdr} where tenant_id = ${w.t.id} and id = ${w.t.connections.company}`;
    try {
      const r = await propose(w, [email("h-fp2@fund.com")], { ...role, ...overnightRun(pid) });
      expect(r).toMatchObject({ ok: true, overnightEvaluation: { result: "trip", reason: "connection_auth_change" } });
    } finally {
      await db()`update connections set job_role_id = null where tenant_id = ${w.t.id} and id = ${w.t.connections.company}`;
    }
  });
});
