import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { withTenant } from "../../src/db/tenant.ts";
import { chainHash, writeAudit, type AuditEvent } from "../../src/audit/audit.ts";
import { anchorAll, exportCheckpoint, verifyAllChains, verifyCheckpoint, writeCheckpointFile } from "../../src/audit/anchor.ts";
import { verifyChainCommand } from "../../src/audit/verify-chain.ts";
import { generateEs256SigningKey, type SigningKey } from "../../src/auth/jwt.ts";

let h: Harness;
let key: SigningKey;
const SYSTEM = { type: "system" as const, id: null, accessRole: null };

beforeAll(async () => {
  h = await createHarness();
  key = await generateEs256SigningKey("anchor-test");
});
afterAll(() => h.close());

async function events(tenantId: string, n: number, tag: string) {
  for (let i = 0; i < n; i++) {
    await withTenant(h.db.app, { tenantId }, (tx) =>
      writeAudit(tx, { actor: SYSTEM, action: "test.anchor", resource: { type: "test", id: `${tag}${i}` } }, h.clock.now()),
    );
  }
}

const verdictOf = async (tenantId: string, checkpoint: Parameters<typeof verifyAllChains>[1] = null) =>
  (await verifyAllChains(h.db.anchor, checkpoint)).tenants.find((t) => t.tenantId === tenantId)!;

/** What a table owner could do: recompute every hash after changing one event, so every link still matches. */
async function rewriteChain(tenantId: string) {
  const rows = await h.db.migrator`select * from audit_events where tenant_id = ${tenantId} order by seq`;
  let prev: string | null = null;
  for (const [i, r] of rows.entries()) {
    const e: Omit<AuditEvent, "hash"> = {
      id: r.id, at: Number(r.at_ms), actor: { type: r.actor_type, id: r.actor_id, accessRole: r.actor_role }, action: r.action,
      subjectPersonId: r.subject_person_id, resource: { type: r.resource_type, id: r.resource_id },
      detail: i === 0 ? { forged: true } : r.detail, prevHash: prev,
    };
    const hash = chainHash(e);
    await h.db.migrator`update audit_events set detail = ${e.detail}::jsonb, prev_hash = ${prev}, hash = ${hash}
      where tenant_id = ${tenantId} and seq = ${r.seq}`;
    prev = hash;
  }
}

