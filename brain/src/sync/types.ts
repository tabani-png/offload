// Sync objects (ADR 0103 §1), typed from schemas/stage2. The closed set: nothing else can be built or sent.
// Projector inputs (`*Input`) are the narrow, typed, numeric/id views of brain state that sync/project/* may see:
// never events, spans, OCR, frame notes, recipients, subjects or bodies (SPEC S2-02 "Design").

export const SYNC_KINDS = ["notice_ack", "run_outcome", "review_event", "baseline_sample", "daily_aggregate", "working_time_aggregate", "workflow_proposal"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];
export type Feature = "workflow_metrics" | "per_person_views" | "working_time";
export type RunOutcomeCode = "success" | "failed" | "cancelled" | "rejected" | "capped";

interface Base<K extends SyncKind> {
  id: string;
  kind: K;
  createdAt: number;
}

export interface NoticeAck extends Base<"notice_ack"> {
  noticeVersionId: string;
  acknowledgedAt: number;
  jurisdiction: string;
  features: Feature[];
  channel: "mac_app" | "web";
}

export interface RunOutcome extends Base<"run_outcome"> {
  runId: string;
  workflowId: string;
  version: number;
  runtime: "mac" | "cloud";
  startedAt: number;
  endedAt: number;
  outcome: RunOutcomeCode;
  items: { total: number; sent: number; failedBeforeSend: number; unknown: number; pending: number };
  batchHash: string | null;
  approverKind: "person" | "policy" | null;
  overnightPolicyId?: string | null;
  costCents: number;
  errorCode?: string | null;
  overnight: boolean;
}

export type ReviewDecision = "approved" | "approved_with_edits" | "rejected" | "partial" | "policy_committed";
export type ReviewSurface = "mac_review" | "web_digest" | "mac_fixup" | "broker";

export interface ReviewEvent extends Base<"review_event"> {
  runId: string;
  reviewSeconds: number;
  editSeconds: number;
  fixSeconds: number;
  itemsEdited: number;
  decision: ReviewDecision;
  surface: ReviewSurface;
}

export interface BaselineSample extends Base<"baseline_sample"> {
  workflowId: string;
  version: number;
  windowStart: string;
  windowEnd: string;
  instances: Array<{ instanceRef: string; activeSeconds: number; day: string }>;
}

export interface DailyAggregate extends Base<"daily_aggregate"> {
  day: string;
  activeWorkflows: number;
  workflows: Array<{ workflowId: string; version: number; runs: number; successes: number; savedSecondsDevice: number }>;
}

export interface WorkingTimeAggregate extends Base<"working_time_aggregate"> {
  day: string;
  activeMinutes: number;
  firstActiveQuarter: number;
  lastActiveQuarter: number;
  noticeVersionId: string;
}

export type StepClass = "read" | "draft" | "commit";
export type Ownership = "company" | "personal-allowed" | "personal-forbidden";
export type ConnectionKind = "gmail" | "google_workspace_shared" | "outlook" | "m365_shared_mailbox" | "composio_org" | "company_mcp" | "api" | "crm" | "company_linkedin_page" | "linkedin_personal" | "other";

export interface ProposalStep {
  id: string;
  title: string;
  detail: string;
  class: StepClass;
  capability: string;
  connection: { kind: ConnectionKind; ownership: Ownership; connectionId: string | null; label: string } | null;
  gate: "none" | "approval" | "overnight_policy";
}

export interface WorkflowProposal extends Base<"workflow_proposal"> {
  localWorkflowId: string;
  workflowId: string | null;
  version: number | null;
  name: string;
  description: string;
  trigger: { type: "manual" | "cron" | "event"; cron: string | null; timezone: string | null };
  steps: ProposalStep[];
  skillMd: string;
  factsKeys: string[];
  limits: { maxItemsPerRun: number; maxRunsPerDay: number };
  definitionHash: string;
}

export type SyncObject = NoticeAck | RunOutcome | ReviewEvent | BaselineSample | DailyAggregate | WorkingTimeAggregate | WorkflowProposal;

