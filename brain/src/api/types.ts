// Public JSON contract of the brain's local API (brain/API.md). The app (SwiftUI) mirrors these types.
// Rules: additive changes only within one API_VERSION; times are unix epoch ms; ratios are 0..1; durations are
// minutes unless the field name says otherwise; every figure links to evidence via /insights/:id/evidence.

export const API_VERSION = 1 as const;
export type ApiVersion = typeof API_VERSION;

/** YYYY-MM-DD, the observer's local day. */
export type Day = string;

// ---------- GET /status ----------

export type ObserverState = "recording" | "paused" | "stale" | "no_data";

export interface StoreDay {
  day: Day;
  source: "plain" | "encrypted" | "both";
  events: number;
  badLines: number;
  /** Day-level problems, e.g. a missing key file. Empty when the day read cleanly. */
  errors: string[];
}

export interface StatusResponse {
  version: ApiVersion;
  observer: {
    state: ObserverState;
    /** Timestamp of the newest event in the store, null when empty. */
    lastEventAt: number | null;
  };
  store: {
    days: StoreDay[];
    events: number;
    badLines: number;
  };
  retention: {
    keepDays: 7;
    /** Oldest stored day, which is the next one the observer purges. */
    nextPurgeDay: Day | null;
    /** Local midnight after which nextPurgeDay is older than keepDays (ms), null when empty. */
    nextPurgeAt: number | null;
  };
  analysis: {
    generatedAt: number;
    windowDays: Day[];
    tasks: number;
    insights: number;
  };
}

// ---------- GET /insights ----------

export type FigureName = "instances" | "daysActive" | "instancesPerDay" | "medianMinutes" | "p90Minutes" | "activeMinutes" | "share" | "sameness" | "saving";

export type FigureUnit = "count" | "per_day" | "days" | "minutes" | "ratio" | "score";

export interface FigureDTO {
  value: number;
  unit: FigureUnit;
  /** Ready-to-show text, e.g. "64.8%", "3.0 min", "100/day". */
  display: string;
  /** How many events back this number. The ids are at /insights/:id/evidence. */
  eventCount: number;
}

export type ConnectorHow = "gmail-mcp" | `composio:${string}` | "none";

export interface ConnectorDTO {
  id: string;
  name: string;
  how: ConnectorHow;
  /** 0..1, how much of the task the connector can reach. */
  reach: number;
  /** Present when the connector only covers part of the job. */
  limits?: string;
  /** "primary" = the app the task happens in; "also" = needed by the workflow (e.g. Calendar for scheduling). */
  role: "primary" | "also";
}

export interface SavingRangeDTO {
  hoursSaved: number;
  /** 0..1 */
  pct: number;
}

export interface SavingDTO {
  weeklyItems: number;
  weeklyHoursNow: number;
  weeklyHoursAfter: number;
  weeklyHoursSaved: number;
  /** 0..1 */
  savingPct: number;
  reviewSecondsPerItem: number;
  range: { low: SavingRangeDTO; high: SavingRangeDTO };
  /** e.g. "100/day × 5 days × 3.0 min = 25.0 h/wk → review 500 × 20 s = 2.8 h/wk → saves 22.2 h/wk (89%)" */
  arithmetic: string;
  /** Plain-language assumptions behind the range. */
  assumptions: string[];
}

export interface ScoreDTO {
  value: number;
  formula: string;
  factors: { volume: number; sameness: number; reachability: number; judgement: number; risk: number };
}

export interface ExampleDTO {
  instanceId: string;
  day: Day;
  start: number;
  minutes: number;
  title: string;
}

export interface InsightDTO {
  id: string;
  rank: number;
  taskId: string;
  kind: string;
  name: string;
  description: string;
  category: "email" | "chat" | "call" | "code" | "sheet" | "calendar" | "social" | "browse" | "other";
  app: { bundleId: string; name: string; host: string };
  template: string;
  figures: Record<Exclude<FigureName, "saving">, FigureDTO>;
  saving: SavingDTO;
  score: ScoreDTO;
  judge: { judgement: number; risk: number; reasons: string[] };
  connectors: ConnectorDTO[];
  identifiers: { counterpartyCount: number; domainCount: number; topDomains: string[] };
  keywords: string[];
  examples: ExampleDTO[];
}