describe("AUDIT anchors", () => {
  test("AUDIT: only offload_anchor may insert anchors, and nobody may change or delete one", async () => {
    const t = `${h.db.schema}.audit_anchors`;
    const [p] = await h.db.migrator`select has_table_privilege('offload_app', ${t}, 'INSERT') as app_i,
      has_table_privilege('offload_app', ${t}, 'SELECT') as app_s,
      has_table_privilege('offload_anchor', ${t}, 'INSERT') as anc_i,
      has_table_privilege('offload_anchor', ${t}, 'UPDATE') as anc_u,
      has_table_privilege('offload_anchor', ${t}, 'DELETE') as anc_d,
      has_table_privilege('offload_anchor', ${`${h.db.schema}.audit_events`}, 'INSERT') as anc_ev`;
    expect(p).toEqual({ app_i: false, app_s: true, anc_i: true, anc_u: false, anc_d: false, anc_ev: false });
    const ins = await withTenant(h.db.app, { tenantId: h.a.id }, (tx) =>
      tx`insert into audit_anchors (tenant_id, head_seq, head_id, head_hash, anchored_at_ms)
        values (${h.a.id}, 1, ${"0".repeat(26)}, ${"0".repeat(64)}, 1)`).catch((e) => e);
    expect(String(ins)).toMatch(/permission denied/);
    await events(h.a.id, 2, "a");
    expect((await anchorAll(h.db.anchor, h.clock.now())).anchored.map((a) => a.tenantId)).toContain(h.a.id);
    // Even the table owner trips the append-only trigger.
    const upd = await h.db.migrator`update audit_anchors set head_seq = 1`.catch((e) => e);
    expect(String(upd)).toMatch(/append-only/);
    const del = await h.db.migrator`delete from audit_anchors`.catch((e) => e);
    expect(String(del)).toMatch(/append-only/);
  });

  test("AUDIT: an anchoring pass records each moved head once and skips unchanged chains", async () => {
    await events(h.a.id, 1, "b");
    const first = await anchorAll(h.db.anchor, h.clock.now());
    const mine = first.anchored.find((a) => a.tenantId === h.a.id)!;
    const [head] = await h.db.migrator`select seq, id, hash from audit_events where tenant_id = ${h.a.id} order by seq desc limit 1`;
    expect(mine).toMatchObject({ seq: Number(head!.seq), id: head!.id, hash: head!.hash });
    const again = await anchorAll(h.db.anchor, h.clock.now());
    expect(again.anchored.map((a) => a.tenantId)).not.toContain(h.a.id);
    expect((await verdictOf(h.a.id)).verdict).toEqual({ ok: true });
  });

  test("AUDIT: verify-chain detects a truncated tail that link checks alone miss", async () => {
    const ownerB = await asPrincipal(h, "owner", h.b);
    await events(h.b.id, 4, "t");
    await anchorAll(h.db.anchor, h.clock.now());
    const [last] = await h.db.migrator`select id, seq from audit_events where tenant_id = ${h.b.id} order by seq desc limit 1`;
    await h.db.migrator`delete from audit_events where tenant_id = ${h.b.id} and seq >= ${Number(last!.seq) - 1}`;
    // The remaining prefix is a valid chain; only the anchor shows the cut.
    const r = await verdictOf(h.b.id);
    expect(r).toMatchObject({ against: "table", verdict: { ok: false, reason: "truncated", brokenAt: last!.id } });
    expect((await ownerB.get("/v1/audit-log/verify")).json).toEqual({ ok: false, brokenAt: last!.id, reason: "truncated" });
    // A later pass refuses to anchor over the break.
    const run = await anchorAll(h.db.anchor, h.clock.now());
    expect(run.broken.map((b) => b.tenantId)).toContain(h.b.id);
    expect((await verdictOf(h.b.id)).verdict).toMatchObject({ ok: false, reason: "truncated" });
  });

  test("AUDIT: verify-chain detects a chain rewritten with recomputed hashes", async () => {
    const t = h.a.id;
    await events(t, 2, "r");
    await anchorAll(h.db.anchor, h.clock.now());
    await rewriteChain(t);
    const r = await verdictOf(t);
    expect(r.verdict).toMatchObject({ ok: false, reason: "rewritten" });
  });

  test("AUDIT: a signed checkpoint file still catches truncation after the anchor table is gone", async () => {
    const own = await createHarness();
    try {
      for (let i = 0; i < 3; i++) {
        await withTenant(own.db.app, { tenantId: own.a.id }, (tx) =>
          writeAudit(tx, { actor: SYSTEM, action: "test.anchor", resource: { type: "test", id: `c${i}` } }, own.clock.now()));
      }
      await anchorAll(own.db.anchor, own.clock.now());
      const dir = mkdtempSync(join(tmpdir(), "offload-anchor-"));
      const path = writeCheckpointFile(dir, await exportCheckpoint(own.db.anchor, key, own.clock.now()));
      expect(() => writeCheckpointFile(dir, JSON.parse(readFileSync(path, "utf8")))).toThrow();
      const cp = JSON.parse(readFileSync(path, "utf8"));
      expect(await verifyCheckpoint(cp, key.publicJwk)).toBe(true);
      const env = { OFFLOAD_ANCHOR_PUBLIC_JWK: JSON.stringify(key.publicJwk) };
      expect((await verifyChainCommand(own.db.anchor, ["--checkpoint", path], env)).code).toBe(0);

      // A DB owner drops the anchors (bypassing the trigger) and cuts the chain's tail.
      await own.db.migrator.unsafe("alter table audit_anchors disable trigger user");
      await own.db.migrator`delete from audit_anchors`;
      await own.db.migrator`delete from audit_events where tenant_id = ${own.a.id} and seq = (select max(seq) from audit_events where tenant_id = ${own.a.id})`;
      expect((await verifyChainCommand(own.db.anchor, [], env)).code).toBe(0);
      const r = await verifyChainCommand(own.db.anchor, ["--checkpoint", path], env);
      expect(r.code).toBe(1);
      expect(r.lines.find((l) => l.includes(own.a.id))).toMatch(/^BROKEN .* truncated .*anchor: checkpoint/);

      // A tampered or foreign-signed checkpoint is rejected outright.
      writeFileSync(join(dir, "forged.json"), JSON.stringify({ ...cp, anchors: [] }));
      expect((await verifyChainCommand(own.db.anchor, ["--checkpoint", join(dir, "forged.json")], env)).lines[0]).toMatch(/bad signature/);
      const other = await generateEs256SigningKey("other");
      expect(await verifyCheckpoint(cp, other.publicJwk)).toBe(false);
      expect((await verifyChainCommand(own.db.anchor, ["--checkpoint", path], {})).code).toBe(2);
    } finally {
      await own.close();
    }
  });
});
