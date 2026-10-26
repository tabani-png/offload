// S2-07 follow-ups, review of PR #27 (09ee4f3): the audit chain's tenant lock is the LAST lock of every transaction,
// and a person kill locks all its batches in one sorted pass. Each test forces the interleaving that deadlocked with a
// gate transaction (pg_blocking_pids), as in review-e.test.ts. Both failed on 09ee4f3 with 40P01.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Tx } from "../../src/db/pool.ts";
import { approveToken, email, items, proposeOk, tx, WF2, world, type World } from "./setup.ts";

let w: World;
const SLOW = 30_000;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});
afterEach(async () => {
  await db()`update kill_switches set active = false, cleared_at = now() where tenant_id = ${w.t.id} and active`;
});
const db = () => w.h.db.migrator;

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
/** A kill as the route runs it: revoke, then the queued audit events after the last row lock. */
const killTx = (scope: "workflow" | "person", target: string) =>
  tx(w, async (t) => {
    const n = await w.broker.revokeForKill(t, scope, target, "kill switch");
    await w.broker.flushAudits?.(t);
    return n;
  });
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const sqlState = (e: unknown) => String((e as { errno?: unknown })?.errno ?? (e as { code?: unknown })?.code ?? (e as Error)?.message ?? "");

describe("S2-07 follow-up review: lock order with the audit chain and person kills", () => {
  test(
    "KILL: a workflow kill sweeping two batches racing an approval of the second: neither aborts",
    async () => {
      // Two pending batches of one workflow; the lower hash (x) holds an unspent approval, the other (y) is approved
      // during the kill.
      const a = await proposeOk(w, [email("i1a@fund.com")], { workflowId: WF2 });
      const b = await proposeOk(w, [email("i1b@fund.com")], { workflowId: WF2 });
      const [x, y] = [a, b].sort();
      await approveToken(w, "lead", x!);
      const retries = w.broker.lockRetries;
      // The gate holds the tenant's audit-chain lock: whoever writes an audit event waits there.
      const g = await gate((t) => t`select pg_advisory_xact_lock(hashtextextended('audit:' || ${w.t.id}, 0))`);
      const kill = settle(killTx("workflow", WF2));
      await g.blocked(1);
      const approve = settle(approveToken(w, "lead", y!));
      await g.blocked(2);
      await g.open();
      const [k, ap] = await Promise.all([kill, approve]);
      expect(k.ok ? "ok" : sqlState(k.e)).toBe("ok");
      // The approval either went first (then the kill revoked it) or after (a fresh approval); never a deadlock.
      expect(ap.ok ? "ok" : sqlState(ap.e)).toBe("ok");
      expect((await items(w, x!))[0]!.token_id).toBeNull();
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );

  test(
    "KILL: two person kills, each the other's approver: one sorted pass each, neither aborts",
    async () => {
      const lead = w.t.people.lead.id;
      const member = w.t.people.member.id;
      // The lead's own mailbox, so the lead can run a batch as themselves (dept lead of the job role's department).
      const [c] = await db()`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
        values (${w.t.id}, 'gmail', 'personal-allowed', 'gmail', ${lead}, 'composio', 'acct_lead_gmail') returning id`;
      const p = await proposeOk(w, [email("i2p@fund.com")]); // runner: member
      const q = await proposeOk(w, [email("i2q@fund.com")], { identity: { type: "person", id: lead }, runnerPersonId: lead, connectionId: c!.id as string });
      await approveToken(w, "lead", p); // approver of p: lead
      await approveToken(w, "lead", q); // the runner's own approval, then recorded as the member's (below the API)
      await db()`update approval_tokens set approved_by = ${member} where tenant_id = ${w.t.id} and batch_hash = ${q}`;
      const retries = w.broker.lockRetries;
      // The gate holds q: the lead's kill (runner of q) waits there first, the member's kill (runner of p) behind it.
      const g = await gate((t) => t`select 1 from batches where tenant_id = ${w.t.id} and hash = ${q} for update`);
      const k1 = settle(killTx("person", lead));
      await g.blocked(1);
      const k2 = settle(killTx("person", member));
      await g.blocked(2);
      await g.open();
      const [r1, r2] = await Promise.all([k1, k2]);
      expect(r1.ok ? "ok" : sqlState(r1.e)).toBe("ok");
      expect(r2.ok ? "ok" : sqlState(r2.e)).toBe("ok");
      expect((await items(w, p))[0]!.token_id).toBeNull();
      expect((await items(w, q))[0]!.token_id).toBeNull();
      expect(w.broker.lockRetries).toBe(retries);
    },
    SLOW,
  );
});
