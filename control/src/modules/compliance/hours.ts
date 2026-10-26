/**
 * hs-1 for the self-view (ADR 0108 §4, ADR 0109): my hours saved over the retention window, computed by
 * packages/hours-saved from my retained inputs in S2-05's tables (run outcomes, their review events, and the baseline
 * samples of their workflow versions). The rows are selected exactly as S2-05's metrics loader selects them
 * (control/src/modules/metrics/load.ts) so this report equals GET /v1/metrics/hours-saved?scope=person:<me> over the
 * same period, digest included. This module does not import the metrics module, which a tree without S2-05 lacks.
 *
 * Fail closed: when this tree does not have S2-05's input tables the total is a suppressed cell
 * (`feature_disabled`: the workflow-metrics store is not installed here), never a computed-looking 0.
 */
import type { Tx } from "../../db/pool.ts";
import {
  periodBoundsUtc, report, type BaselineSample, type HoursSavedReport, type Period, type ReviewEvent,
  type RunInput, type RunOutcome,
} from "../../../../packages/hours-saved/src/index.ts";

/** What hs-1 reads; all must exist (migrations 0501 and 0503) or the report is not available. */
const INPUT_TABLES = ["run_outcomes", "review_events", "baseline_samples", "baseline_sample_instances"] as const;

/** common.schema.json#/$defs/suppressed with the reason the self-view uses when hs-1's inputs are not in this tree. */
interface NotAvailable {
  readonly suppressed: true;
  readonly reason: "feature_disabled";
}
const NOT_AVAILABLE: NotAvailable = Object.freeze({ suppressed: true, reason: "feature_disabled" });

/** hs-1 report, or the same shape with the total withheld when its inputs are not available. */
export type SelfHoursSaved = Omit<HoursSavedReport, "total"> & { total: HoursSavedReport["total"] | NotAvailable };

async function inputsPresent(tx: Tx): Promise<boolean> {
  const [r] = await tx`select bool_and(to_regclass(quote_ident(t)) is not null) as tables,
      exists (select 1 from pg_attribute a where a.attrelid = to_regclass('run_outcomes') and a.attname = 'first_received_at'
        and not a.attisdropped) as first_received
    from jsonb_array_elements_text(${[...INPUT_TABLES]}::jsonb) t`;
  return r!.tables === true && r!.first_received === true;
}

/** Turns on app.aggregate_read for `fn`, then restores the prior value (same switch S2-05's loader uses). */
async function withAggregateRead<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const [cur] = await tx`select coalesce(current_setting('app.aggregate_read', true), '') as v`;
  await tx`select set_config('app.aggregate_read', 'on', true)`;
  try {
    return await fn();
  } finally {
    await tx`select set_config('app.aggregate_read', ${cur!.v === "on" ? "on" : ""}, true)`;
  }
}

/** The run outcome exactly as the device sent it (run-outcome.schema.json); the self-view lists the same shape. */
export function runOutcomeOf(r: Record<string, unknown>): RunOutcome {
  return {
    id: r.object_id as string,
    kind: "run_outcome",
    createdAt: Number(r.created_at_ms),
    runId: r.run_id as string,
    workflowId: r.workflow_id as string,
    version: Number(r.version),
    runtime: r.runtime as RunOutcome["runtime"],
    startedAt: Number(r.started_at_ms),
    endedAt: Number(r.ended_at_ms),
    outcome: r.outcome as RunOutcome["outcome"],
    items: {
      total: Number(r.items_total),
      sent: Number(r.items_sent),
      failedBeforeSend: Number(r.items_failed_before_send),
      unknown: Number(r.items_unknown),
      pending: Number(r.items_pending),
    },
    batchHash: (r.batch_hash as string | null) ?? null,
    approverKind: (r.approver_kind as RunOutcome["approverKind"]) ?? null,
    overnightPolicyId: (r.overnight_policy_id as string | null) ?? null,
    costCents: Number(r.cost_cents),
    errorCode: (r.error_code as string | null) ?? null,
    overnight: Boolean(r.overnight),
  } as RunOutcome;
}

/**
 * My runs ending in [start, end), one per run id: the copy first received in the tenant wins (migration 0503), chosen
 * before the person filter, so a run id another person's device reported first never counts as mine. Same rule and
 * attribution as S2-05's loadRuns; only my rows are returned.
 */
