/**
 * hs-1 for the self-view (ADR 0108 §4, ADR 0109): my hours saved over the retention window, computed by
 * packages/hours-saved from my retained inputs in S2-05's tables (run outcomes, their review events, and the baseline
 * samples of their workflow versions). The rows come from S2-05's own loader (control/src/modules/metrics/load.ts
 * loadInputs, person scope), not a copy of its queries, so this report equals GET /v1/metrics/hours-saved?scope=person:<me>
 * over the same period, digest included, and follows S2-05's run-ownership rule as it changes.
 *
 * Fail closed: when this tree does not have S2-05's input tables the total is a suppressed cell
 * (`feature_disabled`: the workflow-metrics store is not installed here), never a computed-looking 0.
 */
import type { Tx } from "../../db/pool.ts";
import {
  periodBoundsUtc, report, type HoursSavedReport, type Period, type RunOutcome,
} from "../../../../packages/hours-saved/src/index.ts";
import { loadInputs } from "../metrics/load.ts";

/** What hs-1 reads; all must exist (migrations 0501 and 0505) or the report is not available. */
const INPUT_TABLES = ["run_outcomes", "run_owners", "review_events", "baseline_samples", "baseline_sample_instances"] as const;

/** common.schema.json#/$defs/suppressed with the reason the self-view uses when hs-1's inputs are not in this tree. */
interface NotAvailable {
  readonly suppressed: true;
  readonly reason: "feature_disabled";
}
const NOT_AVAILABLE: NotAvailable = Object.freeze({ suppressed: true, reason: "feature_disabled" });

/** hs-1 report, or the same shape with the total withheld when its inputs are not available. */
export type SelfHoursSaved = Omit<HoursSavedReport, "total"> & { total: HoursSavedReport["total"] | NotAvailable };

async function inputsPresent(tx: Tx): Promise<boolean> {
  const [r] = await tx`select bool_and(to_regclass(quote_ident(t)) is not null) as tables
    from jsonb_array_elements_text(${[...INPUT_TABLES]}::jsonb) t`;
  return r!.tables === true;
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
  const rows = await loadInputs(tx, { startMs, endMsExclusive, personId });
  const r = report({ ...base, ...rows, floor: Number(t!.group_floor) });
  return { ...r, final: false };
}
