// TypeScript shapes of the schemas/stage2 DTOs the web reads and writes. The schemas are the contract; these types are
// a convenience and tests/schema.test.ts validates every mock response against the JSON Schemas themselves.

export type Uuid = string;
export type Ulid = string;
export type Sha256 = string;
export type TsMs = number;
export type Day = string;

export type AccessRole = "owner" | "admin" | "dept_lead" | "member" | "auditor" | "service";
export type PersonState = "active" | "leaving" | "frozen" | "departed";
export type Feature = "workflow_metrics" | "per_person_views" | "working_time";
export type SensitiveFeature = "per_person_views" | "working_time";
export type RunOutcomeKind = "success" | "failed" | "cancelled" | "rejected" | "capped";
export type Runtime = "mac" | "cloud";
export type StepClass = "read" | "draft" | "commit";
export type Ownership = "company" | "personal-allowed" | "personal-forbidden";
export type Grade = "A" | "B" | "C";
export type ConnectionKind =
  | "gmail" | "google_workspace_shared" | "outlook" | "m365_shared_mailbox" | "composio_org" | "company_mcp" | "api"
  | "crm" | "company_linkedin_page" | "linkedin_personal" | "other";

export interface Scope {
  type: "company" | "department" | "job_role" | "person";
  id: Uuid | null;
}

export interface Suppressed {
  suppressed: true;
  reason: "group_floor" | "feature_disabled" | "jurisdiction";
}

export const isSuppressed = (v: unknown): v is Suppressed =>
  typeof v === "object" && v !== null && (v as { suppressed?: unknown }).suppressed === true;

export interface Tenant {
  id: Uuid;
  name: string;
  createdAt: TsMs;
  reportingTimezone: string;
  groupFloor: number;
  identityAddon: { sso: boolean; directorySync: boolean };
  retention: { perPersonDays: number; workingTimeDays: number; groupMonths: number };
  monthlyWorkerBudgetCents: number;
}

export interface Department {
  id: Uuid;
  name: string;
  parentId: Uuid | null;
  directoryGroups: string[];
  leadPersonIds: Uuid[];
}

export interface Person {
  id: Uuid;
  email: string;
  displayName: string;
  accessRole: AccessRole;
  departmentId: Uuid | null;
  deptLeadOf: Uuid[];
  jobRoleIds: Uuid[];
  jurisdiction: string;
  state: PersonState;
  leavingOn: Day | null;
  source: "directory" | "invite" | "manual";
  noticeAckVersionId: Uuid | null;
}

/** What a department lead sees about a person (ADR 0111 §2, person-summary.schema.json). */
export interface PersonSummary {
  id: Uuid;
  displayName: string;
  departmentId: Uuid | null;
  jobRoleIds: Uuid[];
  state: PersonState;
}

/** `GET /v1/people` answers full records for owner/admin/auditor and summaries for a dept lead. */
export type PersonListItem = Person | PersonSummary;

export const isFullPerson = (p: PersonListItem): p is Person => "accessRole" in p;

export interface JobRole {
  id: Uuid;
  name: string;
  departmentId: Uuid;
  roleIdentityIds: Uuid[];
  holderPersonIds: Uuid[];
}

export interface RoleIdentity {
  id: Uuid;
  jobRoleId: Uuid;
  label: string;
  address: string | null;
  connectionId: Uuid;
  signature: string;
}

export interface Session {
  person: Person;
  csrfToken: string;
}

export interface Device {
  id: Uuid;
  personId: Uuid;
  name: string;
  appVersion: string;
  enrolledAt: TsMs;
  lastSyncAt: TsMs | null;
  state: "active" | "revoked";
}

export interface DeviceConfig {
  personId: Uuid;
  tenantId: Uuid;
  jurisdiction: string;
  requiredNotice: { noticeVersionId: Uuid; title: string; markdown: string; features: Feature[] } | null;
  allowedKinds: string[];
  features: Record<Feature, boolean>;
  workingTimeStartsAt: TsMs | null;
  killSwitch: boolean;
  minAppVersion: string;
  flushSeconds: number;
}

