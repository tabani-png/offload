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
  /** s11: the local vision captioner (keyframes -> Frame notes). `enabled: false` under `serve --captioner off`. */
  captioner: CaptionerStatusDTO;
}

/** s11 (ADR 0007). Health of the local captioner. Never carries note text or image data. */
export interface CaptionerStatusDTO {
  enabled: boolean;
  /** s14 adds "claude" (the user's own Anthropic account; images masked by the engine first). */
  captioner: "off" | "stub" | "ollama" | "claude";
  /** Model tag in use ("stub" for the stub; for `auto`, the pulled model it picked, "auto" before the first check). */
  model: string | null;
  /** Last health check: true ready, false down (see lastError), null not checked yet. */
  healthy: boolean | null;
  /** Keyframes waiting to be captioned (capped; the rest are picked up on later polls). */
  queueDepth: number;
  /** Frame notes written since the brain started. */
  processed: number;
  /** Keyframes given up after repeated failures (this process). */
  failed: number;
  /** Keyframes gone (purged or expired) before they were captioned. */
  skipped: number;
  lastPollAt: number | null;
  lastCaptionAt: number | null;
  lastLatencyMs: number | null;
  /** Short reason of the last problem ("ollama unreachable at http://127.0.0.1:11434: ..."), null when none. */
  lastError: string | null;
  /** s14: token use of a paid captioner (counts only). */
  usage?: { frames: number; inputTokens: number; outputTokens: number; lastFrame: { inputTokens: number; outputTokens: number } | null; refusals: number; costUsd?: number };
  /** s14: a plain sentence when the captioner needs the user (no key, budget spent, local model down); else null. */
  needsYou?: string | null;
}

export const CAPTIONER_OFF: CaptionerStatusDTO = {
  enabled: false,
  captioner: "off",
  model: null,
  healthy: null,
  queueDepth: 0,
  processed: 0,
  failed: 0,
  skipped: 0,
  lastPollAt: null,
  lastCaptionAt: null,
  lastLatencyMs: null,
  lastError: null,
};

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
  /** s20 (additive, only on a low-confidence estimate): why not to headline this saving. `capped` = items x minutes
   * exceeded the task's own observed time and the estimate was cut to it (`observedWeeklyHours`). */
  confidence?: { level: "low"; capped: boolean; observedWeeklyHours: number | null; reasons: string[] };
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
  /** s12, `--understanding v2` only (additive): the induced task model behind this insight. */
  understanding?: InsightUnderstandingDTO;
}

export interface InsightUnderstandingDTO {
  goal: string;
  steps: Array<{ id: string; name: string; verb: string; object: string; surface: string; app: string; host: string; perInstance: number; repeatsPerInstance: number; core: boolean }>;
  /** Step ids in instance order. */
  loop: string[];
  surfaces: Array<{ app: string; appName: string; host: string; minutes: number }>;
  reach: { value: number; perSurface: Array<{ app: string; host: string; via: "catalog" | "local_file" | "computer_use"; connectorId: string | null; reach: number }> };
  identifiers: { items: number; containers: string[] };
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
  // ---- added in s09b (additive) ----
  /** The observed task this workflow automates (same as the insight's and the timeline spans' taskId). */
  taskId: string;
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
  // ---- added in s10b (additive) ----
  /** REVIEW-2 N1: what auto-run is pinned to; null while auto-run is off. Show it when auto-run is turned on. */
  autoRunPin?: AutoRunPinDTO | null;
  /** REVIEW-2 N2: the last scheduled run that did not finish (also a needsYou sentence); null when the last one did. */
  lastRunError?: { at: number; reason: string } | null;
}

/** s10b (REVIEW-2 N1): the auto-run pin. Auto-run sends on its own only to `pinnedRecipients`; anyone new or changed
 * waits for review, and a changed file holds the whole batch. Turning auto-run on again re-pins. */
