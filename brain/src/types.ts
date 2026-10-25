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