export interface Connection {
  id: Uuid;
  kind: ConnectionKind;
  ownership: Ownership;
  label: string;
  ownerPersonId: Uuid | null;
  jobRoleId: Uuid | null;
  provider: "composio" | "managed_agents_vault" | "mcp" | "api";
  externalRef: string;
  health: "ok" | "failed" | "unknown";
  createdAt: TsMs;
}

export interface RolePolicy {
  jobRoleId: Uuid;
  allowedCapabilities: string[];
  approvers: "runner" | "dept_lead" | "runner_or_dept_lead";
  sessionBudgetCents: number;
  dailyBudgetCents: number;
  maxItemsPerBatch: number;
  models: { design: "claude-opus-5-5" | "claude-sonnet-5-5"; steps: "claude-opus-5-5" | "claude-sonnet-5-5" };
  updatedAt: TsMs;
  updatedBy: Uuid;
}

export interface OvernightPolicy {
  id: Uuid;
  workflowId: Uuid;
  version: number;
  mode: "drafts_only" | "preapproved";
  recipients: { emails: string[]; domains: string[]; repliesToThreadsStartedByIdentity: boolean };
  templateHash: Sha256 | null;
  maxCommitsPerNight: number;
  maxPerRecipientPerWeek: number;
  sendWindow: { startHour: number; endHour: number; days: number[]; recipientTimezone: boolean };
  attachmentsAllowed: boolean;
  budgetCentsPerNight: number;
  dryRunNights: number;
  dryRunNightsDone: number;
  circuitBreakers: { bounceRatePct: number; negativeReplySpike: number; consecutiveFailures: number };
  state: "active" | "tripped" | "paused";
  trippedReason: string | null;
  ownerPersonId: Uuid;
}

export interface WorkflowVersion {
  version: number;
  definitionHash: Sha256;
  createdAt: TsMs;
  createdBy: Uuid;
}

export interface Workflow {
  id: Uuid;
  name: string;
  state: "proposed" | "role" | "retired" | "declined";
  jobRoleId: Uuid | null;
  departmentId: Uuid | null;
  latestVersion: number;
  proposedBy: Uuid | null;
  promotedBy: Uuid | null;
  promotedAt: TsMs | null;
  baselineGrade: Grade | null;
  versions: WorkflowVersion[];
}

export interface WorkflowStep {
  id: string;
  title: string;
  detail: string;
  class: StepClass;
  capability: string;
  connection: { kind: ConnectionKind; ownership: Ownership; connectionId: Uuid | null; label: string } | null;
  gate: "none" | "approval" | "overnight_policy";
}

export interface WorkflowDefinition {
  id: Ulid;
  kind: "workflow_proposal";
  createdAt: TsMs;
  localWorkflowId: string;
  workflowId: Uuid | null;
  version: number | null;
  name: string;
  description: string;
  trigger: { type: "manual" | "cron" | "event"; cron: string | null; timezone: string | null };
  steps: WorkflowStep[];
  skillMd: string;
  factsKeys: string[];
  limits: { maxItemsPerRun: number; maxRunsPerDay: number };
  definitionHash: Sha256;
}

export interface PromoteRequest {
  jobRoleId: Uuid;
  departmentId: Uuid;
  fromVersion: number;
  bindings: { stepId: string; connectionId: Uuid | null; disable: boolean }[];
}

export type BatchItemState = "pending" | "sending" | "sent" | "failed_before_send" | "unknown" | "rejected";

export interface Batch {
  batchHash: Sha256;
  workflowId: Uuid;
  version: number;
  runId: Ulid;
  runtime: Runtime;
  identity: { type: "person" | "role_identity"; id: Uuid };
  state: "pending" | "approved" | "sending" | "done" | "rejected" | "expired";
  createdAt: TsMs;
  expiresAt: TsMs;
  items: { key: string; capability: string; fields: [string, string][]; itemHash: Sha256; state: BatchItemState }[];
  overnightEvaluation: { policyId: Uuid; result: "allow" | "queue" | "trip"; reason: string | null } | null;
}

export interface ApprovalRequest {
  batchHash: Sha256;
  itemKeys: string[] | null;
  edits: { key: string; fields: [string, string][] }[];
}

export interface ApprovalResponse {
  batchHash: Sha256;
  state: "approved" | "sending";
  approverKind: "person" | "policy";
  approvedBy: Uuid;
  tokenExpiresAt: TsMs;
}

