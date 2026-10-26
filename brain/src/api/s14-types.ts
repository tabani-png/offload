// s14 API types (additive, API v1). The general workflow plan, the generic dry run and the user context.
// Kept out of api/types.ts so the s13 connector-chain work and this slice do not edit the same file.

/** The typed steps of a general workflow (slices/s14-any-task-workflows/SPEC.md "Step typing"). */
export type PlanStepType = "read" | "transform" | "decide" | "draft" | "commit";

/** What the workflow produces per item. Text types get a tone pack; the others never do. */
export type OutputType = "email" | "ticket_reply" | "message" | "form_fields" | "rows" | "stage_change" | "record";

export const TEXT_OUTPUTS: readonly OutputType[] = ["email", "ticket_reply", "message"];

/** A plain-words capability need the s13 chain resolves to a method (MCP, Composio, API or computer use). */
export interface CapabilityNeedDTO {
  /** Plain words: "create bill in Xero", "read supplier invoice from Preview". */
  need: string;
  /** Catalog connector id ("gmail"), or an app target: "app-<slug>" for a Mac app, "web-<slug>" for a site. */
  target: string;
  /** Display name of the target ("Xero", "Preview"). */
  targetName: string;
  /** Canonical capability: "screen.read", "file.read", "ui.commit", or a catalog one such as "mail.send". */
  capability: string;
  role: "read" | "send" | "log";
  /** How the s12 reach estimate expects it to be reached; the chain decides. */
  via: "catalog" | "local_file" | "computer_use";
}

/** The chain's answer for one need. `pending` until s13 is wired in. */
export interface CapabilityResolutionDTO {
  target: string;
  capability: string;
  status: "resolved" | "pending" | "unavailable";
  /** "mcp" | "composio" | "api" | "computer" once resolved. */
  method: string | null;
  reason: string;
}

export interface PlanStepDTO {
  id: string;
  type: PlanStepType;
  title: string;
  detail: string;
  /** Local steps (transform, decide, draft) have none. */
  capability: CapabilityNeedDTO | null;
  /** Commit steps: always true. Nothing is written before you approve. */
  gated: boolean;
  /** Steps that only run sometimes, behind a decide ("when the ticket names an order"). */
  when: string | null;
  /** Draft steps that write text: the tone pack applies. */
  writesText: boolean;
  /** Understanding step ids this step stands for (evidence). */
  sourceSteps: string[];
}

export interface PlanVariantDTO {
  id: "a" | "b";
  label: string;
  summary: string;
  steps: PlanStepDTO[];
}

export interface ProbeScoreDTO {
  variant: "a" | "b";
  instances: number;
  matched: number;
  extra: number;
  missed: number;
  /** matched / (matched + extra + missed), 0..1. */
  agreement: number;
  arithmetic: string;
}

export interface WorkflowPlanDTO {
  version: 2;
  outputType: OutputType;
  /** Deterministic goal from the task model (masked). */
  goal: string;
  variants: PlanVariantDTO[];
  chosen: "a" | "b";
  /** dry_run = the probe picked it; user = you picked it. */
  chosenBy: "dry_run" | "user";
  probe: ProbeScoreDTO[];
  /** One sentence: why this variant ("closer to what you did: 97% vs 82% of your steps"). */
  reason: string;
  /** "rules" or the model id that rewrote titles ("claude-opus-5-5"). */
  designedBy: string;
  capabilities: CapabilityResolutionDTO[];
}

export interface OutputFieldDTO {
  label: string;
  /** null when the screen showed that the field was filled but not its value. */
  value: string | null;
}

export interface OutputDTO {
  kind: OutputType;
  /** One line: "Bill from Northwind for 1,240.00", "Reply to the customer, then mark solved". */
  summary: string;
  fields: OutputFieldDTO[];
  /** Text outputs (replies, messages, scorecards); null otherwise. */
  text: string | null;
  /** What changes in the tool: "save bill", "move to next stage", "mark solved". */
  actions: string[];
}

