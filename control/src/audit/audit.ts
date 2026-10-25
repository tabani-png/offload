import type { Tx } from "../db/pool.ts";
import { jcs, sha256Hex, ulid } from "../schema/encoding.ts";
import type { AccessRole } from "../rbac/permissions.ts";

/** The audit-event DTO (schemas/stage2/audit-event.schema.json). */
export interface AuditEvent {
  id: string;
  at: number;
  actor: { type: "person" | "device" | "service" | "support" | "system"; id: string | null; accessRole: AccessRole | null };
  action: string;
  subjectPersonId: string | null;
  resource: { type: string; id: string | null };
  detail: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

export type AuditInput = Omit<AuditEvent, "id" | "at" | "prevHash" | "hash" | "subjectPersonId" | "detail"> & {
  subjectPersonId?: string | null;
  detail?: Record<string, unknown>;
};

/** hash = sha256(prevHash || JCS(event without hash)) (ADR 0108 §5). */
export function chainHash(e: Omit<AuditEvent, "hash">): string {
  return sha256Hex((e.prevHash ?? "") + jcs(e));
}

interface AuditRow {
  id: string;
  at_ms: string | number;
  actor_type: AuditEvent["actor"]["type"];
  actor_id: string | null;
  actor_role: AccessRole | null;
  action: string;
  subject_person_id: string | null;
  resource_type: string;
  resource_id: string | null;
  detail: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
}

export function auditDto(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    at: Number(r.at_ms),
    actor: { type: r.actor_type, id: r.actor_id, accessRole: r.actor_role },
    action: r.action,
    subjectPersonId: r.subject_person_id,
    resource: { type: r.resource_type, id: r.resource_id },
    detail: r.detail,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/**
 * Appends one event to the tenant's chain inside the caller's transaction, so a rolled-back mutation leaves no event.
 * A per-tenant advisory lock serialises writers; UNIQUE (tenant_id, prev_hash) makes a fork impossible regardless.
 */
export async function writeAudit(tx: Tx, input: AuditInput, now: number): Promise<AuditEvent> {
  await tx`select pg_advisory_xact_lock(hashtextextended('audit:' || current_setting('app.tenant_id'), 0))`;
  const [last] = await tx`select hash from audit_events order by seq desc limit 1`;
  const base: Omit<AuditEvent, "hash"> = {
    id: ulid(now),
    at: now,
    actor: input.actor,
    action: input.action,
    subjectPersonId: input.subjectPersonId ?? null,
    resource: input.resource,
    detail: input.detail ?? {},
    prevHash: (last?.hash as string | undefined) ?? null,
  };
  const hash = chainHash(base);
  await tx`insert into audit_events (tenant_id, id, at_ms, actor_type, actor_id, actor_role, action,
      subject_person_id, resource_type, resource_id, detail, prev_hash, hash)
    values (current_setting('app.tenant_id')::uuid, ${base.id}, ${base.at}, ${base.actor.type}, ${base.actor.id},
      ${base.actor.accessRole}, ${base.action}, ${base.subjectPersonId}, ${base.resource.type}, ${base.resource.id},
      ${base.detail}::jsonb, ${base.prevHash}, ${hash})`;
  return { ...base, hash };
}

/** A chain head copied out of the app's reach (audit_anchors, signed checkpoint files). */
export interface AnchorPoint {
  seq: number;
  id: string;
  hash: string;
}

export type ChainVerdict =
  | { ok: true }
  | { ok: false; brokenAt: string; reason: "link" | "truncated" | "rewritten" };

/**
 * Recomputes the tenant's chain. `brokenAt` is the first event whose hash or link does not match. With an anchor, the
 * chain must still reach the anchored seq with the anchored event and hash: a shorter chain was truncated, a different
 * event or hash there means the chain was rewritten (links alone cannot tell, the table owner can recompute them).
 */
export async function verifyChain(tx: Tx, anchor: AnchorPoint | null = null): Promise<ChainVerdict> {
  const rows = (await tx`select * from audit_events order by seq`) as Array<AuditRow & { seq: string | number }>;
  let prev: string | null = null;
  let atAnchor: { id: string; hash: string } | null = null;
  let headSeq = 0;
  for (const r of rows) {
    const e = auditDto(r);
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || chainHash(rest) !== hash) return { ok: false, brokenAt: e.id, reason: "link" };
    prev = hash;
    headSeq = Number(r.seq);
    if (anchor && headSeq === anchor.seq) atAnchor = { id: e.id, hash };
  }
  if (anchor) {
    if (headSeq < anchor.seq) return { ok: false, brokenAt: anchor.id, reason: "truncated" };
    if (!atAnchor || atAnchor.id !== anchor.id || atAnchor.hash !== anchor.hash) {
      return { ok: false, brokenAt: anchor.id, reason: "rewritten" };
    }
  }
  return { ok: true };
}

/** The tenant's latest anchor from audit_anchors, or null before the first anchoring run. */
export async function latestAnchor(tx: Tx): Promise<AnchorPoint | null> {
  const [a] = await tx`select head_seq, head_id, head_hash from audit_anchors order by head_seq desc limit 1`;
  return a ? { seq: Number(a.head_seq), id: a.head_id as string, hash: a.head_hash as string } : null;
}

export interface AuditQuery {
  action?: string;
  subjectPersonId?: string;
  from?: number;
  to?: number;
  afterSeq?: number;
  limit: number;
}

export async function listAudit(tx: Tx, q: AuditQuery): Promise<{ events: AuditEvent[]; seqs: number[] }> {
  const rows = (await tx`select * from audit_events
    where (${q.action ?? null}::text is null or action = ${q.action ?? null})
      and (${q.subjectPersonId ?? null}::uuid is null or subject_person_id = ${q.subjectPersonId ?? null}::uuid)
      and (${q.from ?? null}::bigint is null or at_ms >= ${q.from ?? null}::bigint)
      and (${q.to ?? null}::bigint is null or at_ms < ${q.to ?? null}::bigint)
      and seq > ${q.afterSeq ?? 0}
    order by seq limit ${q.limit}`) as Array<AuditRow & { seq: string }>;
  return { events: rows.map(auditDto), seqs: rows.map((r) => Number(r.seq)) };
}
