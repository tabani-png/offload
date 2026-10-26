// S2-07 fix round 2 (PR #12 re-review: Codex P1, security N1-N4, N6, weak test #14). Every test here failed on
// c0f1d4c before its fix (the #14 concurrency test is red with the advisory lock removed). Real broker, real policies
// module, real Postgres; only the Composio runner is in-memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import {
  approveToken,
  client,
  email,
  items,
  overnightPolicy,
  overnightRun,
  propose,
  proposeOk,
  roleWorkflow,
  setRolePolicy,
  TPL,
  WF,
  WF_AP,
  world,
  type World,
} from "./setup.ts";

let w: World;
const DAY = 24 * 3600_000;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const db = () => w.h.db.migrator;
/** 20:00 UTC of a day after every night used so far: outside an 08-09 window, on a fresh night. */
const freshEvening = () => {
  w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 20 * 3600_000;
};
const narrowWindow = { startHour: 8, endHour: 9, days: ALL_DAYS, recipientTimezone: false };
const only = (addr: string) => ({ emails: [addr], domains: [], repliesToThreadsStartedByIdentity: false });
const policyBody = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), workflowId: WF, version: 1, mode: "preapproved", recipients: only("body@fund.com"), templateHash: TPL,
  maxCommitsPerNight: 5, maxPerRecipientPerWeek: 1, sendWindow: narrowWindow, attachmentsAllowed: false,
  budgetCentsPerNight: 100, dryRunNights: 3, dryRunNightsDone: 0,
  circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 2 }, state: "active",
  trippedReason: null, ownerPersonId: w.t.people.member.id, ...over,
});

/** A policy past its dry-run nights that auto-approves one item into tomorrow's 08:00 window. */
async function scheduledLive(addr: string, over: Record<string, unknown> = {}) {
  freshEvening();
  const pid = await overnightPolicy(w, { dryRunNights: 3, sendWindow: narrowWindow, recipients: only(addr), ...over });
  await db()`update overnight_policies set dry_run_nights_done = 3 where tenant_id = ${w.t.id} and id = ${pid}`;
  const r = await propose(w, [email(addr)], overnightRun(pid));
  if (!r.ok || r.autoApproved !== 1) throw new Error(`not auto-approved: ${JSON.stringify(r)}`);
  await w.broker.idle();
  const [it] = await items(w, r.batchHash);
  expect(it!.token_id).not.toBeNull();
  return { pid, hash: r.batchHash, at: it!.scheduled_for!.getTime() };
}

async function sendsNothingAt(hash: string, at: number) {
  const calls = w.composio.calls.length;
  w.h.clock.t = at;
  await w.broker.runDue(w.t.id, hash);
  expect(w.composio.calls.length).toBe(calls);
  expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
}

describe("S2-07 round 2: widening restarts dry runs and takes back approvals (Codex P1)", () => {
  test("OVERNIGHT: a widening-only edit that restarts the dry-run nights unlinks what the policy approved and has not sent", async () => {
    const { pid, hash, at } = await scheduledLive("widen.dry@fund.com");
    const res = await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, {
      recipients: { emails: ["widen.dry@fund.com"], domains: ["wide-open.example"], repliesToThreadsStartedByIdentity: false },
    });
    expect(res.status).toBe(200);
    expect(res.json.dryRunNightsDone).toBe(0);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null, scheduled_for: null });
    await sendsNothingAt(hash, at);
  });

  test("OVERNIGHT: execute refuses a policy approval while the policy is in its dry-run nights (reset behind the API's back)", async () => {
    const { pid, hash, at } = await scheduledLive("dry.db@fund.com");
    await db()`update overnight_policies set dry_run_nights_done = 0 where tenant_id = ${w.t.id} and id = ${pid}`;
    await sendsNothingAt(hash, at);
  });

  test("OVERNIGHT: execute refuses a policy approval on a night marked dry run", async () => {
    const { pid, hash, at } = await scheduledLive("dry.night@fund.com");
    // The send instant's night (local date of t - 12 h, UTC tenant), marked a dry-run night below the API.
    const night = new Date(at - 12 * 3600_000).toISOString().slice(0, 10);
    await db()`insert into overnight_counters (tenant_id, policy_id, night, dry_run, evaluated)
      values (${w.t.id}, ${pid}, ${night}::date, true, true)
      on conflict (tenant_id, policy_id, night) do update set dry_run = true, evaluated = true`;
    await sendsNothingAt(hash, at);
  });
});