export interface AutoRunPinDTO {
  pinnedAt: number;
  /** Rows in the list when it was pinned. */
  recipients: number;
  /** Addresses in the list now whose row is pinned and unchanged, sorted. */
  pinnedRecipients: string[];
  /** Rows in the list now that were not there at pin time / whose fields changed / pinned rows no longer there. */
  newRecipients: number;
  changedRecipients: number;
  removedRecipients: number;
  /** facts.md, tone/<bucket>.md, SKILL.md: sha256 at pin time and whether the file differs now. */
  files: Array<{ file: string; sha256: string; changed: boolean }>;
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
  /** s09b: which model wrote the drafts. Stored with the sealed dry run, so a later GET keeps the original label.
   * Absent on dry runs sealed before s09b. */
  model?: ModelLabel;
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
  /** s10b N1, auto-run on: recipients auto-run did not send (new or changed since the pin), split into this pending
   * batch for review. Absent or null when nothing was held. */
  held?: BatchSummaryDTO | null;
}

export interface ConnectorsResponse {
  version: ApiVersion;
  configPath: string;
  configErrors: string[];
  servers: Array<{ name: string; transport: "stdio" | "http"; catalog: string[]; status: "connected" | "missing_env"; missingEnv: string[] }>;
  /** s10e: `simulated` is true when the id counts as connected only through a demo sign-in (stub model only). */
  catalog: Array<{ id: string; name: string; how: ConnectorHow; status: ConnectorStatus; servers: string[]; simulated?: boolean }>;
  insights: Array<{ insightId: string; name: string; ready: boolean; connectors: Array<{ id: string; name: string; role: "primary" | "also"; status: ConnectorStatus }> }>;
  /** s13: the resolution chain of every catalog id and of every app the insights touch (`app-…`, `web-…`). */
  chains?: ConnectorChainDTO[];
}

/** s13: the health of one method for one target. skipped always carries a reason. */
export type ChainHealthDTO = "ok" | "failed" | "skipped";

/** s13: one method of a connector chain. */
export interface ChainMethodDTO {
  method: ConnectMethod;
  health: ChainHealthDTO;
  /** Machine code, e.g. ok, no_server, missing_env, timeout, no_toolkit, not_signed_in, no_api, computer_off. */
  code: string;
  /** Plain words for a person (why it was skipped or failed); null when ok. */
  reason: string | null;
  /** Canonical capabilities it offers for this target, e.g. mail.search; writes e.g. mail.send, sheet.append. */
  reads: string[];
  writes: string[];
  /** capability -> the concrete tool, operation or action that does it. */
  tools: Record<string, string>;
  /** The last run failure through this method (no content, no secret), null when none. */
  lastError: string | null;
  checkedAt: number;
  latencyMs: number | null;
}

/** s13: how Offload reaches one app: the method it uses now, its health and capabilities, and what comes next. */
export interface ConnectorChainDTO {
  /** A catalog id, or an app target id (`app-<slug>`, `web-<slug>`) for an app the catalog does not know. */
  targetId: string;
  name: string;
  catalog: boolean;
  /** The first healthy method that offers what this app is used for; null when none. */
  method: ConnectMethod | null;
  health: ChainHealthDTO;
  capabilities: { reads: string[]; writes: string[] };
  lastError: string | null;
  /** The method Offload falls back to when this one fails; null when there is none. */
  next: ConnectMethod | null;
  decidedAt: number;
  /** The decision is re-checked after this time (or with ?refresh=1). */
  expiresAt: number;
  simulated: boolean;
  methods: ChainMethodDTO[];
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
  /** s10e: the user's voice measured in code from the tone pack's sent emails of this bucket; null when there is no
   * tone pack or no email in the bucket. */
  measured: ToneMeasuredDTO | null;
}

/** s10e: "Your voice" as a fact sheet. Every number is counted in code (tone/style.ts measureStyle). */
export interface ToneMeasuredDTO {
  emails: number;
  medianWords: number;
  p90Words: number;
  medianSentences: number;
  /** The most common greeting form, e.g. { form: "Hi {first},", count: 38 }; null when the emails have none. */
  greeting: { form: string; count: number } | null;
  /** The most common sign-off, e.g. { form: "Muhammad", count: 40 }; null when the emails have none. */
  sign: { form: string; count: number } | null;
  /** 0..1: share of emails with a question (an ask). */
  askShare: number;
  /** 0..1: share of emails with an exclamation mark. */
  exclamationShare: number;
  /** One sentence quoted from a real sent email of this bucket (not the greeting or sign-off), at most 140 chars. */
  sample: string | null;
  /** Plain words, e.g. "40 sent investor emails". */
  source: string;
}

