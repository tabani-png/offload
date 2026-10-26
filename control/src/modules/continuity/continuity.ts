/**
 * Continuity (SPEC S2-10, ADR 0107): freeze, hand-overs, successors, the run gate, the sweep. One object per app,
 * bound to the app's deps when routes are mounted (index.ts). Other modules reach it with `continuityOf(ports)`.
 */
import type { Deps } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid, withTenant } from "../../db/tenant.ts";
import type { AuditInput } from "../../audit/audit.ts";
import { revokeAccess, type ContinuityPort, type FreezeReason } from "../../ports.ts";
import { conflict, invalid, notFound } from "../../schema/http.ts";
import type { Broker } from "../broker/broker.ts";
import type { RegistryApi } from "../registry/port.ts";
import { DEPART_AFTER_DAYS, GONE, PROPOSALS_KEPT_DAYS, canTransition, type PersonState } from "./states.ts";

export type Actor = AuditInput["actor"];
export const SYSTEM: Actor = { type: "system", id: null, accessRole: null };
const DAY_MS = 86_400_000;

export type OffboardReason = "directory_deactivated" | "admin" | "end_date";
export type InFlight = "pause" | "handover_message" | "stop";
export type InboxStep = "google_migrate" | "google_alias" | "google_archive" | "m365_shared_mailbox" | "none";
export type Successor = { type: "person"; personId: string } | { type: "role_identity"; roleIdentityId: string };

export interface HandoverDto {
  id: string;
  personId: string;
  workflowId: string;
  state: "open" | "assigned" | "closed";
  successor: Successor | null;
  inFlight: InFlight;
  inboxStep: InboxStep | null;
  removedConnections: string[];
  assignedBy: string | null;
  assignedAt: number | null;
}

export interface FreezeRequest {
  reason: OffboardReason;
  source: FreezeReason["source"];
  detail?: string;
  actor: Actor;
  requestedBy: string | null;
  note?: string;
  effectiveOn?: string | null;
}

export interface LeavingRequest {
  reason: OffboardReason;
  effectiveOn: string;
  actor: Actor;
  requestedBy: string | null;
  note?: string;
}

/** The identity a resumed run sends as. A person successor sends through their own connections (no override). */
export interface RunIdentity {
  type: "person" | "role_identity";
  id: string;
  connectionId: string | null;
  signature: string | null;
}

export interface RunCheck {
  workflowId: string;
  identity: { type: "person" | "role_identity"; id: string };
  runnerPersonId: string;
}

export type HoldReason = "awaiting_handover" | "awaiting_successor";

export interface Refusal {
  code: "forbidden";
  reason: "identity_gone" | HoldReason;
  message: string;
}

export interface SweepResult {
  departed: number;
  frozen: number;
  leavingOpened: number;
  paused: number;
}

