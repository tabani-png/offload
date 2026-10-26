// workflow_proposal (G4): typed steps, gates, connector capabilities, SKILL.md text after masking, facts KEYS. Never
// facts values, recipient lists, tone examples or sent mail: ProposalInput carries none of them, and every text field
// is masked again here. definitionHash = sha256(JCS(definition without id, createdAt and the hash itself)).
import { sha256Hex } from "../encoding.ts";
import { canonicalize } from "../jcs.ts";
import type { ConnectionKind, ProjectionContext, ProposalInput, ProposalStep, ProposalStepInput, WorkflowProposal } from "../types.ts";
import { maskTo } from "./mask.ts";

const CAPABILITY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const CONNECTION_KIND: Record<string, ConnectionKind> = {
  gmail: "gmail",
  outlook: "outlook",
  linkedin: "linkedin_personal",
  hubspot: "crm",
  salesforce: "crm",
  pipedrive: "crm",
  attio: "crm",
  composio: "composio_org",
};

/** s13 vocabulary (domain.verb). The step's picked tool capability when it has one, else from type and connector. */
function capabilityOf(s: ProposalStepInput): string {
  if (s.capability !== null && CAPABILITY_RE.test(s.capability) && s.capability.length <= 120) return s.capability;
  const c = s.connector ?? "";
  const domain = /mail|outlook/.test(c) ? "mail" : /sheet/.test(c) ? "sheet" : /calendar/.test(c) ? "calendar" : /slack|teams/.test(c) ? "chat" : c === "" ? "local" : "app";
  switch (s.type) {
    case "read":
      return `${domain}.read`;
    case "draft":
      return "text.draft";
    case "send":
      return `${domain === "local" ? "app" : domain}.send`;
    case "log":
      return `${domain === "local" ? "file" : domain}.append`;
  }
}

function stepOf(s: ProposalStepInput, i: number): ProposalStep {
  const id = (s.id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64) || `step_${i + 1}`);
  const title = maskTo(s.title, 120).trim();
  return {
    id,
    title: title === "" ? `Step ${i + 1}` : title,
    detail: maskTo(s.detail, 600),
    class: s.type === "read" ? "read" : s.type === "draft" ? "draft" : "commit",
    capability: capabilityOf(s),
    // A personal workflow's connection: the registry re-tags ownership when it is promoted (ADR 0104).
    connection: s.connector === null ? null : { kind: CONNECTION_KIND[s.connector] ?? "other", ownership: "personal-allowed", connectionId: null, label: maskTo(s.connector, 120) },
    gate: s.sideEffect ? "approval" : "none",
  };
}

export function projectWorkflowProposal(i: ProposalInput, ctx: ProjectionContext): WorkflowProposal {
  const steps = i.steps.slice(0, 40).map(stepOf);
  const seen = new Set<string>();
  for (const s of steps) {
    while (seen.has(s.id)) s.id = `${s.id.slice(0, 60)}_${seen.size}`;
    seen.add(s.id);
  }
  const name = maskTo(i.name, 120).trim();
  const definition = {
    localWorkflowId: i.localWorkflowId.slice(0, 64),
    workflowId: i.binding?.workflowId ?? null,
    version: i.binding?.version ?? null,
    name: name === "" ? "Workflow" : name,
    description: maskTo(i.description, 1000),
    trigger: { type: i.trigger.type, cron: i.trigger.cron === null ? null : i.trigger.cron.slice(0, 100), timezone: i.trigger.timezone === null ? null : i.trigger.timezone.slice(0, 64) },
    steps,
    skillMd: maskTo(i.skillMd, 32768),
    factsKeys: [...new Set(i.factsKeys.map((k) => maskTo(k, 80)))].sort().slice(0, 50),
    limits: { maxItemsPerRun: Math.min(500, Math.max(1, Math.floor(i.batchSize))), maxRunsPerDay: 1 },
  };
  const definitionHash = sha256Hex(canonicalize(definition));
  return { id: ctx.ids("workflow_proposal", `${i.localWorkflowId}:${definitionHash}`, i.definedAt), kind: "workflow_proposal", createdAt: i.definedAt, ...definition, definitionHash };
}