/** s10e: POST /connectors/:id/link starts a sign-in, GET polls it. `message` is shown to a person as it is. */
export type ConnectMethod = "mcp" | "composio" | "api" | "computer";

export interface ConnectLinkDTO {
  connectorId: string;
  name: string;
  /** Kept for compatibility: "gmail-mcp" when `method` is mcp, "composio" otherwise. */
  via: "composio" | "gmail-mcp";
  /** The way this sign-in connects: mcp = a connector on this Mac, composio, or the api / computer seams. */
  method: ConnectMethod;
  /** Every method this connector can use, in the order Offload offers them (the first is the default). */
  methods: ConnectMethod[];
  /** The method to offer next when this one failed; null otherwise or when there is none. */
  next: ConnectMethod | null;
  /** Plain words about the method or why it failed, shown to a person as it is. */
  detail: string;
  state: "idle" | "waiting" | "connected" | "failed";
  /** The sign-in page to open (Composio); null when a browser window opens by itself or in the demo. */
  url: string | null;
  /** True for the demo sign-in of the stub model: nothing opens and nothing can ever be sent through it. */
  simulated: boolean;
  message: string;
  startedAt: number | null;
  connectedAt: number | null;
  /** s13: the resolution chain for this connector (method, health, capabilities, last error, next). */
  chain?: ConnectorChainDTO;
}

/** s13: GET /computer/session: the computer-use run, the pointer overlay's last event and the kill switch. */
export interface ComputerSessionDTO {
  running: boolean;
  workflowId: string | null;
  targetId: string | null;
  /** The last pointer event (Clicky-style glyph): screen point, label of the element, the action. */
  pointer: { x: number; y: number; label: string; action: string; at: number } | null;
  stopped: boolean;
  /** Why the last run stopped (you pressed stop, you moved the pointer, ...), null when it did not. */
  stopReason: string | null;
}
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
  /** s10b: files with your content that are kept until you delete them (not purged at 7 days), for the app's
   * "Observing" section. Everything else with observed or mail text is sealed and purged at 7 days. */
  keptFiles?: KeptFileDTO[];
}

/** s10b (REVIEW-2 privacy table): a user file the brain keeps until you delete it. */
export interface KeptFileDTO {
  path: string;
  kind: "recipients" | "facts" | "send_log" | "tone_card";
  /** The workflow it belongs to; null for tone cards (shared by bucket). */
  workflowId: string | null;
  bytes: number;
  updatedAt: number;
  /** One plain sentence: what it is and why it is kept. */
  note: string;
}

// ---------- s09b: model label, observer control ----------

/** Which model writes drafts: `stub` = the deterministic offline test model (`serve --model stub`, demos: show the
 * drafts as "sample drafts"); `real` = Claude through the Agent SDK (default). */
export type ModelLabel = "stub" | "real";

/** Every response from the brain carries this header with the ModelLabel. Every 2xx JSON object body also gets a
 * `model: ModelLabel` field (`ModelLabelled`) unless it already has one (a stored dry run keeps its own). */
export const MODEL_HEADER = "x-offload-model";

export interface ModelLabelled {
  model: ModelLabel;
}

/** POST /observer/pause and /observer/resume: the observer CLI ran and exited 0; `observer` is a fresh GET /observer.
 * A missing binary or a non-zero exit is a 409 `conflict` with the reason in `message`. */
export interface ObserverControlResponse {
  version: ApiVersion;
  action: "pause" | "resume";
  ok: true;
  observer: ObserverResponse;
}

// ---------- errors ----------

export type ErrorCode = "unauthorized" | "forbidden" | "not_found" | "method_not_allowed" | "bad_request" | "conflict" | "payload_too_large" | "internal";

export interface ErrorResponse {
  error: ErrorCode;
  message?: string;
}

// ---------- s13: capability catalog (GET /catalog/capabilities) ----------