export interface InsightsResponse {
  version: ApiVersion;
  generatedAt: number;
  window: { days: Day[]; activeMinutes: number; events: number };
  insights: InsightDTO[];
}

// ---------- GET /insights/:id/evidence ----------

export interface SpanDTO {
  id: string;
  day: Day;
  start: number;
  end: number;
  activeMinutes: number;
  app: string;
  appName: string;
  title: string;
  host: string;
  /** null when the span belongs to no task (never in v1: every span is grouped). */
  taskId: string | null;
  eventIds: string[];
}

export interface InstanceDTO {
  id: string;
  day: Day;
  start: number;
  end: number;
  activeMinutes: number;
  spanIds: string[];
  counterparties: string[];
}

export interface EvidenceResponse {
  version: ApiVersion;
  insightId: string;
  taskId: string;
  /** For each figure, the exact event ids it was computed from. */
  figures: Record<FigureName, { eventIds: string[] }>;
  instances: InstanceDTO[];
  spans: SpanDTO[];
}

// ---------- GET /timeline?day=YYYY-MM-DD ----------

export interface TimelineResponse {
  version: ApiVersion;
  day: Day;
  activeMinutes: number;
  spans: SpanDTO[];
  byTask: Array<{ taskId: string; name: string; kind: string; minutes: number }>;
}

// ---------- GET /dashboard ----------

export type AutomationStatus = "draft" | "dry_run" | "approved" | "paused";

export interface AutomationDTO {
  id: string;
  insightId: string;
  name: string;
  /** Legacy 4-value status, kept for v1 clients. New clients read `state`. */
  status: AutomationStatus;
  connectors: ConnectorDTO[];
  estimatedHoursSavedPerWeek: number;
  /** null until the store has a full day before and after activation. */
  measuredHoursSavedPerWeek: number | null;
  // ---- added in s05 (additive) ----
  /** The workflow id (same as `id`). */
  workflowId: string;
  state: WorkflowState;
  /** Why the state is needs_you, in plain words. Empty otherwise. */
  needsYou: string[];
  /** Arithmetic behind estimatedHoursSavedPerWeek, show verbatim. */
  arithmetic: string;
  measured: MeasuredSavingDTO | null;
  pendingBatch: BatchSummaryDTO | null;
  // ---- added in s05c (additive) ----
  /** createdAt of the newest live batch (POST /workflows/:id/run), null before the first run. */
  lastRunAt: number | null;
  /** Next time the workflow's cron schedule is due (local time); null when manual, not active, or paused. */
  nextRunAt: number | null;
}

/** Observed time on the task in the store, full local days before vs after activation (activation day excluded). */
export interface MeasuredSavingDTO {
  activatedAt: number;
  daysBefore: number;
  daysAfter: number;
  hoursPerWeekBefore: number;
  hoursPerWeekAfter: number;
  hoursSavedPerWeek: number;
  /** e.g. "before: 24.1 h over 4 days = 42.2 h/wk; after: 1.2 h over 2 days = 4.2 h/wk → saves 38.0 h/wk" */
  arithmetic: string;
}

export interface DashboardResponse {
  version: ApiVersion;
  automations: AutomationDTO[];
  /** Sums over active (and needs_you) automations; measured is null when none has a measurement. */
  totals: { estimatedHoursSavedPerWeek: number; measuredHoursSavedPerWeek: number | null };
  /** Top insights not yet automated, for the "next up" row. */
  suggestions: Array<{ insightId: string; name: string; weeklyHoursSaved: number }>;
}

// ---------- workflows (s05) ----------

/** drafting = folder being written; ready_for_review = drafted, waiting for a dry run and your approval;
 * active = approved and running; paused = stopped by you; needs_you = active but a batch waits for review or a
 * required connector is missing. */
export type WorkflowState = "drafting" | "ready_for_review" | "active" | "paused" | "needs_you";

export type WorkflowStepType = "read" | "draft" | "approval_gate" | "send" | "log";

export type ConnectorStatus = "connected" | "missing_env" | "missing";

export interface WorkflowStepDTO {
  id: string;
  type: WorkflowStepType;
  title: string;
  detail: string;
  connector: string | null;
  /** Passes the approval gate. */
  sideEffect: boolean;
  script?: string;
}