export interface Continuity extends ContinuityPort {
  readonly isContinuity: true;
  /** Freezes with the full request (API and sweep). False when the person is not active or leaving. */
  freezeWith(tx: Tx, personId: string, req: FreezeRequest): Promise<boolean>;
  /** active/leaving → leaving with an end date; opens hand-overs early (everything keeps running). */
  markLeaving(tx: Tx, personId: string, req: LeavingRequest): Promise<void>;
  /** Why the workflow may not run now (a departed/frozen person's hand-over not ready), or null. */
  held(tx: Tx, workflowId: string): Promise<HoldReason | null>;
  /** Whether the workflow is held, and the identity resumed runs use (null: no hand-over switched it). */
  runAs(tx: Tx, workflowId: string): Promise<{ held: boolean; identity: RunIdentity | null }>;
  /** A run's refusal (identity or runner frozen/departed, or the workflow held), audited; null when it may run. */
  checkRun(tx: Tx, run: RunCheck): Promise<Refusal | null>;
  assign(tx: Tx, h: HandoverRow, by: { personId: string; actor: Actor }, input: { successor: Successor; inFlight?: InFlight; inboxStep?: InboxStep | null }): Promise<HandoverDto>;
  accept(tx: Tx, h: HandoverRow, by: { personId: string; actor: Actor }, input: { reviewedHandoverMessage?: boolean }): Promise<HandoverDto>;
  close(tx: Tx, h: HandoverRow, by: { personId: string; actor: Actor }): Promise<HandoverDto>;
  /** Locks the hand-over's leaver (people row), then the hand-over; null when there is none. */
  lockHandover(tx: Tx, id: string): Promise<HandoverRow | null>;
  /** One pass for one tenant: departures, end dates, early hand-overs for leavers, pending worker pauses. */
  sweep(tenantId: string): Promise<SweepResult>;
  /** Resolves when every after-commit follow-up started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
}

export interface HandoverRow {
  id: string;
  person_id: string;
  workflow_id: string;
  job_role_id: string;
  department_id: string;
  state: HandoverDto["state"];
  successor_type: Successor["type"] | null;
  successor_person_id: string | null;
  successor_role_identity_id: string | null;
  accepted_at: Date | null;
  in_flight: InFlight;
  inbox_step: InboxStep | null;
  message_reviewed_at: Date | null;
  removed_connections: string[];
  assigned_by: string | null;
  assigned_at: Date | null;
}

export const HANDOVER_COLUMNS = `id, person_id, workflow_id, job_role_id, department_id, state, successor_type, successor_person_id,
  successor_role_identity_id, accepted_at, in_flight, inbox_step, message_reviewed_at, removed_connections, assigned_by, assigned_at`;

export function handoverDto(r: HandoverRow): HandoverDto {
  const successor: Successor | null =
    r.successor_type === "person"
      ? { type: "person", personId: r.successor_person_id! }
      : r.successor_type === "role_identity"
        ? { type: "role_identity", roleIdentityId: r.successor_role_identity_id! }
        : null;
  return {
    id: r.id,
    personId: r.person_id,
    workflowId: r.workflow_id,
    state: r.state,
    successor,
    inFlight: r.in_flight,
    inboxStep: r.inbox_step ?? null,
    removedConnections: r.removed_connections,
    assignedBy: r.assigned_by ?? null,
    assignedAt: r.assigned_at ? r.assigned_at.getTime() : null,
  };
}

/** Ready = the successor can run it: a role identity at once, a person once they accepted (and reviewed the message). */
const READY = `(h.successor_type = 'role_identity' or (h.successor_type = 'person' and h.accepted_at is not null
  and (h.in_flight <> 'handover_message' or h.message_reviewed_at is not null)))`;

function ready(h: HandoverRow): boolean {
  if (h.successor_type === "role_identity") return true;
  return h.successor_type === "person" && h.accepted_at !== null && (h.in_flight !== "handover_message" || h.message_reviewed_at !== null);
}

/** Today in the tenant's reporting timezone, as YYYY-MM-DD. */
export async function tenantToday(tx: Tx, now: number): Promise<string> {
  const [t] = await tx`select reporting_timezone from tenants where id = current_setting('app.tenant_id')::uuid`;
  const tz = (t?.reporting_timezone as string | undefined) ?? "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

function isForeignKeyViolation(e: unknown): boolean {
  const x = e as { errno?: unknown; code?: unknown };
  return x?.errno === "23503" || x?.code === "23503";
}

/** Serializes a person's freeze with its after-commit follow-up (the follow-up waits for the freeze to end). */
const lockKey = (personId: string) => `continuity:${personId}`;

export function createContinuity(deps: Deps): Continuity {
  const now = () => deps.clock.now();
  const inflight = new Set<Promise<void>>();
  /**
   * Audit events a freeze queues until its last row lock: writing one takes the tenant's audit-chain lock, which the
   * broker's lock order (broker.ts, step 10) keeps last. `flushQueued` writes them in order.
   */
  const queued = new WeakMap<Tx, AuditInput[]>();
  const audit = async (tx: Tx, e: AuditInput): Promise<void> => {
    const q = queued.get(tx);
    if (q) q.push(e);
    else await deps.ports.audit.write(tx, e);
  };
  async function flushQueued(tx: Tx): Promise<void> {
    const q = queued.get(tx);
    queued.delete(tx);
    for (const e of q ?? []) await deps.ports.audit.write(tx, e);
  }

  async function event(tx: Tx, handoverId: string, kind: string, actor: Actor, detail: Record<string, unknown> = {}) {
    await tx`insert into handover_events (tenant_id, handover_id, kind, actor_type, actor_id, detail, at)
      values (current_setting('app.tenant_id')::uuid, ${handoverId}, ${kind}, ${actor.type === "system" ? "system" : "person"},
        ${actor.type === "system" ? null : actor.id}, ${detail}::jsonb, ${new Date(now())})`;
  }

  async function personState(tx: Tx, personId: string, lock = false): Promise<PersonState | null> {
    const [p] = lock
      ? await tx`select state from people where id = ${personId} for update`
      : await tx`select state from people where id = ${personId}`;
    return (p?.state as PersonState | undefined) ?? null;
  }

  /**
   * Revokes approvals, pauses policies and workers through the S2-07 broker (its full API when loaded, else the frozen
   * port). `stopRunsFor` revokes the person's tokens itself, then writes its audit events and so takes the audit-chain
   * lock before it returns: it is called after every row lock the freeze takes (ADR 0113 §4, broker.ts lock order).
   *
   * `stopRunsFor` also calls `WorkersPort.pauseFor`, a remote service. Offboarding is never blocked by it: the call runs
   * in a savepoint, and when it fails only the tokens are revoked here; policies and workers are paused after commit
   * from the durable `offboardings.pause_pending` marker (`pausePending`, retried by the sweep until delivered). A
   * frozen person's policy cannot send meanwhile: the broker refuses a runner who is not active, at every call.
   */
  async function stopRuns(tx: Tx, personId: string): Promise<{ tokens: number; policies: number; deferred: boolean }> {
    const b = deps.ports.broker as Partial<Broker>;
    if (b.isFullBroker === true && b.stopRunsFor && b.revokeTokensFor) {
      try {
        const s = await tx.savepoint((sp) => b.stopRunsFor!(sp as unknown as Tx, personId));
        return { tokens: s.tokens, policies: s.policies, deferred: false };
      } catch (e) {
        console.warn("continuity: stopping runs failed in the freeze; policies and workers are paused after commit:", e instanceof Error ? e.message : e);
        return { tokens: await b.revokeTokensFor(tx, personId), policies: 0, deferred: true };
      }
    }
    return { tokens: await deps.ports.broker.revokeTokensOf(tx, personId), policies: 0, deferred: false };
  }

  /** Writes the S2-10 audit events of `fn` after its last row lock (the audit-chain lock stays last). */
  async function deferAudits<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
    if (queued.has(tx)) return fn();
    queued.set(tx, []);
    try {
      const r = await fn();
      await flushQueued(tx);
      return r;
    } finally {
      queued.delete(tx);
    }
  }

  /** Lock order step 2 up front: the person's active policies (by id), before the connection deletes below take a KEY
   * SHARE on batches that reference them (step 3). `stopRunsFor` re-takes the same locks. */
  async function lockPolicies(tx: Tx, personId: string): Promise<void> {
    const b = deps.ports.broker as Partial<Broker>;
    if (b.isFullBroker !== true) return;
    await tx`select id from overnight_policies where owner_person_id = ${personId} and state = 'active' order by id for no key update`;
  }

  /**
   * Removes every personal-allowed / personal-forbidden connection of the person, LinkedIn included (ADR 0107 §2, §6).
   * A connection that history (a batch) still references cannot be deleted: its credential reference is erased instead
   * (ADR 0113 §2), which leaves nothing Offload could send through.
   */
  async function removePersonalConnections(tx: Tx, personId: string, actor: Actor): Promise<string[]> {
    const rows = (await tx`select id, kind, ownership from connections where owner_person_id = ${personId}
      and (ownership in ('personal-allowed', 'personal-forbidden') or kind = 'linkedin_personal') order by id`) as Array<{
      id: string;
      kind: string;
      ownership: string;
    }>;
    const at = new Date(now());
    for (const r of rows) {
      let mode: "deleted" | "erased" = "deleted";
      try {
        await tx.savepoint(async (sp) => {
          await sp`delete from connections where id = ${r.id}`;
        });
      } catch (e) {
        if (!isForeignKeyViolation(e)) throw e;
        mode = "erased";
        await tx`update connections set external_ref = '', health = 'failed' where id = ${r.id}`;
      }
      await tx`insert into removed_connections (tenant_id, connection_id, person_id, kind, ownership, mode, removed_at)
        values (current_setting('app.tenant_id')::uuid, ${r.id}, ${personId}, ${r.kind}, ${r.ownership}, ${mode}, ${at})
        on conflict do nothing`;
      await audit(tx, {
        actor,
        action: "connection.removed",
        subjectPersonId: personId,
        resource: { type: "connection", id: r.id },
        detail: { kind: r.kind, ownership: r.ownership, mode, reason: "offboarding" },
      });
    }
    return rows.map((r) => r.id);
  }

  /** One hand-over per role workflow the person runs or owns (unpromoted proposals stay with the registry, ADR 0107 §7). */
  async function openHandovers(tx: Tx, personId: string, removed: string[], actor: Actor): Promise<number> {
    const reg = deps.ports.registry as Partial<RegistryApi>;
    if (typeof reg.getVersion !== "function") throw new Error("continuity: the S2-06 registry port is not loaded");
    let opened = 0;
    for (const workflowId of await deps.ports.registry.workflowsOf(tx, personId)) {
      // Job role and department are the workflow's, the same at every version; version 1 exists for every role workflow.
      const v = await reg.getVersion(tx, workflowId, 1);
      if (!v || v.state !== "role") continue;
      const [h] = await tx`insert into handovers (tenant_id, person_id, workflow_id, job_role_id, department_id,
          removed_connections, created_at)
        values (current_setting('app.tenant_id')::uuid, ${personId}, ${workflowId}, ${v.jobRoleId}, ${v.departmentId},
          ${removed}::jsonb, ${new Date(now())})
        on conflict (tenant_id, person_id, workflow_id) do nothing returning id`;
      if (!h) continue;
      opened++;
      await event(tx, h.id as string, "opened", actor, { workflowId });
      await audit(tx, {
        actor,
        action: "handover.opened",
        subjectPersonId: personId,
        resource: { type: "handover", id: h.id as string },
        detail: { workflowId, jobRoleId: v.jobRoleId, departmentId: v.departmentId },
      });
    }
    return opened;
  }

  function resumeIdentity(h: HandoverRow): { type: Successor["type"]; id: string } {
    return h.successor_type === "person"
      ? { type: "person", id: h.successor_person_id! }
      : { type: "role_identity", id: h.successor_role_identity_id! };
  }

  /** Sending resumes under the successor's identity: recorded once the leaver is gone and the successor is ready. */
  async function resumed(tx: Tx, h: HandoverRow, actor: Actor): Promise<void> {
    const identity = resumeIdentity(h);
    await event(tx, h.id, "resumed", actor, { identity });
    await audit(tx, {
      actor,
      action: "handover.resumed",
      subjectPersonId: h.person_id,
      resource: { type: "handover", id: h.id },
      detail: { workflowId: h.workflow_id, identity },
    });
  }

  async function handoverById(tx: Tx, id: string, lock = false): Promise<HandoverRow> {
    const [h] = lock
      ? await tx.unsafe(`select ${HANDOVER_COLUMNS} from handovers where id = $1 for update`, [id])
      : await tx.unsafe(`select ${HANDOVER_COLUMNS} from handovers where id = $1`, [id]);
    if (!h) throw notFound();
    return h as HandoverRow;
  }

  /** Pauses the person's cloud workers in its own transaction, after the freeze committed; audited. */
  async function pausePending(tx: Tx, personId: string): Promise<boolean> {
    const [o] = await tx`select pause_pending from offboardings where person_id = ${personId} for update`;
    if (!o?.pause_pending) return false;
    // The full broker pauses policies and workers (and revokes any token left); without it, the workers port alone.
    const b = deps.ports.broker as Partial<Broker>;
    const workers =
      b.isFullBroker === true && b.stopRunsFor ? (await b.stopRunsFor(tx, personId)).workers : await deps.ports.workers.pauseFor(tx, personId);
    await tx`update offboardings set pause_pending = false, paused_at = ${new Date(now())} where person_id = ${personId}`;
    await audit(tx, {
      actor: SYSTEM,
      action: "person.workers_paused",
      subjectPersonId: personId,
      resource: { type: "person", id: personId },
      detail: { workers },
    });
    return true;
  }

  /**
   * After-commit follow-up: waits on the freeze transaction's advisory lock (released at commit or rollback), then
   * pauses workers only if the freeze committed. A failure leaves `pause_pending` for the sweep.
   */
  function afterFreeze(tenantId: string, personId: string): void {
    const job = (async () => {
      await Promise.resolve();
      try {
        await withTenant(deps.db, { tenantId, accessRole: "system" }, async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${lockKey(personId)}))`;
          await pausePending(tx, personId);
        });
      } catch {
        console.warn("continuity: worker pause deferred to the sweep");
      }
    })();
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
  }

  async function departIfDone(tx: Tx, personId: string, actor: Actor, after30Days: boolean): Promise<boolean> {
    const state = await personState(tx, personId, true);
    if (state === null || !canTransition(state, "depart")) return false;
    const [open] = await tx`select count(*)::int as n from handovers where person_id = ${personId} and state <> 'closed'`;
    const allClosed = Number(open!.n) === 0;
    if (!allClosed && !after30Days) return false;
    const at = now();
    await tx`update people set state = 'departed' where id = ${personId}`;
    await tx`update offboardings set state = 'departed', departed_at = ${new Date(at)},
        proposals_kept_until = ${new Date(at + PROPOSALS_KEPT_DAYS * DAY_MS)}
      where person_id = ${personId}`;
    await audit(tx, {
      actor,
      action: "person.departed",
      subjectPersonId: personId,
      resource: { type: "person", id: personId },
      detail: { cause: allClosed ? "handovers_closed" : "after_30_days", openHandovers: Number(open!.n) },
    });
    return true;
  }

  async function freezeWith(tx: Tx, personId: string, req: FreezeRequest): Promise<boolean> {
    const state = await personState(tx, personId, true);
    if (state === null || !canTransition(state, "freeze")) return false;
    const [t] = await tx`select current_setting('app.tenant_id') as tenant`;
    await tx`select pg_advisory_xact_lock(hashtext(${lockKey(personId)}))`;
    const at = now();
    // Lock order: person and its advisory lock (S2-10's own, before step 1), the person's policies (2), then S2-10's
    // rows; the broker's stopRunsFor (2-9, then the audit lock, 10) and the queued audit events come last.
    await lockPolicies(tx, personId);
    await deferAudits(tx, async () => {
      await tx`update people set state = 'frozen', pending_freeze_at = ${new Date(at)} where id = ${personId}`;
      const access = await revokeAccess(tx, personId, at);
      const removed = await removePersonalConnections(tx, personId, req.actor);
      await tx`insert into offboardings (tenant_id, person_id, state, reason, effective_on, note, requested_by, created_at,
          frozen_at, pause_pending)
        values (current_setting('app.tenant_id')::uuid, ${personId}, 'frozen', ${req.reason}, ${req.effectiveOn ?? null}::date,
          ${req.note ?? ""}, ${req.requestedBy}, ${new Date(at)}, ${new Date(at)}, true)
        on conflict (tenant_id, person_id) do update set state = 'frozen', reason = excluded.reason,
          effective_on = coalesce(excluded.effective_on, offboardings.effective_on),
          note = case when excluded.note <> '' then excluded.note else offboardings.note end,
          requested_by = coalesce(excluded.requested_by, offboardings.requested_by),
          frozen_at = excluded.frozen_at, pause_pending = true`;
      const opened = await openHandovers(tx, personId, removed, req.actor);
      await tx`update handovers set removed_connections = ${removed}::jsonb where person_id = ${personId} and state <> 'closed'`;
      // Hand-overs that were settled while the person was leaving resume now, under the successor.
      for (const h of (await tx.unsafe(
        `select ${HANDOVER_COLUMNS} from handovers h where person_id = $1 and state <> 'closed' and ${READY} order by id`,
        [personId],
      )) as HandoverRow[]) {
        await resumed(tx, h, req.actor);
      }
      // Last: the broker takes its own row locks (steps 2-9) and then the audit-chain lock (10).
      const runs = await stopRuns(tx, personId);
      await audit(tx, {
        actor: req.actor,
        action: "person.freeze",
        subjectPersonId: personId,
        resource: { type: "person", id: personId },
        // `pending`: the after-commit worker pause is still to come (S2-01 contract of this event).
        detail: {
          pending: true,
          source: req.source,
          ...(req.detail !== undefined ? { detail: req.detail } : {}),
          reason: req.reason,
          ...access,
          tokens: runs.tokens,
          policies: runs.policies,
          ...(runs.deferred ? { runsStopDeferred: true } : {}),
          connectionsRemoved: removed.length,
          handoversOpened: opened,
        },
      });
    });
    afterFreeze(t!.tenant as string, personId);
    return true;
  }

  async function markLeaving(tx: Tx, personId: string, req: LeavingRequest): Promise<void> {
    const state = await personState(tx, personId, true);
    if (state === null) throw notFound();
    if (!canTransition(state, "set_end_date")) throw conflict(`a ${state} person cannot get an end date`);
    const at = new Date(now());
    await tx`update people set state = 'leaving', leaving_on = ${req.effectiveOn}::date where id = ${personId}`;
    await tx`insert into offboardings (tenant_id, person_id, state, reason, effective_on, note, requested_by, created_at)
      values (current_setting('app.tenant_id')::uuid, ${personId}, 'leaving', ${req.reason}, ${req.effectiveOn}::date,
        ${req.note ?? ""}, ${req.requestedBy}, ${at})
      on conflict (tenant_id, person_id) do update set reason = excluded.reason, effective_on = excluded.effective_on,
        note = excluded.note, requested_by = coalesce(excluded.requested_by, offboardings.requested_by)`;
    await openHandovers(tx, personId, [], req.actor);
  }

  async function held(tx: Tx, workflowId: string): Promise<HoldReason | null> {
    const rows = (await tx.unsafe(
      `select h.state, ${READY} as ready from handovers h join people p on p.tenant_id = h.tenant_id and p.id = h.person_id
        where h.workflow_id = $1 and h.state <> 'closed' and p.state in ('frozen', 'departed')`,
      [workflowId],
    )) as Array<{ state: string; ready: boolean }>;
    if (rows.some((r) => r.state === "open")) return "awaiting_handover";
    if (rows.some((r) => !r.ready)) return "awaiting_successor";
    return null;
  }

  async function runAs(tx: Tx, workflowId: string): Promise<{ held: boolean; identity: RunIdentity | null }> {
    if ((await held(tx, workflowId)) !== null) return { held: true, identity: null };
    const [h] = (await tx.unsafe(
      `select h.successor_type, h.successor_person_id, h.successor_role_identity_id, r.connection_id, r.signature
        from handovers h join people p on p.tenant_id = h.tenant_id and p.id = h.person_id
        left join role_identities r on r.tenant_id = h.tenant_id and r.id = h.successor_role_identity_id
        where h.workflow_id = $1 and h.state <> 'open' and p.state in ('frozen', 'departed') and ${READY}
        order by h.assigned_at desc, h.id limit 1`,
      [workflowId],
    )) as Array<Record<string, string | null>>;
    if (!h) return { held: false, identity: null };
    if (h.successor_type === "role_identity") {
      return {
        held: false,
        identity: { type: "role_identity", id: h.successor_role_identity_id!, connectionId: h.connection_id ?? null, signature: h.signature ?? null },
      };
    }
    return { held: false, identity: { type: "person", id: h.successor_person_id!, connectionId: null, signature: null } };
  }

  async function checkRun(tx: Tx, run: RunCheck): Promise<Refusal | null> {
    const people = [...new Set([run.runnerPersonId, ...(run.identity.type === "person" ? [run.identity.id] : [])])];
    for (const personId of people) {
      const [g] = await tx`select p.state from people p join offboardings o on o.tenant_id = p.tenant_id and o.person_id = p.id
        where p.id = ${personId} and p.state in ('frozen', 'departed')`;
      if (!g) continue;
      await audit(tx, {
        actor: SYSTEM,
        action: "run.identity_refused",
        subjectPersonId: personId,
        resource: { type: "workflow", id: run.workflowId },
        detail: { workflowId: run.workflowId, identity: run.identity, runnerPersonId: run.runnerPersonId, state: g.state },
      });
      return { code: "forbidden", reason: "identity_gone", message: "never sends as a frozen or departed person: use the hand-over successor" };
    }
    const why = await held(tx, run.workflowId);
    if (why === null) return null;
    await audit(tx, {
      actor: SYSTEM,
      action: "run.held",
      subjectPersonId: null,
      resource: { type: "workflow", id: run.workflowId },
      detail: { workflowId: run.workflowId, identity: run.identity, runnerPersonId: run.runnerPersonId, reason: why },
    });
    return {
      code: "forbidden",
      reason: why,
      message: why === "awaiting_handover" ? "the workflow waits for a hand-over successor" : "the workflow waits for its successor to accept",
    };
  }

  async function assign(
    tx: Tx,
    h: HandoverRow,
    by: { personId: string; actor: Actor },
    input: { successor: Successor; inFlight?: InFlight; inboxStep?: InboxStep | null },
  ): Promise<HandoverDto> {
    if (h.state === "closed") throw conflict("this hand-over is closed");
    const inFlight = input.inFlight ?? "pause";
    const inboxStep = input.inboxStep === undefined ? (h.inbox_step ?? null) : input.inboxStep;
    const s = input.successor;
    if (inFlight === "handover_message" && s.type !== "person") {
      throw invalid("a hand-over message is written and reviewed by a person successor, not a role identity");
    }
    if (s.type === "person") {
      if (s.personId === h.person_id) throw conflict("the leaver cannot be their own successor");
      const [p] = await tx`select p.state, exists (select 1 from job_role_holders j where j.person_id = p.id
          and j.job_role_id = ${h.job_role_id}) as holds
        from people p where p.id = ${s.personId}`;
      if (!p || !["active", "leaving"].includes(p.state as string)) throw conflict("the successor must be an active person");
      if (!p.holds) throw conflict("the successor must hold the workflow's job role");
    } else {
      const [r] = await tx`select job_role_id from role_identities where id = ${s.roleIdentityId}`;
      if (!r || r.job_role_id !== h.job_role_id) throw conflict("the role identity must belong to the workflow's job role");
    }
    const at = new Date(now());
    const isPerson = s.type === "person";
    await tx`update handovers set state = 'assigned', successor_type = ${s.type},
        successor_person_id = ${isPerson ? s.personId : null}, successor_role_identity_id = ${isPerson ? null : s.roleIdentityId},
        accepted_at = ${isPerson ? null : at}, message_reviewed_at = null, in_flight = ${inFlight}, inbox_step = ${inboxStep},
        assigned_by = ${by.personId}, assigned_at = ${at}
      where id = ${h.id}`;
    const detail = { workflowId: h.workflow_id, successor: s, inFlight, inboxStep };
    await event(tx, h.id, "assigned", by.actor, detail);
    await audit(tx, { actor: by.actor, action: "handover.assigned", subjectPersonId: h.person_id, resource: { type: "handover", id: h.id }, detail });
    // The named successor is the subject of their own event, so it is in their access log and export (ADR 0108 §4).
    if (isPerson) {
      await audit(tx, {
        actor: by.actor,
        action: "handover.successor_named",
        subjectPersonId: s.personId,
        resource: { type: "handover", id: h.id },
        detail: { workflowId: h.workflow_id, leaverPersonId: h.person_id, inFlight, inboxStep },
      });
    }
    const after = await handoverById(tx, h.id);
    if (ready(after) && GONE.includes((await personState(tx, h.person_id))!)) await resumed(tx, after, by.actor);
    return handoverDto(after);
  }

  async function accept(tx: Tx, h: HandoverRow, by: { personId: string; actor: Actor }, input: { reviewedHandoverMessage?: boolean }): Promise<HandoverDto> {
    if (h.state === "closed") throw conflict("this hand-over is closed");
    if (h.accepted_at !== null) throw conflict("already accepted");
    if (h.in_flight === "handover_message" && input.reviewedHandoverMessage !== true) {
      throw conflict("review the one-time hand-over message first (reviewedHandoverMessage: true)");
    }
    const [p] = await tx`select p.state, exists (select 1 from job_role_holders j where j.person_id = p.id
        and j.job_role_id = ${h.job_role_id}) as holds
      from people p where p.id = ${by.personId}`;
    if (!p || !["active", "leaving"].includes(p.state as string) || !p.holds) {
      throw conflict("only an active holder of the workflow's job role can accept it");
    }
    const at = new Date(now());
    const reviewed = h.in_flight === "handover_message";
    await tx`update handovers set accepted_at = ${at}, message_reviewed_at = ${reviewed ? at : null} where id = ${h.id}`;
    await event(tx, h.id, "accepted", by.actor, { workflowId: h.workflow_id });
    if (reviewed) await event(tx, h.id, "message_reviewed", by.actor, { workflowId: h.workflow_id });
    await audit(tx, {
      actor: by.actor,
      action: "handover.accepted",
      subjectPersonId: h.person_id,
      resource: { type: "handover", id: h.id },
      detail: { workflowId: h.workflow_id, inFlight: h.in_flight, reviewedHandoverMessage: reviewed },
    });
    const after = await handoverById(tx, h.id);
    if (GONE.includes((await personState(tx, h.person_id))!)) await resumed(tx, after, by.actor);
    return handoverDto(after);
  }

  async function close(tx: Tx, h: HandoverRow, by: { personId: string; actor: Actor }): Promise<HandoverDto> {
    if (h.state === "closed") throw conflict("this hand-over is already closed");
    if (h.state === "open") throw conflict("assign a successor before closing the hand-over");
    if (!ready(h)) throw conflict("the successor has not accepted yet");
    const at = new Date(now());
    await tx`update handovers set state = 'closed', closed_by = ${by.personId}, closed_at = ${at} where id = ${h.id}`;
    await event(tx, h.id, "closed", by.actor, { workflowId: h.workflow_id });
    await audit(tx, { actor: by.actor, action: "handover.closed", subjectPersonId: h.person_id, resource: { type: "handover", id: h.id }, detail: { workflowId: h.workflow_id } });
    await departIfDone(tx, h.person_id, by.actor, false);
    return handoverDto(await handoverById(tx, h.id));
  }

  /**
   * S2-10 lock order (before the broker's step 1, see broker.ts): the leaver's people row, then `continuity:<person>`
   * (freeze only), then hand-over rows (by id), then offboardings; the broker's rows next; the audit-chain lock last.
   * Locks the hand-over's leaver, then the hand-over, so a close (which may depart the leaver) never holds a hand-over
   * while waiting for a person a freeze holds.
   */
  async function lockHandover(tx: Tx, id: string): Promise<HandoverRow | null> {
    const [r] = await tx`select person_id from handovers where id = ${id}`;
    if (!r) return null;
    await tx`select 1 from people where id = ${r.person_id as string} for update`;
    return handoverById(tx, id, true);
  }

  async function sweep(tenantId: string): Promise<SweepResult> {
    const out: SweepResult = { departed: 0, frozen: 0, leavingOpened: 0, paused: 0 };
    const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, { tenantId, accessRole: "system" }, fn);
    // 1. Departures first, so a person frozen by this pass is not departed in the same pass.
    const cutoff = new Date(now() - DEPART_AFTER_DAYS * DAY_MS);
    const frozen = await sys((tx) => tx`select o.person_id, o.frozen_at <= ${cutoff} as expired from offboardings o
      join people p on p.tenant_id = o.tenant_id and p.id = o.person_id where o.state = 'frozen' and p.state = 'frozen'
      order by o.person_id`);
    for (const r of frozen as Array<{ person_id: string; expired: boolean }>) {
      if (await sys((tx) => departIfDone(tx, r.person_id, SYSTEM, r.expired))) out.departed++;
    }
    // 2. End dates that have come.
    const due = await sys(async (tx) => tx`select id from people where state = 'leaving' and leaving_on is not null
      and leaving_on <= ${await tenantToday(tx, now())}::date order by id`);
    for (const r of due as Array<{ id: string }>) {
      const done = await sys((tx) =>
        freezeWith(tx, r.id, { reason: "end_date", source: "admin", detail: "end_date", actor: SYSTEM, requestedBy: null }),
      );
      if (done) out.frozen++;
    }
    // 3. People given an end date elsewhere (PATCH /v1/people/:id leavingOn): open their hand-overs early.
    const leavers = await sys((tx) => tx`select p.id, to_char(p.leaving_on, 'YYYY-MM-DD') as leaving_on from people p
      where p.state = 'leaving' and p.leaving_on is not null
        and not exists (select 1 from offboardings o where o.tenant_id = p.tenant_id and o.person_id = p.id)
      order by p.id`);
    for (const r of leavers as Array<{ id: string; leaving_on: string }>) {
      await sys((tx) => markLeaving(tx, r.id, { reason: "end_date", effectiveOn: r.leaving_on, actor: SYSTEM, requestedBy: null }));
      out.leavingOpened++;
    }
    // 4. Worker pauses whose after-commit follow-up failed.
    await idle();
    const pending = await sys((tx) => tx`select person_id from offboardings where pause_pending order by person_id`);
    for (const r of pending as Array<{ person_id: string }>) {
      try {
        if (await sys((tx) => pausePending(tx, r.person_id))) out.paused++;
      } catch {
        console.warn("continuity: worker pause still failing; retried on the next sweep");
      }
    }
    return out;
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  return {
    isContinuity: true,
    async freeze(tx, personId, reason) {
      await freezeWith(tx, personId, {
        reason: reason.detail === "end_date" ? "end_date" : reason.source === "directory" ? "directory_deactivated" : "admin",
        source: reason.source,
        ...(reason.detail !== undefined ? { detail: reason.detail } : {}),
        actor: SYSTEM,
        requestedBy: null,
      });
    },
    freezeWith,
    markLeaving: (tx, personId, req) => deferAudits(tx, () => markLeaving(tx, personId, req)),
    held,
    runAs,
    checkRun,
    // Callers lock the leaver's row, then the hand-over row (`lockHandover`); audit events are written last.
    assign: (tx, h, by, input) => deferAudits(tx, () => assign(tx, h, by, input)),
    accept: (tx, h, by, input) => deferAudits(tx, () => accept(tx, h, by, input)),
    close: (tx, h, by) => deferAudits(tx, () => close(tx, h, by)),
    lockHandover,
    sweep,
    idle,
  };
}

/** Runs `check` on the run's ids only when they are well formed (the broker refuses malformed runs on its own). */
export function checkable(run: RunCheck): boolean {
  return isUuid(run.workflowId) && isUuid(run.runnerPersonId) && isUuid(run.identity.id);
}

