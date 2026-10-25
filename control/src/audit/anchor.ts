/**
 * External anchors for the audit chain (review wave A #9). The chain alone cannot show that its tail was cut or that
 * the table owner rewrote it with fresh hashes, so the anchoring job copies each tenant's head (seq, id, hash, time)
 * into audit_anchors, which only offload_anchor may insert into and nobody may change, and exports a signed checkpoint
 * file for storage outside the database. verify-chain checks the live chain against the latest of both.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { b64url, jcs } from "../schema/encoding.ts";
import { importEs256Public, verifyEs256, type Jwk, type SigningKey } from "../auth/jwt.ts";
import { latestAnchor, verifyChain, type AnchorPoint, type ChainVerdict } from "./audit.ts";

export interface TenantAnchor extends AnchorPoint {
  tenantId: string;
  at: number;
}

export interface Checkpoint {
  version: 1;
  issuedAt: number;
  kid: string;
  anchors: TenantAnchor[];
  /** base64url ES256 (r||s) over JCS of the checkpoint without `signature`. */
  signature: string;
}

async function tenantIds(db: Db): Promise<string[]> {
  return (await db`select id from tenants order by id`).map((r: { id: string }) => r.id);
}

export interface AnchorRun {
  anchored: TenantAnchor[];
  /** Tenants whose chain no longer matches their last anchor: never re-anchored over, so the break stays visible. */
  broken: Array<{ tenantId: string; verdict: ChainVerdict }>;
}

/**
 * One anchoring pass as offload_anchor: for every tenant whose head moved, verify the chain against its last anchor
 * and, only if it holds, append the new head.
 */
export async function anchorAll(db: Db, now: number): Promise<AnchorRun> {
  const out: AnchorRun = { anchored: [], broken: [] };
  for (const tenantId of await tenantIds(db)) {
    await withTenant(db, { tenantId, accessRole: "system" }, async (tx) => {
      const [head] = await tx`select seq, id, hash from audit_events order by seq desc limit 1`;
      if (!head) return;
      const last = await latestAnchor(tx);
      if (last && last.seq === Number(head.seq) && last.hash === head.hash) return;
      const verdict = await verifyChain(tx, last);
      if (!verdict.ok) {
        out.broken.push({ tenantId, verdict });
        return;
      }
      await tx`insert into audit_anchors (tenant_id, head_seq, head_id, head_hash, anchored_at_ms)
        values (${tenantId}, ${head.seq}, ${head.id}, ${head.hash}, ${now})`;
      out.anchored.push({ tenantId, seq: Number(head.seq), id: head.id, hash: head.hash, at: now });
    });
  }
  return out;
}

function unsigned(cp: Omit<Checkpoint, "signature">): string {
  return jcs({ version: cp.version, issuedAt: cp.issuedAt, kid: cp.kid, anchors: cp.anchors });
}

/** The latest anchor of every tenant, signed with the anchor key (not the device key). */
export async function exportCheckpoint(db: Db, key: SigningKey, now: number): Promise<Checkpoint> {
  const anchors: TenantAnchor[] = [];
  for (const tenantId of await tenantIds(db)) {
    await withTenant(db, { tenantId, accessRole: "system" }, async (tx) => {
      const [a] = await tx`select head_seq, head_id, head_hash, anchored_at_ms from audit_anchors
        order by head_seq desc limit 1`;
      if (a) anchors.push({ tenantId, seq: Number(a.head_seq), id: a.head_id, hash: a.head_hash, at: Number(a.anchored_at_ms) });
    });
  }
  const body = { version: 1 as const, issuedAt: now, kid: key.kid, anchors };
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(unsigned(body)));
  return { ...body, signature: b64url(sig) };
}

/** Writes `checkpoint-<issuedAt>.json` into `dir`; never overwrites an existing checkpoint. */
export function writeCheckpointFile(dir: string, cp: Checkpoint): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `checkpoint-${cp.issuedAt}.json`);
  writeFileSync(path, `${JSON.stringify(cp, null, 2)}\n`, { flag: "wx" });
  return path;
}

/** True when `cp` is well formed and signed by `publicJwk`. The key comes from config, never from the file. */
export async function verifyCheckpoint(cp: unknown, publicJwk: Jwk): Promise<boolean> {
  if (typeof cp !== "object" || cp === null) return false;
  const c = cp as Checkpoint;
  if (c.version !== 1 || typeof c.signature !== "string" || !Array.isArray(c.anchors)) return false;
  if (!publicJwk.crv || !publicJwk.x || !publicJwk.y) return false;
  try {
    const key = await importEs256Public({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y });
    return await verifyEs256(key, unsigned(c), c.signature);
  } catch {
    return false;
  }
}

export interface TenantResult {
  tenantId: string;
  /** Which anchor the chain was checked against: the newest of the table and the checkpoint. */
  against: "none" | "table" | "checkpoint";
  verdict: ChainVerdict | { ok: false; reason: "missing" };
}

/**
 * verify-chain: every tenant's chain against its latest table anchor and, when given, a verified checkpoint. A tenant
 * that the checkpoint names but the database no longer has is reported `missing`.
 */
export async function verifyAllChains(db: Db, checkpoint: Checkpoint | null = null): Promise<{ ok: boolean; tenants: TenantResult[] }> {
  const fromFile = new Map((checkpoint?.anchors ?? []).map((a) => [a.tenantId, a]));
  const tenants: TenantResult[] = [];
  const ids = await tenantIds(db);
  for (const tenantId of ids) {
    tenants.push(
      await withTenant(db, { tenantId, accessRole: "system" }, async (tx) => {
        const table = await latestAnchor(tx);
        const file = fromFile.get(tenantId) ?? null;
        const results: Array<[TenantResult["against"], ChainVerdict]> = [];
        if (table) results.push(["table", await verifyChain(tx, table)]);
        if (file) results.push(["checkpoint", await verifyChain(tx, file)]);
        if (results.length === 0) results.push(["none", await verifyChain(tx, null)]);
        const bad = results.find(([, v]) => !v.ok);
        if (bad) return { tenantId, against: bad[0], verdict: bad[1] };
        const against = file && (!table || file.seq >= table.seq) ? "checkpoint" : table ? "table" : "none";
        return { tenantId, against, verdict: { ok: true } } satisfies TenantResult;
      }),
    );
  }
  for (const tenantId of fromFile.keys()) {
    if (!ids.includes(tenantId)) tenants.push({ tenantId, against: "checkpoint", verdict: { ok: false, reason: "missing" } });
  }
  return { ok: tenants.every((t) => t.verdict.ok), tenants };
}