export interface SyncEnvelope {
  v: 1;
  deviceId: string;
  seq: number;
  sentAt: number;
  objects: SyncObject[];
}

export type RejectCode = "validation_failed" | "consent_missing" | "feature_disabled" | "duplicate" | "unknown_workflow" | "rate_limited" | "server_error";
export interface SyncReceipt {
  seq: number;
  accepted: string[];
  rejected: Array<{ id: string; code: RejectCode; retryable: boolean }>;
}

export interface DeviceConfig {
  personId: string;
  tenantId: string;
  jurisdiction: string;
  requiredNotice: { noticeVersionId: string; title: string; markdown: string; features: Feature[] } | null;
  allowedKinds: SyncKind[];
  features: Record<Feature, boolean>;
  workingTimeStartsAt: number | null;
  killSwitch: boolean;
  minAppVersion: string;
  flushSeconds: number;
}

// ---------- projector inputs (numbers and ids only) ----------

/** Makes deterministic object ids: (kind, natural key, time) -> ULID. Keyed on the device evidence key. */
export type IdMaker = (kind: SyncKind, naturalKey: string, ts: number) => string;

export interface ProjectionContext {
  ids: IdMaker;
  now: number;
}

/** A company workflow a local workflow is bound to (role workflow or promoted proposal). */
export interface Binding {
  workflowId: string;
  version: number;
}

export interface NoticeAckInput {
  noticeVersionId: string;
  acknowledgedAt: number;
  jurisdiction: string;
  features: Feature[];
}

export interface RunInput {
  binding: Binding;
  /** The local batch hash (sha256 hex over the approved items): an opaque identifier, never the items. */
  batchHash: string;
  startedAt: number;
  endedAt: number;
  state: "sent" | "partial" | "failed";
  items: { total: number; sent: number; failedBeforeSend: number; unknown: number; pending: number };
  approver: "person" | "policy" | null;
  /** The executor reported an error (a code is sent, never the message). */
  failed: boolean;
  overnight: boolean;
}

export interface ReviewInput {
  batchHash: string;
  startedAt: number;
  at: number;
  reviewSeconds: number;
  editSeconds: number;
  fixSeconds: number;
  itemsEdited: number;
  decision: ReviewDecision;
  surface: ReviewSurface;
}

export interface BaselineInput {
  binding: Binding;
  /** Instance refs already computed with the device evidence key (sync/evidence-key.ts). */
  instances: Array<{ instanceRef: string; activeSeconds: number; day: string }>;
}

export interface DailyInput {
  day: string;
  /** End of that local day (ms), the object's createdAt. */
  dayEnd: number;
  activeWorkflows: number;
  workflows: Array<{
    binding: Binding;
    runs: number;
    /** Per successful run: items sent and the measured residual (null = not reviewed yet: no credit, ADR 0109 §3). */
    successRuns: Array<{ sent: number; residualSeconds: number | null }>;
    baselineSeconds: number[];
  }>;
}

export interface WorkingTimeInput {
  day: string;
  dayEnd: number;
  activeSeconds: number;
  /** Minutes since local midnight of the first active moment and of the last one. */
  firstActiveMinute: number;
  lastActiveMinute: number;
  noticeVersionId: string;
}

export interface ProposalStepInput {
  id: string;
  title: string;
  detail: string;
  type: "read" | "draft" | "send" | "log";
  connector: string | null;
  sideEffect: boolean;
  capability: string | null;
}

export interface ProposalInput {
  localWorkflowId: string;
  binding: Binding | null;
  /** Stable time of the definition (the workflow's last change), so preview and confirm build the same object. */
  definedAt: number;
  /** Text fields: facts values already redacted by the collector; the projector masks contact patterns again. */
  name: string;
  description: string;
  trigger: { type: "manual" | "cron" | "event"; cron: string | null; timezone: string | null };
  steps: ProposalStepInput[];
  skillMd: string;
  factsKeys: string[];
  batchSize: number;
}
