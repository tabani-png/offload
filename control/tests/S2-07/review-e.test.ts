// S2-07 fix round 4 (PR #12 Codex review on 6ac234c, two P2 deadlocks) and the class-wide lock-order audit. Every
// test runs two real broker transactions against real Postgres and forces the interleaving that deadlocked: a gate
// transaction holds a lock, each side is started only once the previous one is seen blocked (pg_blocking_pids), then
// the gate lets go. No sleeps decide the order. Every test here failed on 6ac234c (Postgres aborted one side with
// 40P01 "deadlock detected").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpError } from "../../src/schema/http.ts";
import type { Tx } from "../../src/db/pool.ts";
import { approveToken, client, email, items, overnightPolicy, overnightRun, propose, proposeOk, tx, WF, WF2, WF3, world, type World } from "./setup.ts";

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

/** 20:00 UTC of a day after every night used so far: outside an 08-09 window, on a fresh night. */
const freshEvening = () => {
  w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 20 * 3600_000;
};
const narrowWindow = { startHour: 8, endHour: 9, days: ALL_DAYS, recipientTimezone: false };
const only = (addr: string) => ({ emails: [addr], domains: [], repliesToThreadsStartedByIdentity: false });

/** A policy-approved item, its token spent, waiting for tomorrow's 08:00 window. */
async function scheduledByPolicy(addr: string, workflowId: string) {
  freshEvening();
  const pid = await overnightPolicy(w, { workflowId, sendWindow: narrowWindow, recipients: only(addr) });
  const r = await propose(w, [email(addr)], { workflowId, ...overnightRun(pid) });
  if (!r.ok || r.autoApproved !== 1) throw new Error(`not auto-approved: ${JSON.stringify(r)}`);
  await w.broker.idle();
  const [it] = await items(w, r.batchHash);
  expect(it!.token_id).not.toBeNull();
  expect(it!.state).toBe("pending");
  return { pid, hash: r.batchHash };
}

interface Gate {
  pid: number;
  /** Resolves once `n` backends are blocked behind the gate, directly or behind another blocked one. */
  blocked(n: number): Promise<void>;
  open(): Promise<void>;
}

/** A transaction on its own connection that takes `lock` and holds it until `open()`. */
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
    pid,
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

/** Settles a promise into a value or the error, so both sides of a race are inspected. */
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const sqlState = (e: unknown) => {
  const x = e as { errno?: unknown; code?: unknown };
  return String(x?.errno ?? x?.code ?? "");
};
const lockBatch = (hash: string) => (g: Tx) => g`select 1 from batches where tenant_id = ${w.t.id} and hash = ${hash} for update`;

describe("S2-07 round 4: Codex P2 deadlocks", () => {
  test(
    "OVERNIGHT: two overlapping runDue on a policy whose connection changed record one breaker trip, neither aborts",
    async () => {
      const addr = "e1@fund.com";
      const { pid, hash } = await scheduledByPolicy(addr, WF);
      const retries = w.broker.lockRetries;
      await db()`update connections set external_ref = 'acct_relinked_e1' where id = ${w.conns.memberGmail}`;
      try {
        const g = await gate(lockBatch(hash));
        const a = settle(w.broker.runDue(w.t.id, hash));
        await g.blocked(1);
        const b = settle(w.broker.runDue(w.t.id, hash));
        await g.blocked(2);
        await g.open();
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.ok ? "ok" : sqlState(ra.e)).toBe("ok");
        expect(rb.ok ? "ok" : sqlState(rb.e)).toBe("ok");
      } finally {
        await db()`update connections set external_ref = 'acct_member_gmail' where id = ${w.conns.memberGmail}`;
      }
      const [p] = await db()`select state, tripped_reason from overnight_policies where tenant_id = ${w.t.id} and id = ${pid}`;
      expect(p).toMatchObject({ state: "tripped", tripped_reason: "connection_auth_change" });
      const trips = await db()`select reason from breaker_trips where tenant_id = ${w.t.id} and policy_id = ${pid}`;
      expect(trips.map((t: Record<string, unknown>) => t.reason)).toEqual(["connection_auth_change"]);
      expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );

  test(
    "TOKEN: a rejection racing the commit of its approval returns 200 (never a 500), and nothing is sent",
    async () => {
      const hash = await proposeOk(w, [email("e2@fund.com")]);
      const { token } = await approveToken(w, "lead", hash);
      const calls = w.composio.calls.length;
      const lead = await client(w, "lead");
      const retries = w.broker.lockRetries;
      // The gate stalls the rejection after it locked the batch (it reads the role policy next).
      const g = await gate((t) => t`lock table role_policies in access exclusive mode`);
      const rej = settle(lead.post(`/v1/batches/${hash}/reject`, { reason: "not now" }));
      await g.blocked(1);
      const commit = settle(w.broker.commitApproved(w.t.id, hash, token));
      await g.blocked(2);
      await g.open();
      const [r, c] = await Promise.all([rej, commit]);
      expect(r.ok && r.v.status).toBe(200);
      // The commit either lost cleanly (409) or found nothing left to send; never a database error.
      if (!c.ok) expect(c.e instanceof HttpError ? (c.e as HttpError).status : sqlState(c.e)).toBe(409);
      expect(w.composio.calls.length).toBe(calls);
      expect((await items(w, hash))[0]!.state).toBe("rejected");
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );
});

describe("S2-07 round 4: lock-order audit (one global order: kill switch, policy, batch, token, item)", () => {
  test(
    "KILL: a kill switch set while a send is being prepared waits for it; neither side aborts",
    async () => {
      const { hash } = await scheduledByPolicy("e3@fund.com", WF2);
      const retries = w.broker.lockRetries;
      const g = await gate(lockBatch(hash));
      const send = settle(w.broker.runDue(w.t.id, hash));
      await g.blocked(1);
      const kill = settle(
        tx(w, async (t) => {
          // As the kill route runs it: revoke, then the queued audit events (follow-up: unflushed events roll back).
          const n = await w.broker.revokeForKill(t, "workflow", WF2, "kill switch");
          await w.broker.flushAudits(t);
          return n;
        }),
      );
      await g.blocked(2);
      await g.open();
      const [s, k] = await Promise.all([send, kill]);
      expect(s.ok ? "ok" : sqlState(s.e)).toBe("ok");
      expect(k.ok ? "ok" : sqlState(k.e)).toBe("ok");
      expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );

  test(
    "OVERNIGHT: stopping a person's runs while their policy's send is being prepared pauses the policy; neither aborts",
    async () => {
      const { pid, hash } = await scheduledByPolicy("e4@fund.com", WF3);
      const retries = w.broker.lockRetries;
      const g = await gate(lockBatch(hash));
      const stop = settle(tx(w, (t) => w.broker.stopRunsFor(t, w.t.people.member.id)));
      await g.blocked(1);
      const send = settle(w.broker.runDue(w.t.id, hash));
      await g.blocked(2);
      await g.open();
      const [st, s] = await Promise.all([stop, send]);
      expect(st.ok ? "ok" : sqlState(st.e)).toBe("ok");
      expect(s.ok ? "ok" : sqlState(s.e)).toBe("ok");
      const [p] = await db()`select state from overnight_policies where tenant_id = ${w.t.id} and id = ${pid}`;
      expect(p!.state).toBe("paused");
      expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );
});