/** One candidate tool for a capability, with how Offload would reach it and which calls the gate treats as commits. */
export interface CapabilityToolDTO {
  toolId: string;
  name: string;
  why: string;
  cost: string;
  /** The vendor's official MCP server: CONFIRMED (url, date) or UNKNOWN. */
  mcp: { status: "CONFIRMED" | "UNKNOWN"; url: string | null; kind: "remote" | "local" | null; checkedAt: string; evidence: string };
  /** Composio toolkit checked read-only on this Mac (status CONFIRMED with its tool count). */
  composio: { toolkit: string; status: "CONFIRMED" | "UNKNOWN"; tools: number; checkedAt: string };
  apiDocs: string;
  /** The catalog connector id when Offload maps an app to it (gmail, google-sheets, ...), else null. */
  catalogId: string | null;
  reads: Array<{ slug: string; gateTool: string; note?: string }>;
  /** Commits (send, launch, create, update, delete). `allowedByGate` false = denied until the allowlist has its schema. */
  commits: Array<{ slug: string; verb: "send" | "launch" | "create" | "update" | "delete"; gateTool: string; allowedByGate: boolean; note?: string }>;
  note: string;
}

export interface CapabilityDTO {
  id: string;
  name: string;
  description: string;
  checkedAt: string;
  /** In the order Offload recommends them. */
  candidates: CapabilityToolDTO[];
}

export interface CapabilitiesResponse {
  version: ApiVersion;
  checkedAt: string;
  capabilities: CapabilityDTO[];
}

// ---------- s17: the Connections center (GET /connections, brain/API.md "Connections (s17)") ----------

export type ConnectionStatusDTO = "connected" | "needs_you" | "not_set_up";
export type SetupMethodDTO = "composio" | "api_key" | "mcp";

/** The local index of everything Composio offers (connectors/universe.ts). */
export interface UniverseStatusDTO {
  version: number;
  syncedAt: number | null;
  stale: boolean;
  complete: boolean;
  toolkits: number;
  tools: number;
  classes: { read: number; draft: number; commit: number; denied: number };
  cliVersion: string | null;
}

export interface ConnectionRowDTO {
  /** The catalog id when Offload maps the app, else tk-<toolkit>. */
  id: string;
  name: string;
  toolkit: string | null;
  description: string;
  status: ConnectionStatusDTO;
  /** One plain sentence for the row. */
  statusLine: string;
  /** Hand-verified by Offload (catalog); false = from the Composio list, approved field by field. */
  verified: boolean;
  tools: { read: number; commit: number; denied: number };
  /** The setup method in use, null when none. */
  method: SetupMethodDTO | null;
}

export interface ConnectionsResponse {
  version: number;
  query: string;
  connections: ConnectionRowDTO[];
  universe: UniverseStatusDTO;
  /** A plain sentence when the Composio list is not loaded yet, else null. */
  note: string | null;
}

export interface ConnectionMethodDTO {
  method: SetupMethodDTO;
  title: string;
  detail: string;
  steps: string[];
  /** The one the sheet's primary button uses first. */
  recommended: boolean;
}

export interface ConnectionTestDTO {
  version: number;
  connectionId: string;
  ok: boolean;
  detail: string;
  tools: number | null;
  testedAt: number;
}

export interface ConnectionSetupDTO {
  method: SetupMethodDTO;
  startedAt: number;
  /** Where the secret lives, by name ("Keychain: offload.connection.tk-linear"), never the value. */
  secretRef: string | null;
  /** The connector server's address or command, when there is one. */
  server: string | null;
  test: { ok: boolean; detail: string; tools: number | null; at: number } | null;
}

export interface ConnectionDetailDTO extends ConnectionRowDTO {
  version: number;
  methods: ConnectionMethodDTO[];
  /** A few tools by plain name. */
  sample: { read: string[]; commit: string[] };
  setup: ConnectionSetupDTO | null;
  /** Where the app saves this connection's API key (generic password item). */
  keychain: { service: string; account: string };
  canBuild: boolean;
}

export interface ConnectionBuildDTO {
  version: number;
  connectionId: string;
  workflow: WorkflowDetailDTO;
  dryRun: { instances: number; commitTool: string | null; missing: string[]; sent: 0; warnings: string[] };
}
