// S2-07 fix round 5 (PR #12 Codex review on be691e0, one P2) and the class-wide audit of secondary writes in the send
// path: a late provider answer after reconcile marked the item `unknown` must not rewrite the ledger, the counters or
// the audit trail. The late-answer tests failed on be691e0. The lock-race tests below them are the deterministic
// repros round 4 lacked (post-send journal vs a breaker trip, reconcile vs the journal, two identical kill switches);
// they use the gate technique of review-e.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tx } from "../../src/db/pool.ts";
import { approveToken, auditActions, client, email, items, overnightPolicy, overnightRun, propose, proposeOk, WF, WF2, WF3, world, type World } from "./setup.ts";

let w: World;
const DAY = 24 * 3600_000;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const SLOW = 30_000;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});
const db = () => w.h.db.migrator;

const freshEvening = () => {
  w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 20 * 3600_000;
};
const narrowWindow = { startHour: 8, endHour: 9, days: ALL_DAYS, recipientTimezone: false };

/** Policy-approved items, tokens spent, waiting for tomorrow's 08:00 window; returns when it opens. */
async function scheduledByPolicy(addrs: string[], workflowId: string, over: Record<string, unknown> = {}) {
  freshEvening();
  const pid = await overnightPolicy(w, {
    workflowId,
    sendWindow: narrowWindow,
    recipients: { emails: addrs, domains: [], repliesToThreadsStartedByIdentity: false },
    ...over,
  });
  const r = await propose(w, addrs.map((a) => email(a)), { workflowId, ...overnightRun(pid) });
  if (!r.ok || r.autoApproved !== addrs.length) throw new Error(`not auto-approved: ${JSON.stringify(r)}`);
  await w.broker.idle();
  const its = await items(w, r.batchHash);
  for (const it of its) expect(it.token_id).not.toBeNull();
  return { pid, hash: r.batchHash, at: its[0]!.scheduled_for!.getTime() };
}

const ledger = async (hash: string) =>
  (await db()`select item_key, outcome from contacted_ledger where tenant_id = ${w.t.id} and batch_hash = ${hash} order by item_key`) as Array<{ item_key: string; outcome: string }>;
const sends = async (pid: string) =>
  (await db()`select coalesce(sum(sends), 0)::int as n from overnight_counters where tenant_id = ${w.t.id} and policy_id = ${pid}`)[0]!.n as number;

interface Gate {
  blocked(n: number): Promise<void>;
  open(): Promise<void>;
}
async function gate(lock: (g: Tx) => Promise<unknown>): Promise<Gate> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let ready!: (pid: number) => void;
  let failed!: (e: unknown) => void;
  const locked = new Promise<number>((r, f) => {
    ready = r;
    failed = f;
  });
  const done = db()
    .begin(async (g: Tx) => {
      const [me] = await g`select pg_backend_pid() as pid`;
      await lock(g);
      ready(Number(me!.pid));
      await released;
    })
    .catch(failed);
  const pid = await locked;
  return {
    async blocked(n: number) {
      const until = Date.now() + 15_000;
      for (;;) {
        const [r] = await db()`with recursive chain(pid) as (
            select a.pid from pg_stat_activity a where ${pid}::int = any(pg_blocking_pids(a.pid))
            union
            select a.pid from pg_stat_activity a join chain c on c.pid = any(pg_blocking_pids(a.pid))
          ) select count(*)::int as n from chain`;
        if (Number(r!.n) >= n) return;
        if (Date.now() > until) throw new Error(`gate: ${r!.n} of ${n} backends blocked`);
        await Bun.sleep(10);
      }
    },
    async open() {
      release();
      await done;
    },
  };
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const sqlState = (e: unknown) => String((e as { errno?: unknown })?.errno ?? (e as { code?: unknown })?.code ?? "");

describe("S2-07 round 5: a late provider answer after reconcile changes nothing but the audit trail", () => {
  test(
    "ITEM: a success that arrives after reconcile keeps the item and the ledger unknown; the recipient stays held",
    async () => {
      const addr = "f1@fund.com";
      const hash = await proposeOk(w, [email(addr)]);
      const { token } = await approveToken(w, "lead", hash);
      // The call outlives the stale limit: reconcile runs while it is in flight, then the provider says "sent".
      w.composio.during = async () => {
        w.composio.during = null;
        w.h.clock.advance(11 * 60_000);
        expect(await w.broker.reconcile(w.t.id)).toBe(1);
      };
      const before = (await auditActions(w)).length;
      const s = await w.broker.commitApproved(w.t.id, hash, token);
      expect((await items(w, hash))[0]!.state).toBe("unknown");
      expect(await ledger(hash)).toEqual([{ item_key: addr, outcome: "unknown" }]);
      const actions = (await auditActions(w)).slice(before);
      expect(actions).not.toContain("batch.item_sent");
      expect(actions).toContain("batch.item_late_result");
      expect(s.sent).toBe(0);
      // Recipient exclusion (Stage 1): the unreleased unknown item still holds the recipient.
      expect(await propose(w, [email(addr, "Another note")])).toMatchObject({ ok: false, code: "conflict" });
    },
    SLOW,
  );

  test(
    "OVERNIGHT: a late success of a policy send does not count toward the night's sends",
    async () => {
      const { pid, hash, at } = await scheduledByPolicy(["f2@fund.com"], WF);
      w.h.clock.t = at;
      const n0 = await sends(pid);
      w.composio.during = async () => {
        w.composio.during = null;
        w.h.clock.advance(11 * 60_000);
        await w.broker.reconcile(w.t.id);
      };
      await w.broker.runDue(w.t.id, hash);
      expect((await items(w, hash))[0]!.state).toBe("unknown");
      expect(await ledger(hash)).toEqual([{ item_key: "f2@fund.com", outcome: "unknown" }]);
      expect(await sends(pid)).toBe(n0);
    },
    SLOW,
  );
});

