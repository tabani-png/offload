// Stored rows → hs-1 inputs (packages/hours-saved). Objects are rebuilt exactly as the devices sent them, so the
// package's inputsDigest is a digest of what was received. SQL here selects rows; it never computes a number.
import type { Tx } from "../../db/pool.ts";
import type {
  BaselineSample, ReportInput, ReviewEvent, RunInput, RunOutcome,
} from "../../../../packages/hours-saved/src/index.ts";

export interface LoadOpts {
  startMs: number;
  endMsExclusive: number;
  /** Only this person's runs (person scope, self-view, member evidence). */
  personId?: string;
  /** Only runs of this workflow version (evidence). */
  workflow?: { workflowId: string; version: number };
}

/**
 * Lets a transaction read every person's rows for a group aggregate (ADR 0101 §5 person_visibility). Only metrics code
 * that returns group-floored aggregates (or opaque evidence) turns it on.
 */
export async function aggregateRead(tx: Tx, on = true): Promise<void> {
  await tx`select set_config('app.aggregate_read', ${on ? "on" : ""}, true)`;
}

/** Runs `fn` with aggregate reads on, then restores the prior state (person-scope reads need all baseline samples). */
export async function withAggregateRead<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const [cur] = await tx`select coalesce(current_setting('app.aggregate_read', true), '') as v`;
  await aggregateRead(tx, true);
  try {
    return await fn();
  } finally {
    await aggregateRead(tx, cur!.v === "on");
  }
}

/**
 * Who a run counts for: the runner's primary department, and the job role they hold when they hold exactly one.
 * Workflows belong to job roles (ADR 0104); until the registry exposes a workflow's job role through a port, the
 * runner's single job role stands in for it, and a runner with several job roles counts in none of them.
 */
const ATTRIBUTION = `(select case when count(*) = 1 then min(h.job_role_id::text)::uuid end
  from job_role_holders h where h.tenant_id = p.tenant_id and h.person_id = p.id)`;

interface RunRow {
  device_id: string;
  run_id: string;
  object_id: string;
  person_id: string;
  created_at_ms: string | number;
  workflow_id: string;
  version: number;
  runtime: "mac" | "cloud";
  started_at_ms: string | number;
  ended_at_ms: string | number;
  outcome: RunOutcome["outcome"];
  items_total: number;
  items_sent: number;
  items_failed_before_send: number;
  items_unknown: number;
  items_pending: number;
  batch_hash: string | null;
  approver_kind: "person" | "policy" | null;
  overnight_policy_id: string | null;
  cost_cents: string | number;
  error_code: string | null;
  overnight: boolean;
  department_id: string | null;
  job_role_id: string | null;
}

function runOf(r: RunRow): RunOutcome {
  return {
    id: r.object_id,
    kind: "run_outcome",
    createdAt: Number(r.created_at_ms),
    runId: r.run_id,
    workflowId: r.workflow_id,
    version: r.version,
    runtime: r.runtime,
    startedAt: Number(r.started_at_ms),
    endedAt: Number(r.ended_at_ms),
    outcome: r.outcome,
    items: {
      total: r.items_total,
      sent: r.items_sent,
      failedBeforeSend: r.items_failed_before_send,
      unknown: r.items_unknown,
      pending: r.items_pending,
    },
    batchHash: r.batch_hash,
    approverKind: r.approver_kind,
    overnightPolicyId: r.overnight_policy_id,
    costCents: Number(r.cost_cents),
    errorCode: r.error_code,
    overnight: r.overnight,
  };
}

/**
 * Runs ending in [startMs, endMsExclusive), one per runId as hs-1 requires. Each device's row is its latest report of
 * the run; across devices the first device to report the run id keeps it (migration 0503).
 */