async function myRunInputs(tx: Tx, personId: string, startMs: number, endMs: number): Promise<RunInput[]> {
  const rows = (await withAggregateRead(tx, () => tx`
    with candidates as (
      select distinct r.run_id from run_outcomes r
      where r.ended_at_ms >= ${startMs} and r.ended_at_ms < ${endMs} and r.person_id = ${personId}),
    kept as (
      select distinct on (r.run_id) r.* from run_outcomes r
      where r.run_id in (select run_id from candidates)
      order by r.run_id, r.first_received_at, r.device_id)
    select r.*, p.department_id,
      (select case when count(*) = 1 then min(h.job_role_id::text)::uuid end
         from job_role_holders h where h.tenant_id = p.tenant_id and h.person_id = p.id) as job_role_id
    from kept r join people p on p.tenant_id = r.tenant_id and p.id = r.person_id
    where r.ended_at_ms >= ${startMs} and r.ended_at_ms < ${endMs} and r.person_id = ${personId}
    order by r.run_id`)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    run: runOutcomeOf(r),
    personId: r.person_id as string,
    departmentId: (r.department_id as string | null) ?? null,
    jobRoleId: (r.job_role_id as string | null) ?? null,
  }));
}

/** Review events of these runs sent by the person who ran each one (S2-05 loadReviews). */
async function reviewsOf(tx: Tx, runs: readonly RunInput[]): Promise<ReviewEvent[]> {
  if (runs.length === 0) return [];
  const owners = Object.fromEntries(runs.map((r) => [r.run.runId, r.personId]));
  const rows = (await tx`select e.object_id, e.created_at_ms, e.run_id, e.review_seconds, e.edit_seconds, e.fix_seconds,
      e.items_edited, e.decision, e.surface from review_events e
    join jsonb_each_text(${owners}::jsonb) o(run_id, person_id) on o.run_id = e.run_id and o.person_id::uuid = e.person_id
    order by e.object_id, e.device_id`) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.object_id as string,
    kind: "review_event" as const,
    createdAt: Number(r.created_at_ms),
    runId: r.run_id as string,
    reviewSeconds: r.review_seconds as number,
    editSeconds: r.edit_seconds as number,
    fixSeconds: r.fix_seconds as number,
    itemsEdited: r.items_edited as number,
    decision: r.decision as ReviewEvent["decision"],
    surface: r.surface as ReviewEvent["surface"],
  }));
}

/**
 * Every baseline sample (from any device) of these workflow versions (S2-05 loadSamples). The baseline of a workflow
 * version is shared; samples carry hashed instance refs only. Reading other devices' samples needs aggregate reads.
 */
async function samplesOf(tx: Tx, runs: readonly RunInput[]): Promise<BaselineSample[]> {
  const keys = [...new Set(runs.map((r) => `${r.run.workflowId}@${r.run.version}`))];
  if (keys.length === 0) return [];
  const rows = (await withAggregateRead(tx, () => tx`select s.object_id, s.created_at_ms, s.workflow_id, s.version,
      to_char(s.window_start, 'YYYY-MM-DD') as window_start, to_char(s.window_end, 'YYYY-MM-DD') as window_end,
      (select coalesce(jsonb_agg(jsonb_build_object('instanceRef', i.instance_ref, 'activeSeconds', i.active_seconds,
          'day', to_char(i.day, 'YYYY-MM-DD')) order by i.idx), '[]'::jsonb)
        from baseline_sample_instances i
        where i.tenant_id = s.tenant_id and i.device_id = s.device_id and i.object_id = s.object_id) as instances
    from baseline_samples s
    where (s.workflow_id::text || '@' || s.version) in (select jsonb_array_elements_text(${keys}::jsonb))
    order by s.object_id, s.device_id`)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.object_id as string,
    kind: "baseline_sample" as const,
    createdAt: Number(r.created_at_ms),
    workflowId: r.workflow_id as string,
    version: r.version as number,
    windowStart: r.window_start as string,
    windowEnd: r.window_end as string,
    instances: r.instances as BaselineSample["instances"],
  }));
}

/** My hs-1 report over `period` (person scope: never floored, never final). */
export async function myHoursSaved(tx: Tx, personId: string, period: Period, timezone: string): Promise<SelfHoursSaved> {
  const scope = { type: "person" as const, id: personId };
  const base = { estimates: [], workflows: [], scope, children: [], period, timezone };
  if (!(await inputsPresent(tx))) {
    const empty = report({ ...base, runs: [], reviews: [], samples: [] });
    return { ...empty, total: NOT_AVAILABLE, children: [], topWorkflows: [], anomalies: [], final: false };
  }
  const [t] = await tx`select group_floor from tenants where id = current_setting('app.tenant_id')::uuid`;
  const { startMs, endMsExclusive } = periodBoundsUtc(period, timezone);
  const runs = await myRunInputs(tx, personId, startMs, endMsExclusive);
  const reviews = await reviewsOf(tx, runs);
  const samples = await samplesOf(tx, runs);
  const r = report({ ...base, runs, reviews, samples, floor: Number(t!.group_floor) });
  return { ...r, final: false };
}