describe("S2-07 round 2: who may make a policy preapproved (N1)", () => {
  test("RBAC: under approvers = dept_lead a member cannot create a preapproved policy; their dept lead can", async () => {
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { approvers: "dept_lead" });
    try {
      expect((await (await client(w, "member")).post("/v1/overnight-policies", policyBody())).status).toBe(403);
      expect((await (await client(w, "lead")).post("/v1/overnight-policies", policyBody())).status).toBe(201);
      // drafts_only approves nothing: the member may still keep one.
      expect((await (await client(w, "member")).post("/v1/overnight-policies", policyBody({ mode: "drafts_only" }))).status).toBe(201);
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });

  test("RBAC: under approvers = dept_lead a member cannot switch their policy to preapproved or widen a preapproved one", async () => {
    const drafts = policyBody({ mode: "drafts_only" });
    const live = policyBody();
    expect((await (await client(w, "member")).post("/v1/overnight-policies", drafts)).status).toBe(201);
    expect((await (await client(w, "member")).post("/v1/overnight-policies", live)).status).toBe(201);
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { approvers: "dept_lead" });
    try {
      const member = await client(w, "member");
      expect((await member.patch(`/v1/overnight-policies/${drafts.id}`, { mode: "preapproved" })).status).toBe(403);
      expect((await member.patch(`/v1/overnight-policies/${live.id}`, { maxCommitsPerNight: 50 })).status).toBe(403);
      // Narrowing stays the owner's.
      expect((await member.patch(`/v1/overnight-policies/${live.id}`, { maxCommitsPerNight: 1 })).status).toBe(200);
      expect((await (await client(w, "lead")).patch(`/v1/overnight-policies/${drafts.id}`, { mode: "preapproved" })).status).toBe(200);
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });

  test("POLICY: a policy names a role workflow version in the registry that its owner runs", async () => {
    const admin = await client(w, "admin");
    expect((await admin.post("/v1/overnight-policies", policyBody({ workflowId: crypto.randomUUID() }))).status).toBe(400);
    expect((await admin.post("/v1/overnight-policies", policyBody({ version: 9 }))).status).toBe(400);
    // WF_AP belongs to the finance job role: the sales member does not run it.
    expect((await admin.post("/v1/overnight-policies", policyBody({ workflowId: WF_AP }))).status).toBe(400);
    expect((await admin.post("/v1/overnight-policies", policyBody())).status).toBe(201);
  });

  test("POLICY: a policy whose workflow was retired can still be paused and narrowed, but not widened", async () => {
    const wf = crypto.randomUUID();
    await roleWorkflow(w.h, w.t, wf, w.t.jobRoles.sdr, w.t.departments.sales);
    const body = policyBody({ workflowId: wf });
    expect((await (await client(w, "member")).post("/v1/overnight-policies", body)).status).toBe(201);
    await db()`update workflows set state = 'retired' where tenant_id = ${w.t.id} and id = ${wf}`;
    const member = await client(w, "member");
    expect((await member.patch(`/v1/overnight-policies/${body.id}`, { maxCommitsPerNight: 1 })).status).toBe(200);
    expect((await member.patch(`/v1/overnight-policies/${body.id}`, { state: "paused" })).status).toBe(200);
    expect((await member.patch(`/v1/overnight-policies/${body.id}`, { maxCommitsPerNight: 9 })).status).toBe(400);
  });

  test("POLICY: the per-night budget is capped by the role policy's daily budget", async () => {
    const admin = await client(w, "admin");
    // setup.ts role policy: dailyBudgetCents 2000.
    expect((await admin.post("/v1/overnight-policies", policyBody({ budgetCentsPerNight: 2001 }))).status).toBe(400);
    const ok = policyBody({ budgetCentsPerNight: 2000 });
    expect((await admin.post("/v1/overnight-policies", ok)).status).toBe(201);
    expect((await admin.patch(`/v1/overnight-policies/${ok.id}`, { budgetCentsPerNight: 2500 })).status).toBe(400);
  });

  test("OVERNIGHT: a role-identity run uses only an overnight policy its runner owns", async () => {
    const run = { identity: { type: "role_identity" as const, id: w.conns.roleIdentity }, connectionId: w.t.connections.company };
    freshEvening();
    // The lead owns this policy (dept lead of the workflow's department); the member runs the role identity.
    const leads = policyBody({ ownerPersonId: w.t.people.lead.id, recipients: only("ri.lead@fund.com"), dryRunNights: 0 });
    expect((await (await client(w, "admin")).post("/v1/overnight-policies", leads)).status).toBe(201);
    const r = await propose(w, [email("ri.lead@fund.com")], { ...run, ...overnightRun(leads.id) });
    expect(r).toMatchObject({ ok: true, autoApproved: 0, overnightEvaluation: null });
    const mine = policyBody({ recipients: only("ri.mine@fund.com"), dryRunNights: 0 });
    expect((await (await client(w, "admin")).post("/v1/overnight-policies", mine)).status).toBe(201);
    expect(await propose(w, [email("ri.mine@fund.com")], { ...run, ...overnightRun(mine.id) })).toMatchObject({ ok: true, autoApproved: 1 });
    await w.broker.idle();
  });
});