export interface KillSwitch {
  scope: "tenant" | "person" | "workflow";
  targetId: Uuid | null;
  active: boolean;
  setBy: Uuid;
  setAt: TsMs;
  reason: string;
}

export interface Digest {
  personId: Uuid;
  day: Day;
  ran: { runId: Ulid; workflowId: Uuid; outcome: RunOutcomeKind; drafts: number; costCents: number }[];
  waiting: { batchHash: Sha256; workflowId: Uuid; items: number }[];
  autoCommitted: { batchHash: Sha256; policyId: Uuid; items: number }[];
  trips: { policyId: Uuid; reason: string }[];
  suggestions: { title: string; class: StepClass; estimatedMinutes: number; label: "estimated" }[];
  totalCostCents: number;
}

export interface Worker {
  id: Uuid;
  workflowId: Uuid;
  version: number;
  jobRoleId: Uuid;
  identityId: Uuid;
  state: "provisioning" | "ready" | "paused" | "failed" | "retired";
  schedule: { cron: string; timezone: string; nextRunAt: TsMs | null } | null;
  sessionBudgetCents: number;
  externalRefs: { agentId: string; agentVersion: number; environmentId: string; deploymentId: string | null };
  createdAt: TsMs;
}

export interface WorkerRun {
  id: Ulid;
  workerId: Uuid;
  trigger: "manual" | "schedule";
  startedAt: TsMs;
  endedAt: TsMs | null;
  state: "running" | "waiting_approval" | "idle" | "done" | "failed" | "capped" | "interrupted";
  stopReason: "end_turn" | "requires_action" | "budget_reached" | "error" | null;
  costCents: number;
  batchHashes: Sha256[];
  summary: string | null;
  sessionRef: string;
}

export interface HoursValue {
  seconds: number;
  hours: number;
  byGrade: Record<Grade, number>;
  bySource: { observed: number; user_estimate: number };
  byRuntime: Record<Runtime, number>;
  overnightSeconds: number;
  runs: Record<RunOutcomeKind, number>;
  people: number;
}

export interface HoursSavedReport {
  computation: "hs-1";
  inputsDigest: Sha256;
  scope: Scope;
  period: { from: Day; toExclusive: Day; timezone: string };
  total: HoursValue | Suppressed;
  children: { scope: Scope; label: string; value: HoursValue | Suppressed }[];
  topWorkflows: { workflowId: Uuid; name: string; jobRoleId: Uuid | null; grade: Grade; seconds: number }[];
  anomalies: { code: "residual_zero_share" | "small_baseline" | "outcome_disagreement"; workflowId: Uuid | null; detail: string }[];
  final: boolean;
}

export interface HoursSavedEvidence {
  computation: "hs-1";
  workflowId: Uuid;
  version: number;
  baseline: {
    source: "observed" | "user_estimate" | "default";
    n: number;
    medianSeconds: number;
    q1: number;
    q3: number;
    grade: Grade | null;
    samples: { instanceRef: string; activeSeconds: number; day: Day }[];
  };
  runs: {
    runId: Ulid;
    endedAt: TsMs;
    outcome: RunOutcomeKind;
    itemsSucceeded: number;
    baselineSeconds: number;
    residualSeconds: number | null;
    savedSeconds: number;
    note: "not_reviewed_yet" | "policy_committed" | null;
  }[];
  page: { nextCursor: string | null };
}

export interface AdoptionValue {
  peopleWithActiveWorkflow: number;
  peopleTotal: number;
  workflowsActive: number;
  runsPerWeek: number;
  successRate: number;
  rejectionRate: number;
  medianResidualSeconds: number;
}

export interface AdoptionReport {
  scope: Scope;
  period: { from: Day; toExclusive: Day };
  value: AdoptionValue | Suppressed;
}

export interface WorkingTimeReport {
  scope: Scope;
  period: { from: Day; toExclusive: Day };
  value: { people: number; medianActiveMinutesPerDay: number; p25: number; p75: number } | Suppressed;
}

