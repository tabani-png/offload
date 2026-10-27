// workflow.json, the typed half of a Workflow folder ($OFFLOAD_HOME/workflows/<id>/). SKILL.md is the plain-words
// half; facts.md holds the only facts drafts may state; scripts/ holds the deterministic parts.
import type { ReadSourceDTO, WorkflowPlanDTO } from "../api/s14-types.ts";
import type { StepToolsDTO } from "../plan/tools.ts";
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
  /** s20 review 5: "computer" = this side effect is a UI commit done on screen (computer use) on `connector`'s app,
   * never through that app's connector tools (e.g. "delete the email in Gmail" is not Gmail's send). */
  method?: "computer";
}

export type TemplateId = "investor_outreach" | "scheduling_reply" | "generic";

/** s10b N1: what auto-run was allowed to act on when it was turned on (hashes only). */
export interface AutoRunPin {
  at: number;
  /** addressHash(workflow, email) -> rowHash(row), for every row of the recipient list at pin time. */
  rows: Record<string, string>;
  /** "facts.md", "tone/<bucket>.md", "SKILL.md" -> sha256 of the text at pin time. */
  files: Record<string, string>;
}

export interface WorkflowJson {
  version: 1;
  id: string;
  insightId: string;
  taskId: string;
  kind: string;
  template: TemplateId;
  /** Fixed template text (s10b N8): a name taken from window titles lives in labels.json.enc (workflows/labels.ts). */
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
  /** `name` is "" since s10b N8 (the observed label is sealed in labels.json.enc). */
  insight: { name: string; kind: string; connectors: ConnectorDTO[] };
  lastDryRunAt: number | null;
  lastDryRunHash: string | null;
  /** s09b: the last time the serve run loop handled a due cron slot (started it, or skipped it while paused or with a
   * batch waiting). Absent until the first slot. */
  lastScheduledAt?: number | null;
  /** s10b N1: set while auto-run is on (enableAutoRun); null or absent = nothing pinned, nothing auto-sent. */
  autoRunPin?: AutoRunPin | null;
  /** s10b N2: the last scheduled run that did not finish, with a content-free reason; cleared by the next good run. */
  lastRunError?: { at: number; reason: string } | null;
  /** s14: the general plan (typed steps read/transform/decide/draft/commit, two probed variants, capability needs).
   * Present for workflows built from any task profile; `steps` above is derived from its chosen variant. */
  plan?: WorkflowPlanDTO;
  /** s14: tool options per step that needs an outside tool (best tool for the capability, connected first when good
   * enough), with the user's pick. Template workflows get them too; their sends still run through Gmail today. */
  tools?: StepToolsDTO[];
  /** s14: instances a day the tools were picked for (from the insight; code arithmetic). */
  volumePerDay?: number;
  /** s27: where the task's values come from (learned from the recordings, plan/read-source.ts) and the last read of
   * it. Absent when the recordings show no source: live items then come from `inputs.list`. Labels only, no values. */
  read?: ReadSourceDTO;
}
