// Types for hs-1 (ADR 0109). Input shapes mirror schemas/stage2/{baseline-sample,run-outcome,review-event}.schema.json;
// output shapes mirror schemas/stage2/{hours-saved-report,hours-saved-evidence}.schema.json.

export const COMPUTATION = "hs-1" as const;
export type Computation = typeof COMPUTATION;

/** Whole, non-negative seconds. */
export type Seconds = number;
export type Grade = "A" | "B" | "C";
export type BaselineSource = "observed" | "user_estimate" | "default";
export type RunOutcomeKind = "success" | "failed" | "cancelled" | "rejected" | "capped";
export type Runtime = "mac" | "cloud";
export type ScopeType = "company" | "department" | "job_role" | "person";
export type RunNote = "not_reviewed_yet" | "policy_committed" | null;

// ---------------------------------------------------------------------------------------------- schema inputs

export interface BaselineInstance {
  readonly instanceRef: string;
  readonly activeSeconds: Seconds;
  readonly day: string;
}

/** schemas/stage2/baseline-sample.schema.json */
export interface BaselineSample {
  readonly id: string;
  readonly kind: "baseline_sample";
  readonly createdAt: number;
  readonly workflowId: string;
  readonly version: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly instances: readonly BaselineInstance[];
}

/** schemas/stage2/run-outcome.schema.json */
export interface RunOutcome {
  readonly id: string;
  readonly kind: "run_outcome";
  readonly createdAt: number;
  readonly runId: string;
  readonly workflowId: string;
  readonly version: number;
  readonly runtime: Runtime;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: RunOutcomeKind;
  readonly items: {
    readonly total: number;
    readonly sent: number;
    readonly failedBeforeSend: number;
    readonly unknown: number;
    readonly pending: number;
  };
  readonly batchHash: string | null;
  readonly approverKind: "person" | "policy" | null;
  readonly overnightPolicyId?: string | null;
  readonly costCents: number;
  readonly errorCode?: string | null;
  readonly overnight: boolean;
}

/** schemas/stage2/review-event.schema.json */
export interface ReviewEvent {
  readonly id: string;
  readonly kind: "review_event";
  readonly createdAt: number;
  readonly runId: string;
  readonly reviewSeconds: Seconds;
  readonly editSeconds: Seconds;
  readonly fixSeconds: Seconds;
  readonly itemsEdited: number;
  readonly decision: "approved" | "approved_with_edits" | "rejected" | "partial" | "policy_committed";
  readonly surface: "mac_review" | "web_digest" | "mac_fixup" | "broker";
}

/** Owner-entered baseline (ADR 0109 §1): seconds per item, stored with who and when. */
export interface UserEstimate {
  readonly id: string;
  readonly workflowId: string;
  readonly version: number;
  readonly seconds: Seconds;
  readonly setBy: string;
  readonly setAt: number;
}

// ---------------------------------------------------------------------------------------------- engine values

export interface Baseline {
  readonly computation: Computation;
  /** sha256 of JCS of the input rows (samples + estimate) sorted by id. */
  readonly inputsDigest: string;
  readonly source: BaselineSource;
  /** Distinct observed instances (0 for user_estimate and default). */
  readonly n: number;
  /** Seconds per item used by savedForRun: observed median, the user estimate, or 0 for default. */
  readonly median: Seconds;
  readonly q1: Seconds;
  readonly q3: Seconds;
  readonly iqr: Seconds;
  /** null when source is default ("no baseline"). */
  readonly grade: Grade | null;
  /** Deduplicated instances, sorted by instanceRef (evidence list). */
  readonly samples: readonly BaselineInstance[];
}

export interface RunSaving {
  readonly computation: Computation;
  readonly inputsDigest: string;
  readonly saved: Seconds;
  /** Measured residual; null when the run has no review event and was not policy committed. */
  readonly residual: Seconds | null;
  readonly note: RunNote;
  readonly baselineSeconds: Seconds;
  readonly itemsSucceeded: number;
}

