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
  estimate: { observedMinutes: number; reviewSeconds: number; savedMinutes: number };
  /** The commit the s13 chain would make for this item after your approval (BatchItem.commit). */
  commit: { verb: string; fields: Array<[string, string]>; tool?: string; missing?: string[] } | null;
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