describe("S2-07 round 5: lock races forced with a gate (round 4 follow-ups)", () => {
  test(
    "OVERNIGHT: the post-send journal racing a breaker trip of its policy: neither aborts, the trip is recorded once",
    async () => {
      const { pid, hash, at } = await scheduledByPolicy(["f3a@fund.com", "f3b@fund.com"], WF2);
      w.h.clock.t = at;
      expect(await w.broker.reportRunResult(w.t.id, pid, false)).toBeNull();
      const retries = w.broker.lockRetries;
      let g!: Gate;
      let gated!: () => void;
      const inCall = new Promise<void>((r) => (gated = r));
      // While the first item's call is in flight, the gate takes tonight's counters row: the journal will wait on it.
      w.composio.during = async () => {
        w.composio.during = null;
        g = await gate((t) => t`select 1 from overnight_counters where tenant_id = ${w.t.id} and policy_id = ${pid} for update`);
        gated();
      };
      const send = settle(w.broker.runDue(w.t.id, hash));
      await inCall;
      await g.blocked(1);
      const trip = settle(w.broker.reportRunResult(w.t.id, pid, false));
      await g.blocked(2);
      await g.open();
      const [s, t] = await Promise.all([send, trip]);
      expect(s.ok ? "ok" : sqlState(s.e)).toBe("ok");
      expect(t.ok ? t.v : sqlState(t.e)).toBe("consecutive_failures");
      const trips = await db()`select reason from breaker_trips where tenant_id = ${w.t.id} and policy_id = ${pid}`;
      expect(trips.map((x: Record<string, unknown>) => x.reason)).toEqual(["consecutive_failures"]);
      const its = await items(w, hash);
      expect(its[0]!.state).toBe("sent");
      expect(its[1]).toMatchObject({ state: "pending", token_id: null });
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );

  test(
    "ITEM: reconcile racing the journal of an answer that is just in: the answer wins, neither aborts",
    async () => {
      const addr = "f4@fund.com";
      const hash = await proposeOk(w, [email(addr)], { workflowId: WF3 });
      const { token } = await approveToken(w, "lead", hash);
      const retries = w.broker.lockRetries;
      let g!: Gate;
      let gated!: () => void;
      const inCall = new Promise<void>((r) => (gated = r));
      w.composio.during = async () => {
        w.composio.during = null;
        w.h.clock.advance(11 * 60_000); // the item is stale `sending` by the time the answer is journaled
        g = await gate((t) => t`select 1 from batches where tenant_id = ${w.t.id} and hash = ${hash} for update`);
        gated();
      };
      const send = settle(w.broker.commitApproved(w.t.id, hash, token));
      await inCall;
      await g.blocked(1);
      const rec = settle(w.broker.reconcile(w.t.id));
      await g.blocked(2);
      await g.open();
      const [s, r] = await Promise.all([send, rec]);
      expect(s.ok ? "ok" : sqlState(s.e)).toBe("ok");
      expect(r.ok ? "ok" : sqlState(r.e)).toBe("ok");
      expect((await items(w, hash))[0]!.state).toBe("sent");
      expect(await ledger(hash)).toEqual([{ item_key: addr, outcome: "sent" }]);
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );

  test(
    "KILL: two identical kill switches set at once: one 201, one 409, never a 500",
    async () => {
      const admin = await client(w, "admin");
      const admin2 = await client(w, "admin");
      // Inserts wait on the gate; the duplicate checks do not, so both requests pass theirs before either inserts.
      const g = await gate((t) => t`lock table kill_switches in share row exclusive mode`);
      const a = admin.post("/v1/kill-switches", { scope: "workflow", targetId: WF3, reason: "stop a" });
      await g.blocked(1);
      const b = admin2.post("/v1/kill-switches", { scope: "workflow", targetId: WF3, reason: "stop b" });
      await g.blocked(2);
      await g.open();
      const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      expect((await admin.del(`/v1/kill-switches/workflow/${WF3}`)).status).toBe(200);
    },
    SLOW,
  );
});