export interface GeneralDryRunInstanceDTO {
  instanceId: string;
  day: string;
  start: number;
  ours: OutputDTO;
  theirs: OutputDTO & { excerpt: string };
  match: { matched: number; total: number; value: number; arithmetic: string };
  steps: { ours: string[]; theirs: string[] };
  evidence: { eventIds: string[]; spanIds: string[]; frameIds: string[] };
  /** s27: readMinutes = time on the read source right before this instance; counted as saved only when readCounted. */
  estimate: { observedMinutes: number; reviewSeconds: number; savedMinutes: number; readMinutes?: number; readCounted?: boolean };
  /** The commit the s13 chain would make for this item after your approval (BatchItem.commit). */
  commit: {
    verb: string;
    fields: Array<[string, string]>;
    tool?: string;
    missing?: string[];
    /** s17: a tool from the Composio list (composio:<SLUG>): one row per field, recipients / amounts / ids marked. */
    review?: { rows: Array<{ path: string; label: string; value: string; highlight: "recipient" | "amount" | "id" | null; required: boolean; description: string | null }>; warning: string | null };
  } | null;
  warnings: string[];
}

export interface GeneralDryRunDTO {
  outputType: OutputType;
  variant: "a" | "b";
  instances: GeneralDryRunInstanceDTO[];
  totals: { instances: number; matched: number; total: number; agreement: number; arithmetic: string };
  /** Tone used for text steps: where the examples came from. null for non-text outputs. */
  tone: { source: "sent_mail" | "observed_text" | "none"; examples: number } | null;
}

export interface UserContextDTO {
  role?: string;
  industry?: string;
}

export interface ContextResponse {
  version: 1;
  context: UserContextDTO;
  updatedAt: number | null;
  suggestions: { roles: string[]; industries: string[] };
}

export interface UnderstandingStatusDTO {
  version: "v1" | "v2";
  embedder: string | null;
  framesRead: number;
}

// ---------- s27: read steps (workflows fetch their own data) ----------

/** One value a read step takes from its source: the commit label it fills and the label the source shows before it. */
export interface ReadFieldDTO {
  /** Label on the commit screen (the sheet's column): what the item's commit fills. */
  label: string;
  /** Label the source shows before the value ("Active users"). */
  sourceLabel: string;
  /** Instances whose source screen showed this value next to this label. */
  support: number;
}

/** The last read of a source: whether Offload read it itself, how, and in plain words. */
export interface ReadStatusDTO {
  at: number;
  ok: boolean;
  /** mcp | composio | api | computer when it was read; null when not. */
  via: string | null;
  message: string;
}

/** s27 (operator, 2026-10-26): the read's arguments, learned from the recordings: the report the person looked at (its
 * name), the fields, and the filters seen on screen (e.g. period "last 7 days"). Offload builds its own view of the
 * data from these; the page address the person had open is never stored. Shown in the dry run, covered by approvals. */
export interface ReadQueryDTO {
  report: string | null;
  fields: string[];
  filters: Array<[string, string]>;
}

/** s27: where a repeated task's values come from, learned from the recordings (plan/read-source.ts, code only).
 * Only labels, the app or site and code arithmetic are kept: never a value. */
export interface ReadSourceDTO {
  version: 1;
  /** Chain target id: a catalog connector, or `web-<host>` / `app-<name>`. */
  target: string;
  /** Display name ("PostHog"). */
  targetName: string;
  app: string;
  appName: string;
  host: string;
  /** The site (host) or app the source spans are matched on. */
  surface: string;
  fields: ReadFieldDTO[];
  /** Instances of the task in the recordings. */
  instances: number;
  /** Instances with this source on screen right before them. */
  seenBefore: number;
  /** Of those, instances where the values typed were on the source's screen. */
  withValues: number;
  readSecondsPerInstance: number;
  readHoursPerWeek: number;
  arithmetic: string;
  evidence: { spanIds: string[]; eventIds: string[]; frameIds: string[] };
  /** The learned read arguments (absent on sources found before round 1: the fields alone). */
  query?: ReadQueryDTO;
  foundAt: number;
  lastRead?: ReadStatusDTO | null;
}

/** s27: what a dry run read from the source now (read only), or why nothing was read. */
export interface ReadPreviewDTO {
  status: "fetched" | "refused" | "not_read" | "none";
  name: string | null;
  via: string | null;
  /** What the read asks the source for (learned); null without a source. */
  query: ReadQueryDTO | null;
  /** Fetched rows, [commit label, value] pairs, as the live batch would use them (the first 20 shown). */
  rows: Array<Array<[string, string]>>;
  /** Every row the source returned (rows shows at most 20). */
  rowsTotal: number;
  message: string;
}

/** s27: where the items of a live batch came from. */
export interface RunSourceDTO {
  kind: "read" | "list";
  /** The source's name, or the list file. */
  name: string;
  via: string | null;
  message: string;
}