/** A run plus the attribution the control plane holds (run_outcome carries no person). */
export interface RunInput {
  readonly run: RunOutcome;
  readonly personId: string;
  /** The person's primary department. */
  readonly departmentId: string | null;
  /** The workflow's job role (workflows belong to job roles). */
  readonly jobRoleId: string | null;
  /** Outcome the device reported, when the broker also recorded this run; null otherwise. */
  readonly deviceOutcome?: RunOutcomeKind | null;
}

/** One computed run, the unit total() and anomalies() aggregate. */
export interface RunRow {
  readonly id: string;
  readonly workflowId: string;
  readonly version: number;
  readonly personId: string;
  readonly departmentId: string | null;
  readonly jobRoleId: string | null;
  readonly runtime: Runtime;
  readonly outcome: RunOutcomeKind;
  readonly deviceOutcome: RunOutcomeKind | null;
  readonly endedAt: number;
  readonly overnight: boolean;
  readonly source: BaselineSource;
  readonly grade: Grade | null;
  readonly baselineN: number;
  readonly baselineSeconds: Seconds;
  readonly itemsSucceeded: number;
  readonly residual: Seconds | null;
  readonly saved: Seconds;
  readonly note: RunNote;
}

export interface Scope {
  readonly type: ScopeType;
  readonly id: string | null;
}

export interface Period {
  readonly from: string;
  readonly toExclusive: string;
}

export interface Cell {
  readonly seconds: Seconds;
  readonly hours: number;
  readonly byGrade: { readonly A: Seconds; readonly B: Seconds; readonly C: Seconds };
  readonly bySource: { readonly observed: Seconds; readonly user_estimate: Seconds };
  readonly byRuntime: { readonly mac: Seconds; readonly cloud: Seconds };
  readonly overnightSeconds: Seconds;
  readonly runs: {
    readonly success: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly rejected: number;
    readonly capped: number;
  };
  readonly people: number;
}

export interface Suppressed {
  readonly suppressed: true;
  readonly reason: "group_floor";
}

export type CellValue = Cell | Suppressed;

export interface CellTree {
  readonly scope: Scope;
  readonly label: string;
  readonly value: CellValue;
  readonly children: readonly CellTree[];
}

export interface Anomaly {
  readonly code: "residual_zero_share" | "small_baseline" | "outcome_disagreement";
  readonly workflowId: string | null;
  readonly detail: string;
}

export interface TopWorkflow {
  readonly workflowId: string;
  readonly name: string;
  readonly jobRoleId: string | null;
  readonly grade: Grade;
  readonly seconds: Seconds;
}

/** schemas/stage2/hours-saved-report.schema.json */
export interface HoursSavedReport {
  readonly computation: Computation;
  readonly inputsDigest: string;
  readonly scope: Scope;
  readonly period: { readonly from: string; readonly toExclusive: string; readonly timezone: string };
  readonly total: CellValue;
  readonly children: readonly { readonly scope: Scope; readonly label: string; readonly value: CellValue }[];
  readonly topWorkflows: readonly TopWorkflow[];
  readonly anomalies: readonly Anomaly[];
  readonly final: boolean;
}

export interface EvidenceRun {
  readonly runId: string;
  readonly endedAt: number;
  readonly outcome: RunOutcomeKind;
  readonly itemsSucceeded: number;
  readonly baselineSeconds: Seconds;
  readonly residualSeconds: Seconds | null;
  readonly savedSeconds: Seconds;
  readonly note: RunNote;
}

/** schemas/stage2/hours-saved-evidence.schema.json */
export interface HoursSavedEvidence {
  readonly computation: Computation;
  readonly workflowId: string;
  readonly version: number;
  readonly baseline: {
    readonly source: BaselineSource;
    readonly n: number;
    readonly medianSeconds: Seconds;
    readonly q1: Seconds;
    readonly q3: Seconds;
    readonly grade: Grade | null;
    readonly samples: readonly BaselineInstance[];
  };
  readonly runs: readonly EvidenceRun[];
  readonly page: { readonly nextCursor: string | null };
}

/** Thrown for inputs that break the contract (non-integer seconds, mixed baseline keys, unknown timezone). */
export class HoursSavedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoursSavedInputError";
  }
}