export async function loadRuns(tx: Tx, o: LoadOpts): Promise<RunInput[]> {
  const personId = o.personId ?? null;
  const wf = o.workflow?.workflowId ?? null;
  const ver = o.workflow?.version ?? null;
  const rows = (await tx.unsafe(
    `select r.*, p.department_id, ${ATTRIBUTION} as job_role_id
     from run_outcomes r join people p on p.tenant_id = r.tenant_id and p.id = r.person_id
     where r.ended_at_ms >= $1 and r.ended_at_ms < $2
       and ($3::uuid is null or r.person_id = $3::uuid)
       and ($4::uuid is null or (r.workflow_id = $4::uuid and r.version = $5::int))
     order by r.run_id, r.first_received_at, r.device_id`,
    [o.startMs, o.endMsExclusive, personId, wf, ver],
  )) as RunRow[];
  const out: RunInput[] = [];
  let lastRun: string | null = null;
  for (const r of rows) {
    if (r.run_id === lastRun) continue;
    lastRun = r.run_id;
    out.push({ run: runOf(r), personId: r.person_id, departmentId: r.department_id, jobRoleId: r.job_role_id });
  }
  return out;
}

/** Review events of these runs. */
export async function loadReviews(tx: Tx, runIds: readonly string[]): Promise<ReviewEvent[]> {
  if (runIds.length === 0) return [];
  const rows = await tx`select object_id, created_at_ms, run_id, review_seconds, edit_seconds, fix_seconds, items_edited,
      decision, surface from review_events
    where run_id in (select jsonb_array_elements_text(${[...new Set(runIds)]}::jsonb))
    order by object_id, device_id`;
  return rows.map((r: Record<string, unknown>) => ({
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

/** Every baseline sample (from any device) of these workflow versions. Needs aggregate reads in person scopes. */
export async function loadSamples(tx: Tx, keys: ReadonlyArray<{ workflowId: string; version: number }>): Promise<BaselineSample[]> {
  const k = [...new Set(keys.map((x) => `${x.workflowId}@${x.version}`))];
  if (k.length === 0) return [];
  const rows = await tx`select s.object_id, s.created_at_ms, s.workflow_id, s.version,
      to_char(s.window_start, 'YYYY-MM-DD') as window_start, to_char(s.window_end, 'YYYY-MM-DD') as window_end,
      (select coalesce(jsonb_agg(jsonb_build_object('instanceRef', i.instance_ref, 'activeSeconds', i.active_seconds,
          'day', to_char(i.day, 'YYYY-MM-DD')) order by i.idx), '[]'::jsonb)
        from baseline_sample_instances i
        where i.tenant_id = s.tenant_id and i.device_id = s.device_id and i.object_id = s.object_id) as instances
    from baseline_samples s
    where (s.workflow_id::text || '@' || s.version) in (select jsonb_array_elements_text(${k}::jsonb))
    order by s.object_id, s.device_id`;
  return rows.map((r: Record<string, unknown>) => ({
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

/** Runs, their reviews and the baselines of their workflow versions: the row inputs of report(). */
export async function loadInputs(tx: Tx, o: LoadOpts): Promise<Pick<ReportInput, "runs" | "reviews" | "samples">> {
  const runs = await loadRuns(tx, o);
  const reviews = await loadReviews(tx, runs.map((r) => r.run.runId));
  const keys = o.workflow ? [o.workflow] : runs.map((r) => ({ workflowId: r.run.workflowId, version: r.run.version }));
  const samples = await withAggregateRead(tx, () => loadSamples(tx, keys));
  return { runs, reviews, samples };
}

/** People with their primary department and attributed job role (same rule as runs). */
export async function loadAttribution(tx: Tx): Promise<Map<string, { departmentId: string | null; jobRoleId: string | null; jurisdiction: string }>> {
  const rows = await tx.unsafe(`select p.id, p.department_id, p.jurisdiction, ${ATTRIBUTION} as job_role_id from people p`);
  return new Map(rows.map((r: Record<string, string | null>) => [r.id as string, {
    departmentId: r.department_id,
    jobRoleId: r.job_role_id,
    jurisdiction: r.jurisdiction as string,
  }]));
}