export interface WorkflowConnectorDTO {
  id: string;
  name: string;
  how: ConnectorHow;
  required: boolean;
  status: ConnectorStatus;
}

export type BatchKind = "dry_run" | "live";
export type BatchState = "pending" | "approved" | "sending" | "sent" | "partial" | "failed";

export interface BatchSummaryDTO {
  /** sha256 over workflow, kind and every recipient, subject and body. Approve with this exact value. */
  hash: string;
  kind: BatchKind;
  state: BatchState;
  createdAt: number;
  approvedAt: number | null;
  items: number;
  sent: number;
  /** Items whose send may have happened but returned no result: never re-sent until you release them. */
  unknown: number;
}

export interface BatchItemDTO {
  key: string;
  to: string;
  subject: string;
  body: string;
  warnings: string[];
}

export interface WorkflowSummaryDTO {
  id: string;
  insightId: string;
  taskId: string;
  kind: string;
  name: string;
  description: string;
  state: WorkflowState;
  needsYou: string[];
  autoRun: boolean;
  createdAt: number;
  activatedAt: number | null;
  connectors: WorkflowConnectorDTO[];
  estimatedHoursSavedPerWeek: number;
  arithmetic: string;
  pendingBatch: BatchSummaryDTO | null;
  lastDryRunAt: number | null;
  // ---- added in s05c (additive) ----
  /** Same as AutomationDTO.lastRunAt. */
  lastRunAt: number | null;
  /** Same as AutomationDTO.nextRunAt. */
  nextRunAt: number | null;
}

export interface WorkflowDetailDTO extends WorkflowSummaryDTO {
  /** Folder on this Mac. */
  path: string;
  skillMd: string;
  facts: string;
  steps: WorkflowStepDTO[];
  schedule: { type: "manual" } | { type: "cron"; cron: string; timezone: string; note: string };
  trigger: { type: "manual" | "schedule" | "new_email"; detail: string };
  batchSize: number;
  models: { draft: string; cheap: string };
  batches: BatchSummaryDTO[];
  /** Items of the pending batch, for the review screen. Empty when none. */
  pendingItems: BatchItemDTO[];
}

export interface WorkflowsResponse {
  version: ApiVersion;
  workflows: WorkflowSummaryDTO[];
}

export interface GateDecisionDTO {
  at: number;
  tool: string;
  toolClass: "read" | "side_effect" | "builtin";
  decision: "allow" | "deny";
  reason: string;
  itemKey?: string;
}

export interface DryRunInstanceDTO {
  instanceId: string;
  day: Day;
  start: number;
  recipient: { email: string; firstName: string; org: string };
  subject: string;
  /** Our draft; null when the workflow kind has no drafting dry run yet. */
  draft: string | null;
  /** What the user really did, from OCR text (masked by the observer). */
  observed: { excerpt: string; minutes: number; eventIds: string[] };
  estimate: { observedMinutes: number; reviewSeconds: number; savedMinutes: number };
  examplesUsed: string[];
  warnings: string[];
}

export interface DryRunResponse {
  version: ApiVersion;
  workflowId: string;
  ranAt: number;
  /** Approving this hash marks the workflow reviewed (active). A dry-run batch can never be sent. */
  batchHash: string;
  instances: DryRunInstanceDTO[];
  /** Instances without a parsable recipient in their OCR text. */
  skipped: number;
  sideEffects: { attempted: number; denied: number };
  totals: { instances: number; observedMinutes: number; reviewMinutes: number; savedMinutes: number; arithmetic: string };
  gateLog: GateDecisionDTO[];
  warnings: string[];
}

export interface ApproveResponse {
  version: ApiVersion;
  workflowId: string;
  batchHash: string;
  kind: BatchKind;
  /** dry_run: the workflow is now active. live: sending started in the background. */
  result: "activated" | "sending";
  workflow: WorkflowSummaryDTO;
}

export interface RunResponse {
  version: ApiVersion;
  workflowId: string;
  batch: BatchSummaryDTO;
  items: BatchItemDTO[];
}