describe("S2-07 round 2: the approval covers the connection and identity (N2)", () => {
  const asApp = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(w.h.db.app, { tenantId: w.t.id, accessRole: "system" }, fn);
  const newGmail = async (ref: string) =>
    (await db()`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
      values (${w.t.id}, 'gmail', 'personal-allowed', 'gmail', ${w.t.people.member.id}, 'composio', ${ref}) returning id`)[0]!.id as string;

  test("TOKEN: a mailbox re-linked to another account after approval does not send", async () => {
    const conn = await newGmail("acct_before_relink");
    const hash = await proposeOk(w, [email("relink@fund.com")], { connectionId: conn });
    const { token } = await approveToken(w, "member", hash);
    await db()`update connections set external_ref = 'acct_after_relink' where tenant_id = ${w.t.id} and id = ${conn}`;
    const calls = w.composio.calls.length;
    await w.broker.commitApproved(w.t.id, hash, token);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("TOKEN: a batch re-pointed to another connection below the app does not send", async () => {
    const other = await newGmail("acct_other_mailbox");
    const hash = await proposeOk(w, [email("repoint@fund.com")]);
    const { token } = await approveToken(w, "member", hash);
    await db()`update batches set connection_id = ${other} where tenant_id = ${w.t.id} and hash = ${hash}`;
    const calls = w.composio.calls.length;
    await w.broker.commitApproved(w.t.id, hash, token);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("ITEM: offload_app cannot change a batch's connection, identity, runner or CRM sheet", async () => {
    const other = await newGmail("acct_app_repoint");
    const hash = await proposeOk(w, [email("immut.batch@fund.com")]);
    await expect(asApp((tx) => tx`update batches set connection_id = ${other} where hash = ${hash}`)).rejects.toThrow(/immutable/);
    await expect(asApp((tx) => tx`update batches set identity_id = ${w.t.people.lead.id} where hash = ${hash}`)).rejects.toThrow(/immutable/);
    await expect(asApp((tx) => tx`update batches set runner_person_id = ${w.t.people.lead.id} where hash = ${hash}`)).rejects.toThrow(/immutable/);
    await expect(asApp((tx) => tx`update batches set crm_sheet = '{"spreadsheetId":"x"}'::jsonb where hash = ${hash}`)).rejects.toThrow(/immutable/);
  });
});

describe("S2-07 round 2: re-arming needs someone above the owner (N3)", () => {
  test("RBAC: the member who owns a tripped policy cannot re-arm it; their dept lead can", async () => {
    const pid = await overnightPolicy(w, { dryRunNights: 3 });
    await db()`update overnight_policies set state = 'tripped', tripped_reason = 'bounce_rate' where tenant_id = ${w.t.id} and id = ${pid}`;
    expect((await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, { state: "active" })).status).toBe(403);
    expect((await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, { state: "paused" })).status).toBe(403);
    const lead = await (await client(w, "lead")).patch(`/v1/overnight-policies/${pid}`, { state: "active" });
    expect(lead.status).toBe(200);
    expect(lead.json).toMatchObject({ state: "active", trippedReason: null });
  });

  test("RBAC: a member cannot resume a policy an admin paused, but resumes one they paused themself", async () => {
    const pid = await overnightPolicy(w, { dryRunNights: 3 });
    const member = await client(w, "member");
    expect((await (await client(w, "admin")).patch(`/v1/overnight-policies/${pid}`, { state: "paused" })).status).toBe(200);
    expect((await member.patch(`/v1/overnight-policies/${pid}`, { state: "active" })).status).toBe(403);
    expect((await (await client(w, "admin")).patch(`/v1/overnight-policies/${pid}`, { state: "active" })).status).toBe(200);
    expect((await member.patch(`/v1/overnight-policies/${pid}`, { state: "paused" })).status).toBe(200);
    expect((await member.patch(`/v1/overnight-policies/${pid}`, { state: "active" })).status).toBe(200);
  });
});

describe("S2-07 round 2: role-policy narrowing after approval (N4)", () => {
  test("RBAC: approvers narrowed to dept_lead after the runner approved: the runner's approval no longer sends", async () => {
    const hash = await proposeOk(w, [email("narrow.approvers@fund.com")]);
    const { token } = await approveToken(w, "member", hash);
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { approvers: "dept_lead" });
    try {
      const calls = w.composio.calls.length;
      await w.broker.commitApproved(w.t.id, hash, token);
      expect(w.composio.calls.length).toBe(calls);
      expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });

  test("POLICY: a capability removed from the role policy after approval is not sent", async () => {
    const hash = await proposeOk(w, [email("narrow.caps@fund.com")]);
    const { token } = await approveToken(w, "member", hash);
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { allowed: ["crm.note"] });
    try {
      const calls = w.composio.calls.length;
      await w.broker.commitApproved(w.t.id, hash, token);
      expect(w.composio.calls.length).toBe(calls);
      expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });
});

/** Polls until `done()` or ~3 s. */
async function until(done: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 120 && !(await done()); i++) await Bun.sleep(25);
}
const waitingLocks = async () => Number((await db()`select count(*)::int as n from pg_locks where not granted`)[0]!.n);

describe("S2-07 round 2: execute and concurrent writers (N6, #14)", () => {
  test("OVERNIGHT: execute waits for an in-flight pause of the token's policy and then does not send", async () => {
    const { pid, hash, at } = await scheduledLive("race.pause@fund.com");
    w.h.clock.t = at;
    const calls = w.composio.calls.length;
    let run: Promise<unknown> | null = null;
    // An edit that pauses the policy holds its row lock until it commits (as PATCH does); execute runs meanwhile.
    await db().begin(async (sql) => {
      await sql`select 1 from overnight_policies where tenant_id = ${w.t.id} and id = ${pid} for update`;
      await sql`update overnight_policies set state = 'paused' where tenant_id = ${w.t.id} and id = ${pid}`;
      run = w.broker.runDue(w.t.id, hash);
      await until(async () => w.composio.calls.length > calls || (await waitingLocks()) > 0);
    });
    await run;
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("ITEM: two approved batches to one recipient executing at the same instant make exactly one call", async () => {
    const addr = "race.same@fund.com";
    const a = await proposeOk(w, [email(addr, "Race A")]);
    const b = await proposeOk(w, [email(addr, "Race B")]);
    const ta = await approveToken(w, "member", a);
    const tb = await approveToken(w, "member", b);
    const calls = w.composio.calls.length;
    w.composio.mode = "hang";
    const settled = new Set<string>();
    let runs: Array<Promise<unknown>> = [];
    try {
      // Both executions are held at the ledger read; released together, only the advisory lock serialises them.
      await db().begin(async (sql) => {
        await sql`lock table contacted_ledger in access exclusive mode`;
        runs = [
          w.broker.commitApproved(w.t.id, a, ta.token).finally(() => settled.add(a)),
          w.broker.commitApproved(w.t.id, b, tb.token).finally(() => settled.add(b)),
        ];
        await until(async () => (await waitingLocks()) >= 2);
        expect(await waitingLocks()).toBeGreaterThanOrEqual(2);
      });
      await until(() => w.composio.calls.length >= calls + 2 || (settled.size > 0 && w.composio.calls.length >= calls + 1));
      expect(w.composio.calls.length).toBe(calls + 1);
      const states = [(await items(w, a))[0]!.state, (await items(w, b))[0]!.state].sort();
      expect(states).toEqual(["pending", "sending"]);
    } finally {
      w.composio.mode = "ok";
      w.composio.finishHung();
      await Promise.allSettled(runs);
    }
  });
});
