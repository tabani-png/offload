// workflow.json, the typed half of a Workflow folder ($OFFLOAD_HOME/workflows/<id>/). SKILL.md is the plain-words
// half; facts.md holds the only facts drafts may state; scripts/ holds the deterministic parts.
import type { ConnectorDTO } from "../api/types.ts";
import type { ModelConfig } from "../models/model.ts";
import type { Bucket } from "../tone/types.ts";

export type StepType = "read" | "draft" | "approval_gate" | "send" | "log";

/** Stored lifecycle. The dashboard shows `needs_you` on top of `active` when a batch waits or a connector is missing. */
export type Lifecycle = "drafting" | "ready_for_review" | "active" | "paused";

export interface WorkflowStep {
  id: string;
  type: StepType;
  title: string;
  /** Plain words: what happens in this step. */
  detail: string;
  /** Catalog connector id, null for local steps. */
  connector: string | null;
  /** True for send / log steps that change something outside the Mac. They pass the approval gate. */
  sideEffect: boolean;
  /** Script in scripts/ that does this step deterministically. */
  script?: string;
  /** Tool the step uses, as the gate sees it (mcp__<server>__<tool>). */
  tool?: string;
}

export type TemplateId = "investor_outreach" | "scheduling_reply" | "generic";

export interface WorkflowJson {
  version: 1;
  id: string;
  insightId: string;
  taskId: string;
  kind: string;
  template: TemplateId;
  name: string;
  description: string;
  /** Tone bucket the drafts use. */
  bucket: Bucket;
  createdAt: number;
  updatedAt: number;
  status: Lifecycle;
  activatedAt: number | null;
  pausedAt: number | null;
  /** Off by default (ADR 0006). When on, a live run may act on its own batch without a review. */
  autoRun: boolean;
  schedule: { type: "manual" } | { type: "cron"; cron: string; timezone: string; note: string };
  trigger: { type: "manual" | "schedule" | "new_email"; detail: string };
  batchSize: number;
  reviewSecondsPerItem: number;
  connectors: Array<{ id: string; required: boolean }>;
  /** crmSheet: where the CRM log tool may append (optional; without it the gate denies the sheet log tool). */
  inputs: { list: string; crmLog: string; subjectTemplate: string; crmSheet?: { spreadsheetId: string; range: string } };
  steps: WorkflowStep[];
  estimate: { weeklyHoursSaved: number; savingPct: number; arithmetic: string; lowHoursSaved: number; highHoursSaved: number };
  models: ModelConfig;
  insight: { name: string; kind: string; connectors: ConnectorDTO[] };
  lastDryRunAt: number | null;
  lastDryRunHash: string | null;
}