export interface ConnectorsResponse {
  version: ApiVersion;
  configPath: string;
  configErrors: string[];
  servers: Array<{ name: string; transport: "stdio" | "http"; catalog: string[]; status: "connected" | "missing_env"; missingEnv: string[] }>;
  catalog: Array<{ id: string; name: string; how: ConnectorHow; status: ConnectorStatus; servers: string[] }>;
  insights: Array<{ insightId: string; name: string; ready: boolean; connectors: Array<{ id: string; name: string; role: "primary" | "also"; status: ConnectorStatus }> }>;
}

// ---------- s05c: serve handshake, tone card, SKILL.md text, observer ----------

/** First stdout line of `serve`: `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}`. Nothing is printed before it. */
export const BRAIN_READY_PREFIX = "OFFLOAD_BRAIN_READY";

/** The JSON after BRAIN_READY_PREFIX and one space. */
export interface BrainReadyDTO {
  port: number;
  token: string;
}

/** GET /workflows/:id/tone and the PUT reply: the style card of the workflow's tone bucket. */
export interface ToneCardDTO {
  version: ApiVersion;
  workflowId: string;
  /** Tone bucket the workflow drafts with (investor_outreach | scheduling | follow_up | other). */
  bucket: string;
  /** The card's markdown; null when no card exists yet (run `tone build`, or PUT one). */
  text: string | null;
  /** True when the card differs from the one the brain last built (a rebuild keeps it unless forced). */
  edited: boolean;
  /** File on this Mac. */
  path: string;
  /** mtime of the card file, null when there is none. */
  updatedAt: number | null;
  /** Largest card a PUT accepts, in UTF-8 bytes. */
  maxBytes: number;
}

/** PUT /workflows/:id/tone body. */
export interface ToneCardUpdate {
  text: string;
}

/** One step as GET /workflows/:id/skill shows it. Only `title` and `detail` are editable. */
export interface SkillStepDTO {
  id: string;
  type: WorkflowStepType;
  title: string;
  detail: string;
  connector: string | null;
  sideEffect: boolean;
}

/** GET /workflows/:id/skill and the PUT reply. */
export interface SkillDTO {
  version: ApiVersion;
  workflowId: string;
  /** SKILL.md as rendered from workflow.json (the gate never reads it). */
  skillMd: string;
  description: string;
  steps: SkillStepDTO[];
  /** Ids of the approval-gate steps. Not editable. */
  gates: string[];
  limits: { descriptionChars: number; titleChars: number; detailChars: number };
}

/** PUT /workflows/:id/skill body. Any other key, step key or unknown step id is a 400; types, tools, connectors,
 * the gate and the step list cannot change through it. */
export interface SkillUpdate {
  description?: string;
  steps?: Array<{ id: string; title?: string; detail?: string }>;
}

export interface ObserverPermissionsDTO {
  screenRecording: boolean;
  accessibility: boolean;
  inputMonitoring: boolean;
}

/** `offload-observer status --json` (schemaVersion 1), passed through. */
export interface ObserverStatusDTO {
  schemaVersion: number;
  home: string;
  running: boolean;
  paused: boolean;
  daysStored: string[];
  keepDays: number;
  keysMode: string;
  keyFiles: { raw: number; wrapped: number };
  permissions: ObserverPermissionsDTO | null;
  /** "heartbeat", "probe" or "unknown". */
  permissionsSource: string;
  days: Array<{ day: string; events: number; encrypted: boolean; plain: boolean }>;
  nextPurgeAt: number | null;
  nextExpiry: { day: string; at: number } | null;
  heartbeat: Record<string, unknown> | null;
}

/** GET /observer. Always 200: a missing or failing observer is `available: false` with `error`. */
export interface ObserverResponse {
  version: ApiVersion;
  available: boolean;
  /** The observer binary that was asked. */
  bin: string;
  checkedAt: number;
  error: string | null;
  /** Same as status.permissions; null when unknown or unavailable. */
  permissions: ObserverPermissionsDTO | null;
  status: ObserverStatusDTO | null;
}

// ---------- errors ----------

export type ErrorCode = "unauthorized" | "forbidden" | "not_found" | "method_not_allowed" | "bad_request" | "conflict" | "payload_too_large" | "internal";

export interface ErrorResponse {
  error: ErrorCode;
  message?: string;
}
