// Domain types for the brain. Terms follow plan/CONTEXT.md (Event, Span, Task, Insight, Saving estimate, Connector).

export type EventKind = "focus" | "idle_start" | "idle_end" | "input" | "ocr" | "pause" | "resume";

/** One raw observation, decrypted form, per schemas/event.schema.json. */
export interface OffloadEvent {
  id: string;
  ts: number;
  kind: EventKind;
  app?: string;
  appName?: string;
  title?: string;
  url?: string;
  host?: string;
  keys?: number;
  clicks?: number;
  text?: string;
  textHash?: string;
}

/** Local day label, YYYY-MM-DD. */
export type DayLabel = string;

export interface OcrSnapshot {
  eventId: string;
  ts: number;
  text: string;
}

/** A continuous focus interval on one app + title + URL host, idle removed. */
export interface Span {
  id: string;
  day: DayLabel;
  /** Key that defines the span: app + title + host. */
  key: string;
  app: string;
  appName: string;
  title: string;
  host: string;
  url: string;
  /** Wall-clock start and end (ms). Idle gaps inside the span are excluded from activeMs. */
  start: number;
  end: number;
  activeMs: number;
  /** Every event behind this span: focus, idle_end that resumed it, input and ocr events inside it. */
  eventIds: string[];
  ocr: OcrSnapshot[];
  keys: number;
  clicks: number;
}

export type Category = "email" | "chat" | "call" | "code" | "sheet" | "calendar" | "social" | "browse" | "other";

export interface Identifiers {
  /** Email addresses of other people (the user's own addresses removed), sorted. */
  counterparties: string[];
  /** Domains of those counterparties, sorted. */
  domains: string[];
}

/** One occurrence of a task: one span, or consecutive spans of the same item split by a short interruption. */
export interface TaskInstance {
  id: string;
  taskId: string;
  day: DayLabel;
  spanIds: string[];
  start: number;
  end: number;
  activeMs: number;
  eventIds: string[];
  identifiers: Identifiers;
}

/** Deterministic, rule-built summary of a task. Labelers and judges only ever see profiles. */
export interface TaskProfile {
  taskId: string;
  signature: string;
  app: string;
  appName: string;
  host: string;
  urlPattern: string;
  template: string;
  category: Category;
  exampleTitles: string[];
  ocrKeywords: string[];
  identifiers: Identifiers;
  instanceCount: number;
  /** Keystrokes per active minute across all instances (counts only). */
  keysPerMinute: number;
  /** Share of instances whose OCR text contains scheduling language. */
  schedulingShare: number;
  /** s12 understanding v2 only: the induced task model. v1 never sets it. */
  understanding?: TaskUnderstanding;
}

/** Optional context from onboarding (s14). Passed to labelers, judges and prompts as context only, never to arithmetic. */
export interface UserContext {
  role?: string;
  industry?: string;
}

/** One step of an induced task (a cluster of span descriptions). Counts are deterministic. */
export interface UnderstandingStep {
  id: string;
  name: string;
  verb: string;
  object: string;
  surface: string;
  surfaceKey: string;
  app: string;
  appName: string;
  host: string;
  /** Rule category of the step's surface: a feature, not the task's identity. */
  category: Category;
  spans: number;
  activeMs: number;
  /** Share of the task's instances that contain this step (0..1). */
  perInstance: number;
  /** Mean number of spans of this step in the instances that contain it. */
  repeatsPerInstance: number;
  /** Mean 0-based position of the step's first span inside an instance. */
  meanPosition: number;
  /** Part of the loop: present in at least 60% of instances. */
  core: boolean;
}

export type InstanceBoundaryReason = "first" | "new_day" | "gap" | "new_item" | "loop_restart";

export interface SurfaceReach {
  app: string;
  host: string;
  urlPattern: string;
  /** catalog = a connector in connectors/catalog.ts; local_file = a document the agent can read; computer_use = last resort. */
  via: "catalog" | "local_file" | "computer_use";
  connectorId: string | null;
  reach: number;
  activeMs: number;
}

export interface ReachEstimate {
  /** Active-time-weighted mean of the step surfaces' reach, 0..1. */
  value: number;
  perSurface: SurfaceReach[];
}

/** Task Model Induction output for one task (s12, ADR 0007). */
export interface TaskUnderstanding {
  version: 2;
  /** Deterministic goal summary from the loop steps. */
  goal: string;
  steps: UnderstandingStep[];
  /** Step ids of the core steps, in instance order. */
  loop: string[];
  startStep: string;
  startSurface: string;
  identifiers: { items: number; examples: string[]; containers: string[] };
  counterparts: string[];
  surfaces: Array<{ app: string; appName: string; host: string; minutes: number }>;
  instanceBoundaries: Array<{ instanceId: string; start: number; reason: InstanceBoundaryReason }>;
  evidenceSpanIds: string[];
  frameIds: string[];
  reach: ReachEstimate;
  sources: { frames: number; rules: number };
}

export interface TaskLabel {
  /** Stable machine kind, e.g. "email.outreach". */
  kind: string;
  /** Short human name, e.g. "Outreach emails". */
  name: string;
  /** One-line description built from the profile. */
  description: string;
}

export interface Task {
  id: string;
  profile: TaskProfile;
  label: TaskLabel;
  instances: TaskInstance[];
  spanIds: string[];
}

export type FigureUnit = "count" | "per_day" | "days" | "minutes" | "ratio" | "score";

/** A number plus the event ids that produced it. Every figure the brain shows is one of these. */
export interface Figure {
  value: number;
  unit: FigureUnit;
  eventIds: string[];
}

export interface SamenessBreakdown {
  score: number;
  titleSimilarity: number;
  stepSimilarity: number;
  /** "ocr" when step similarity came from OCR text, "duration" when no OCR was available. */
  stepMethod: "ocr" | "duration";
}

export interface TaskStats {
  taskId: string;
  instances: Figure;
  daysActive: Figure;
  instancesPerDay: Figure;
  medianMinutes: Figure;
  p90Minutes: Figure;
  activeMinutes: Figure;
  share: Figure;
  sameness: Figure;
  samenessBreakdown: SamenessBreakdown;
}
