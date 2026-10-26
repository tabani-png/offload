// S2-07 fix round 3 (PR #12 Codex re-review, two P1s) and the end-to-end send-path audit. Every test here failed on
// 720cbd3 before its fix. Real broker, real policies module, real Postgres; only the Composio runner is in-memory.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import {
  approveHttp,
  approveToken,
  email,
  items,
  overnightPolicy,
  overnightRun,
  propose,
  proposeOk,
  setRolePolicy,
  WF_AP,
  world,
  type World,
} from "./setup.ts";

let w: World;
const DAY = 24 * 3600_000;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
let n = 0;
const to = () => `d${++n}@fund.com`;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});
const db = () => w.h.db.migrator;
afterEach(async () => {
  // Every test leaves the world as it found it.
  await db()`update people set state = 'active' where tenant_id = ${w.t.id} and id = ${w.t.people.member.id}`;
  await db()`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${w.t.id}, ${w.t.jobRoles.sdr}, ${w.t.people.member.id})
    on conflict do nothing`;
  await db()`update workflows set state = 'role' where tenant_id = ${w.t.id}`;
  await db()`update role_identities set connection_id = ${w.t.connections.company} where tenant_id = ${w.t.id} and id = ${w.conns.roleIdentity}`;
  await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
});

const asRole = () => ({ identity: { type: "role_identity" as const, id: w.conns.roleIdentity }, connectionId: w.t.connections.company });

/** Freezes a person the way continuity does: the state, then the broker's revocation. */
async function freeze(personId: string) {
  await db()`update people set state = 'frozen' where tenant_id = ${w.t.id} and id = ${personId}`;
  await withTenant(w.h.db.app, { tenantId: w.t.id, accessRole: "system" }, (tx) => w.broker.revokeTokensFor(tx, personId));
}

/** Approves in-process (no dispatch), lets `between` change the world, then commits with the token. */
async function approveThenCommit(hash: string, between: () => Promise<void>, who: "member" | "lead" = "lead") {
  const { token } = await approveToken(w, who, hash);
  await between();
  const calls = w.composio.calls.length;
  await w.broker.commitApproved(w.t.id, hash, token).catch(() => undefined);
  return w.composio.calls.length - calls;
}

