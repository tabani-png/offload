// syncHandlers for the five metric kinds (ADR 0103 §1). Each object has already passed its schema, the duplicate check
// and the consent/feature re-check in ingest; a handler only stores it, column for column, as the device's person.
// The envelope seq comes from app.sync_seq (set by ingest in the same transaction).
import type { Principal, SyncHandler } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import type { BaselineSample, ReviewEvent, RunOutcome } from "../../../../packages/hours-saved/src/index.ts";

interface DailyAggregate {
  id: string;
  createdAt: number;
  day: string;
  activeWorkflows: number;
  workflows: Array<{ workflowId: string; version: number; runs: number; successes: number; savedSecondsDevice: number }>;
}

interface WorkingTimeAggregate {
  id: string;
  createdAt: number;
  day: string;
  activeMinutes: number;
  firstActiveQuarter: number;
  lastActiveQuarter: number;
  noticeVersionId: string;
}

/** The schema's day pattern allows 2026-02-31; only real calendar days are stored. */
function realDay(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

function badDay(): Error {
  return Object.assign(new Error("not a calendar day"), { syncCode: "validation_failed" });
}

function device(p: Principal): { deviceId: string; personId: string } {
  if (p.kind !== "device") throw new Error("sync handlers run for devices only");
  return { deviceId: p.deviceId, personId: p.personId };
}

/**
 * New hs-1 inputs: every stored monthly snapshot must be recomputed before it may be final again. One metric_dirty row
 * per ingest transaction (migration 0502); no snapshot row is touched here, so envelopes never queue on each other or
 * on the nightly job. The flag is transaction-local and rolls back with the object's savepoint, like the row.
 */
async function markStale(tx: Tx): Promise<void> {
  const [m] = await tx`select coalesce(current_setting('app.metrics_dirty', true), '') as v`;
  if (m!.v === "on") return;
  await tx`insert into metric_dirty (tenant_id) values (current_setting('app.tenant_id')::uuid)`;
  await tx`select set_config('app.metrics_dirty', 'on', true)`;
}

const runOutcome: SyncHandler = async (tx, object, { principal }) => {
  const o = object as RunOutcome;
  const { deviceId, personId } = device(principal);
  // ADR 0111 §4: latest seq wins per (device, run), whatever object id carried it.
  await tx`insert into run_outcomes (tenant_id, device_id, run_id, object_id, person_id, seq, created_at_ms, workflow_id,
      version, runtime, started_at_ms, ended_at_ms, outcome, items_total, items_sent, items_failed_before_send, items_unknown,
      items_pending, batch_hash, approver_kind, overnight_policy_id, cost_cents, error_code, overnight, received_at)
    values (current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.runId}, ${o.id}, ${personId},
      current_setting('app.sync_seq')::bigint, ${o.createdAt}, ${o.workflowId}, ${o.version}, ${o.runtime}, ${o.startedAt},
      ${o.endedAt}, ${o.outcome}, ${o.items.total}, ${o.items.sent}, ${o.items.failedBeforeSend}, ${o.items.unknown},
      ${o.items.pending}, ${o.batchHash}, ${o.approverKind}, ${o.overnightPolicyId ?? null}, ${o.costCents},
      ${o.errorCode ?? null}, ${o.overnight}, now())
    on conflict (tenant_id, device_id, run_id) do update set
      object_id = excluded.object_id, seq = excluded.seq, created_at_ms = excluded.created_at_ms,
      workflow_id = excluded.workflow_id, version = excluded.version, runtime = excluded.runtime,
      started_at_ms = excluded.started_at_ms, ended_at_ms = excluded.ended_at_ms, outcome = excluded.outcome,
      items_total = excluded.items_total, items_sent = excluded.items_sent,
      items_failed_before_send = excluded.items_failed_before_send, items_unknown = excluded.items_unknown,
      items_pending = excluded.items_pending, batch_hash = excluded.batch_hash, approver_kind = excluded.approver_kind,
      overnight_policy_id = excluded.overnight_policy_id, cost_cents = excluded.cost_cents,
      error_code = excluded.error_code, overnight = excluded.overnight, received_at = excluded.received_at
    where run_outcomes.seq <= excluded.seq`;
  // The first copy of a run id stored in the tenant owns it (migration 0505): a claim, settled by the primary key in
  // commit order, never by a clock. Later copies, from this device or another, leave it as it is.
  await tx`insert into run_owners (tenant_id, run_id, device_id, person_id)
    values (current_setting('app.tenant_id')::uuid, ${o.runId}, ${deviceId}, ${personId})
    on conflict (tenant_id, run_id) do nothing`;
  await markStale(tx);
};

const reviewEvent: SyncHandler = async (tx, object, { principal }) => {
  const o = object as ReviewEvent;
  const { deviceId, personId } = device(principal);
  await tx`insert into review_events (tenant_id, device_id, object_id, person_id, seq, created_at_ms, run_id, review_seconds,
      edit_seconds, fix_seconds, items_edited, decision, surface, received_at)
    values (current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.id}, ${personId}, current_setting('app.sync_seq')::bigint,
      ${o.createdAt}, ${o.runId}, ${o.reviewSeconds}, ${o.editSeconds}, ${o.fixSeconds}, ${o.itemsEdited}, ${o.decision},
      ${o.surface}, now())`;
  await markStale(tx);
};

const baselineSample: SyncHandler = async (tx, object, { principal }) => {
  const o = object as BaselineSample;
  if (!realDay(o.windowStart) || !realDay(o.windowEnd) || o.instances.some((i) => !realDay(i.day))) throw badDay();
  const { deviceId, personId } = device(principal);
  await tx`insert into baseline_samples (tenant_id, device_id, object_id, person_id, seq, created_at_ms, workflow_id, version,
      window_start, window_end, received_at)
    values (current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.id}, ${personId}, current_setting('app.sync_seq')::bigint,
      ${o.createdAt}, ${o.workflowId}, ${o.version}, ${o.windowStart}::date, ${o.windowEnd}::date, now())`;
  await tx`insert into baseline_sample_instances (tenant_id, device_id, object_id, idx, person_id, instance_ref, active_seconds, day)
    select current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.id}, (e.ord - 1)::int, ${personId}, e.v->>'instanceRef',
      (e.v->>'activeSeconds')::int, (e.v->>'day')::date
    from jsonb_array_elements(${o.instances}::jsonb) with ordinality as e(v, ord)`;
  await markStale(tx);
};

const dailyAggregate: SyncHandler = async (tx, object, { principal }) => {
  const o = object as DailyAggregate;
  if (!realDay(o.day)) throw badDay();
  const { deviceId, personId } = device(principal);
  await tx`insert into daily_aggregates (tenant_id, device_id, object_id, person_id, seq, created_at_ms, day, active_workflows,
      received_at)
    values (current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.id}, ${personId}, current_setting('app.sync_seq')::bigint,
      ${o.createdAt}, ${o.day}::date, ${o.activeWorkflows}, now())`;
  if (o.workflows.length > 0) {
    await tx`insert into daily_aggregate_workflows (tenant_id, device_id, object_id, idx, person_id, workflow_id, version, runs,
        successes, saved_seconds_device)
      select current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.id}, (e.ord - 1)::int, ${personId},
        (e.v->>'workflowId')::uuid, (e.v->>'version')::int, (e.v->>'runs')::int, (e.v->>'successes')::int,
        (e.v->>'savedSecondsDevice')::int
      from jsonb_array_elements(${o.workflows}::jsonb) with ordinality as e(v, ord)`;
  }
};

const workingTimeAggregate: SyncHandler = async (tx, object, { principal }) => {
  const o = object as WorkingTimeAggregate;
  if (!realDay(o.day)) throw badDay();
  const { deviceId, personId } = device(principal);
  await tx`insert into working_time_aggregates (tenant_id, device_id, object_id, person_id, seq, created_at_ms, day,
      active_minutes, first_active_quarter, last_active_quarter, notice_version_id, received_at)
    values (current_setting('app.tenant_id')::uuid, ${deviceId}, ${o.id}, ${personId}, current_setting('app.sync_seq')::bigint,
      ${o.createdAt}, ${o.day}::date, ${o.activeMinutes}, ${o.firstActiveQuarter}, ${o.lastActiveQuarter},
      ${o.noticeVersionId}, now())`;
};

export const syncHandlers: Record<string, SyncHandler> = {
  run_outcome: runOutcome,
  review_event: reviewEvent,
  baseline_sample: baselineSample,
  daily_aggregate: dailyAggregate,
  working_time_aggregate: workingTimeAggregate,
};
