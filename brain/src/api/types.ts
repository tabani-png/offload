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
  status: AutomationStatus;
  connectors: ConnectorDTO[];
  estimatedHoursSavedPerWeek: number;
  /** null until a week of measured runs exists. */
  measuredHoursSavedPerWeek: number | null;
}

export interface DashboardResponse {
  version: ApiVersion;
  automations: AutomationDTO[];
  totals: { estimatedHoursSavedPerWeek: number; measuredHoursSavedPerWeek: number | null };
  /** Top insights not yet automated, for the "next up" row. */
  suggestions: Array<{ insightId: string; name: string; weeklyHoursSaved: number }>;
}

// ---------- errors ----------

export type ErrorCode = "unauthorized" | "forbidden" | "not_found" | "method_not_allowed" | "bad_request" | "internal";

export interface ErrorResponse {
  error: ErrorCode;
  message?: string;
}