describe("S2-07 round 3 P1-1: a person identity never sends through a company connection", () => {
  test("POLICY: a person identity with a company connection is refused (forbidden_binding)", async () => {
    for (const connectionId of [w.t.connections.company, w.conns.org, w.conns.mcp, w.conns.api]) {
      expect(await propose(w, [email(to())], { connectionId })).toMatchObject({ ok: false, code: "forbidden_binding" });
    }
  });

  test("POLICY: a role identity cannot use a company connection bound to another job role", async () => {
    const [c] = await db()`insert into connections (tenant_id, kind, ownership, label, job_role_id, provider, external_ref)
      values (${w.t.id}, 'm365_shared_mailbox', 'company', 'AP inbox', ${w.t.jobRoles.ap}, 'composio', 'acct_ap') returning id`;
    const [ri] = await db()`insert into role_identities (tenant_id, job_role_id, label, address, connection_id)
      values (${w.t.id}, ${w.t.jobRoles.sdr}, 'Borrowed AP inbox', 'ap@acme.example.com', ${c!.id}) returning id`;
    const r = await propose(w, [email(to())], { identity: { type: "role_identity", id: ri!.id as string }, connectionId: c!.id as string });
    expect(r).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("POLICY: a role identity run's runner must hold the job role", async () => {
    const m2 = w.t.people.member2.id;
    const r = await propose(w, [email(to())], { ...asRole(), runnerPersonId: m2 });
    expect(r).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("POLICY: a run's job role must own its workflow (no borrowing another role's policy)", async () => {
    const r = await propose(w, [email(to())], { ...asRole(), workflowId: WF_AP });
    expect(r).toMatchObject({ ok: false, code: "forbidden_binding" });
  });

  test("ITEM: execute refuses a role identity re-pointed to another connection after approval", async () => {
    const hash = await proposeOk(w, [email(to())], asRole());
    const sent = await approveThenCommit(hash, async () => {
      await db()`update connections set ownership = 'company' where tenant_id = ${w.t.id} and id = ${w.conns.mcp}`;
      await db()`update role_identities set connection_id = ${w.conns.mcp} where tenant_id = ${w.t.id} and id = ${w.conns.roleIdentity}`;
    });
    expect(sent).toBe(0);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("ITEM: execute refuses when the runner no longer holds the job role", async () => {
    const hash = await proposeOk(w, [email(to())], asRole());
    const sent = await approveThenCommit(hash, async () => {
      await db()`delete from job_role_holders where tenant_id = ${w.t.id} and job_role_id = ${w.t.jobRoles.sdr} and person_id = ${w.t.people.member.id}`;
    });
    expect(sent).toBe(0);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("ITEM: execute refuses when the workflow was retired after approval", async () => {
    const hash = await proposeOk(w, [email(to())]);
    const sent = await approveThenCommit(hash, async () => {
      await db()`update workflows set state = 'retired' where tenant_id = ${w.t.id}`;
    });
    expect(sent).toBe(0);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });
});

describe("S2-07 round 3 P1-2: a frozen or offboarded runner sends nothing", () => {
  test("TOKEN: a dept lead cannot approve a batch whose runner was frozen after proposing it", async () => {
    const hash = await proposeOk(w, [email(to())]);
    await freeze(w.t.people.member.id);
    const calls = w.composio.calls.length;
    const r = await approveHttp(w, "lead", hash);
    expect(r.status).toBe(409);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("TOKEN: a role identity batch is not approvable once its runner is departed", async () => {
    const hash = await proposeOk(w, [email(to())], asRole());
    await db()`update people set state = 'departed' where tenant_id = ${w.t.id} and id = ${w.t.people.member.id}`;
    expect((await approveHttp(w, "lead", hash)).status).toBe(409);
  });

  test("ITEM: execute re-reads the runner's lifecycle: frozen between approval and the call sends nothing", async () => {
    const hash = await proposeOk(w, [email(to())]);
    // Frozen below the API (no revocation): only execute's own check stands between the token and the call.
    const sent = await approveThenCommit(hash, async () => {
      await db()`update people set state = 'frozen' where tenant_id = ${w.t.id} and id = ${w.t.people.member.id}`;
    });
    expect(sent).toBe(0);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });

  test("OVERNIGHT: a policy-approved item whose owner departs before the window sends nothing", async () => {
    const { hash, at } = await scheduledLive(to());
    await db()`update people set state = 'departed' where tenant_id = ${w.t.id} and id = ${w.t.people.member.id}`;
    await sendsNothingAt(hash, at);
  });
});

// ---------- the send-path audit: conditions that held only at propose or approve ----------

const narrowWindow = { startHour: 8, endHour: 9, days: ALL_DAYS, recipientTimezone: false };
const freshEvening = () => {
  w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 20 * 3600_000;
};
async function scheduledLive(addr: string) {
  freshEvening();
  const pid = await overnightPolicy(w, { dryRunNights: 3, sendWindow: narrowWindow, recipients: { emails: [addr], domains: [], repliesToThreadsStartedByIdentity: false } });
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

describe("S2-07 round 3 audit: execute-time checks", () => {
  test("TOKEN: an approval that expired while its item waited for the window sends nothing", async () => {
    const { hash, at } = await scheduledLive(to());
    await db()`update approval_tokens set expires_at = ${new Date(at - 1000)} where tenant_id = ${w.t.id} and batch_hash = ${hash}`;
    await sendsNothingAt(hash, at);
  });

  test("OVERNIGHT: the night cap holds on the night items go out, also for an approval of the night before", async () => {
    // Window 13:00-14:00 UTC; a night runs from 12:00 to 12:00 (tenant UTC). A is approved at 23:00 (night N) and B at
    // 12:30 the next day (night N+1): each was within its own night's cap of 1, and both are due at 13:00 of night N+1.
    const a = to();
    const bAddr = to();
    w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 23 * 3600_000;
    const pid = await overnightPolicy(w, {
      dryRunNights: 3, maxCommitsPerNight: 1,
      sendWindow: { startHour: 13, endHour: 14, days: ALL_DAYS, recipientTimezone: false },
      recipients: { emails: [a, bAddr], domains: [], repliesToThreadsStartedByIdentity: false },
    });
    await db()`update overnight_policies set dry_run_nights_done = 3 where tenant_id = ${w.t.id} and id = ${pid}`;
    const ra = await propose(w, [email(a)], overnightRun(pid));
    w.h.clock.t += 13.5 * 3600_000;
    const rb = await propose(w, [email(bAddr)], overnightRun(pid));
    if (!ra.ok || !rb.ok || ra.autoApproved !== 1 || rb.autoApproved !== 1) throw new Error(`not auto-approved: ${JSON.stringify([ra, rb])}`);
    await w.broker.idle();
    w.h.clock.t += 0.5 * 3600_000;
    const calls = w.composio.calls.length;
    await w.broker.runDue(w.t.id);
    expect(w.composio.calls.length - calls).toBe(1);
  });

  test("OVERNIGHT: a night budget spent after approval stops the send (budget cap at execute)", async () => {
    const { pid, hash, at } = await scheduledLive(to());
    await w.broker.reportNightSignals(w.t.id, pid, { costCents: 10_000 });
    await sendsNothingAt(hash, at);
  });

  test("OVERNIGHT: a connection re-linked after a policy approval trips the breaker at execute (fingerprint)", async () => {
    const { pid, hash, at } = await scheduledLive(to());
    await db()`update connections set external_ref = 'acct_relinked' where tenant_id = ${w.t.id} and id = ${w.conns.memberGmail}`;
    try {
      await sendsNothingAt(hash, at);
      const [p] = await db()`select state, tripped_reason from overnight_policies where tenant_id = ${w.t.id} and id = ${pid}`;
      expect(p).toMatchObject({ state: "tripped", tripped_reason: "connection_auth_change" });
    } finally {
      await db()`update connections set external_ref = 'acct_member_gmail' where tenant_id = ${w.t.id} and id = ${w.conns.memberGmail}`;
    }
  });

  test("POLICY: a role policy that lowers max items per batch after approval stops the larger batch", async () => {
    const hash = await proposeOk(w, [email(to()), email(to()), email(to())]);
    const sent = await approveThenCommit(hash, () => setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { maxItems: 1 }));
    expect(sent).toBe(0);
    expect((await items(w, hash)).every((i) => i.state === "pending" && i.token_id === null)).toBe(true);
  });
  test("TOKEN: an item pointed at another item's approval below the API is not sent (token names its keys)", async () => {
    const a = to();
    const b = to();
    const hash = await proposeOk(w, [email(a), email(b)]);
    const calls = w.composio.calls.length;
    const { token } = await approveToken(w, "member", hash, [], [a]);
    await db()`update batch_items set token_id = (select token_id from batch_items where tenant_id = ${w.t.id} and batch_hash = ${hash} and key = ${a})
      where tenant_id = ${w.t.id} and batch_hash = ${hash} and key = ${b}`;
    await w.broker.commitApproved(w.t.id, hash, token).catch(() => undefined);
    expect(w.composio.calls.length - calls).toBe(1);
    const byKey = Object.fromEntries((await items(w, hash)).map((i) => [i.key, i.state]));
    expect(byKey).toEqual({ [a]: "sent", [b]: "pending" });
  });

  test("OVERNIGHT: a policy approval holds only while the policy's owner is the batch's runner", async () => {
    const { pid, hash, at } = await scheduledLive(to());
    await db()`update overnight_policies set owner_person_id = ${w.t.people.lead.id} where tenant_id = ${w.t.id} and id = ${pid}`;
    await sendsNothingAt(hash, at);
  });
});