export interface Handover {
  id: Uuid;
  personId: Uuid;
  workflowId: Uuid;
  state: "open" | "assigned" | "closed";
  successor: { type: "person"; personId: Uuid } | { type: "role_identity"; roleIdentityId: Uuid } | null;
  inFlight: "pause" | "handover_message" | "stop";
  inboxStep: "google_migrate" | "google_alias" | "google_archive" | "m365_shared_mailbox" | "none" | null;
  removedConnections: Uuid[];
  assignedBy: Uuid | null;
  assignedAt: TsMs | null;
}

export type LegalBasis = "legitimate_interest" | "contract" | "consent" | "works_agreement" | "other";

export interface FeatureEnablement {
  feature: SensitiveFeature;
  jurisdictions: string[];
  legalBasis: LegalBasis;
  dpiaAttestation: { completedOn: Day; documentHash: Sha256; documentName: string; signerName: string; signerTitle: string };
  noticeVersionId: Uuid;
  noticePeriodDays: number;
  worksAgreementRef: { documentHash: Sha256; documentName: string; allowedViews: string[] } | null;
  quebecActivationAck: boolean;
  purposeLock: "process_improvement";
  enabledBy: Uuid;
  enabledAt: TsMs;
  effectiveAt: TsMs;
  disabledAt: TsMs | null;
}

export type FeatureEnableRequest = Omit<FeatureEnablement, "enabledBy" | "enabledAt" | "effectiveAt" | "disabledAt">;

export interface Notice {
  id: Uuid;
  version: number;
  title: string;
  markdown: string;
  features: Feature[];
  jurisdictions: string[];
  publishedAt: TsMs | null;
  replacedAt: TsMs | null;
  template: string;
  acks: number;
}

export interface NoticeAck {
  id: Ulid;
  kind: "notice_ack";
  createdAt: TsMs;
  noticeVersionId: Uuid;
  acknowledgedAt: TsMs;
  jurisdiction: string;
  features: Feature[];
  channel: "mac_app" | "web";
}

export interface AuditEvent {
  id: Ulid;
  at: TsMs;
  actor: { type: "person" | "device" | "service" | "support" | "system"; id: Uuid | null; accessRole: AccessRole | null };
  action: string;
  subjectPersonId: Uuid | null;
  resource: { type: string; id: string | null };
  detail: Record<string, unknown>;
  prevHash: Sha256 | null;
  hash: Sha256;
}

export interface RunOutcome {
  id: Ulid;
  kind: "run_outcome";
  createdAt: TsMs;
  runId: Ulid;
  workflowId: Uuid;
  version: number;
  runtime: Runtime;
  startedAt: TsMs;
  endedAt: TsMs;
  outcome: RunOutcomeKind;
  items: { total: number; sent: number; failedBeforeSend: number; unknown: number; pending: number };
  batchHash: Sha256 | null;
  approverKind: "person" | "policy" | null;
  overnightPolicyId?: Uuid | null;
  costCents: number;
  errorCode?: string | null;
  overnight: boolean;
}

export interface DailyAggregate {
  id: Ulid;
  kind: "daily_aggregate";
  createdAt: TsMs;
  day: Day;
  activeWorkflows: number;
  workflows: { workflowId: Uuid; version: number; runs: number; successes: number; savedSecondsDevice: number }[];
}

export interface WorkingTimeAggregate {
  id: Ulid;
  kind: "working_time_aggregate";
  createdAt: TsMs;
  day: Day;
  activeMinutes: number;
  firstActiveQuarter: number;
  lastActiveQuarter: number;
  noticeVersionId: Uuid;
}

export interface SelfView {
  person: Person;
  features: Record<Feature, boolean>;
  acks: NoticeAck[];
  devices: Device[];
  hoursSaved: HoursSavedReport;
  dailyAggregates: DailyAggregate[];
  workingTime: WorkingTimeAggregate[];
  runs: RunOutcome[];
  accessLog: AuditEvent[];
  retention: { perPersonDays: number; workingTimeDays: number };
}

export interface NoticeAckRow {
  personId: Uuid;
  acknowledgedAt: TsMs;
}

export interface ComplianceTemplate {
  id: string;
  title: string;
  jurisdictions: string[];
}

export interface ChainVerify {
  ok: boolean;
  brokenAt?: string;
}
