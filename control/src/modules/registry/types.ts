/** The workflow definition of workflow-definition.schema.json without its object metadata (ADR 0104 §2). */
export type StepClass = "read" | "draft" | "commit";
export type Ownership = "company" | "personal-allowed" | "personal-forbidden";
export type ConnectionKind =
  | "gmail"
  | "google_workspace_shared"
  | "outlook"
  | "m365_shared_mailbox"
  | "composio_org"
  | "company_mcp"
  | "api"
  | "crm"
  | "company_linkedin_page"
  | "linkedin_personal"
  | "other";

export interface StepConnection {
  kind: ConnectionKind;
  ownership: Ownership;
  connectionId: string | null;
  label: string;
}

export interface Step {
  id: string;
  title: string;
  detail: string;
  class: StepClass;
  capability: string;
  connection: StepConnection | null;
  gate: "none" | "approval" | "overnight_policy";
}

export interface Definition {
  localWorkflowId: string;
  workflowId: string | null;
  version: number | null;
  name: string;
  description: string;
  trigger: { type: "manual" | "cron" | "event"; cron: string | null; timezone: string | null };
  steps: Step[];
  skillMd: string;
  factsKeys: string[];
  limits: { maxItemsPerRun: number; maxRunsPerDay: number };
}

/** A whole workflow-definition object: a proposal from a device or a stored registry version. */
export interface DefinitionObject extends Definition {
  id: string;
  kind: "workflow_proposal";
  createdAt: number;
  definitionHash: string;
}

export type WorkflowState = "proposed" | "role" | "retired" | "declined";

/** workflow.schema.json */
export interface WorkflowDto {
  id: string;
  name: string;
  state: WorkflowState;
  jobRoleId: string | null;
  departmentId: string | null;
  latestVersion: number;
  proposedBy: string | null;
  promotedBy: string | null;
  promotedAt: number | null;
  baselineGrade: "A" | "B" | "C" | null;
  versions: Array<{ version: number; definitionHash: string; createdAt: number; createdBy: string }>;
}
