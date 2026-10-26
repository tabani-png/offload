// s14 general workflow builder: any task profile -> a WorkflowPlan (two variants, probed on last week, one chosen) and
// the legacy step list the gate, the runner and the app already read. Harness^2 per task: propose (steps.ts) ->
// optional wording pass by the design model (design.ts) -> probe both on the real instances (probe.ts) -> keep the
// closer one and show the choice. Deterministic for a deterministic model.
import type { Analysis, Insight } from "../analyze.ts";
import type { CapabilityNeedDTO, OutputType, PlanStepDTO, PlanVariantDTO, WorkflowPlanDTO } from "../api/s14-types.ts";
import { connectorById } from "../connectors/catalog.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import type { UserContext } from "../types.ts";
import type { WorkflowJson, WorkflowStep } from "../workflows/types.ts";
import { PendingChainResolver, type CapabilityResolver } from "./capabilities.ts";
import { designVariants } from "./design.ts";
import { taskEvidence, type TaskEvidence } from "./evidence.ts";
import { probe } from "./probe.ts";
import { outputTypeOf, proposeVariants, type PlanInput } from "./steps.ts";

/** Kinds the s05 email templates own; everything else gets a general plan when it has a task model. */
export const TEMPLATE_KINDS = new Set(["email.outreach", "email.scheduling"]);

export function wantsGeneralPlan(insight: Pick<Insight, "label" | "profile">): boolean {
  return !TEMPLATE_KINDS.has(insight.label.kind);
}

/** Fixed names per output type (template text, never an observed label). */
export const PLAN_TITLES: Record<OutputType, string> = {
  email: "Repeated emails",
  ticket_reply: "Ticket replies",
  message: "Repeated messages",
  form_fields: "Form entry",
  rows: "Row updates",
  stage_change: "Stage updates",
  record: "Record updates",
};

export const PLAN_DESCRIPTIONS: Record<OutputType, string> = {
  email: "Drafts each email in your tone from what it reads, and sends it after you approve it.",
  ticket_reply: "Reads each ticket, drafts the reply in your tone, and sends it after you approve it.",
  message: "Drafts each message in your tone from what it reads, and posts it after you approve it.",
  form_fields: "Reads each document, copies the values into the form, and saves it after you approve it.",
  rows: "Looks up each row's details and fills them in after you approve the batch.",
  stage_change: "Reviews each item, drafts your notes, and moves it on after you approve it.",
  record: "Reads each item and updates the record after you approve it.",
};

const WORD_RE = /^[A-Za-z][A-Za-z '’-]{0,39}$/;
/** Observed step words (masked captioner output) are only kept as short plain words; anything else becomes "item". */
export function plainWord(s: string, fallback = "item"): string {
  const t = s.trim().replace(/\s+/g, " ");
  return WORD_RE.test(t) ? t : fallback;
}

function planInput(ev: TaskEvidence): PlanInput {
  const u = ev.understanding;
  const steps = u.steps.map((s) => ({ ...s, verb: plainWord(s.verb, "update"), object: plainWord(s.object) }));
  return { understanding: { ...u, steps }, stepFrames: ev.stepFrames, stepIdKinds: ev.stepIdKinds, mail: u.steps.length > 0 && u.steps.every((s) => s.category === "email") };
}

export interface BuildOptions {
  analysis: Analysis;
  insight: Insight;
  model: Model;
  models: ModelConfig;
  user?: UserContext;
  resolver?: CapabilityResolver;
}

export interface Built {
  plan: WorkflowPlanDTO;
  evidence: TaskEvidence;
}

export class PlanError extends Error {}

export async function buildPlan(o: BuildOptions): Promise<Built> {
  const ev = taskEvidence(o.analysis, o.insight.taskId);
  if (ev === null) throw new PlanError(`no task ${o.insight.taskId} in this analysis`);
  const input = planInput(ev);
  const outputType = outputTypeOf(input);
  const rules = proposeVariants(input);
  const designed = await designVariants({ profile: o.insight.profile, variants: rules, model: o.model, models: o.models, ...(o.user === undefined ? {} : { user: o.user }) });
  const variants = designed.variants;
  const p = probe(variants, ev);
  const needs: CapabilityNeedDTO[] = variants.flatMap((v) => v.steps.map((s) => s.capability).filter((c): c is CapabilityNeedDTO => c !== null));
  const capabilities = await (o.resolver ?? new PendingChainResolver()).resolve(needs);
  const plan: WorkflowPlanDTO = {
    version: 2,
    outputType,
    goal: input.understanding.goal.replace(/[^\w ,.()'’→-]/g, " ").slice(0, 300),
    variants,
    chosen: p.chosen,
    chosenBy: "dry_run",
    probe: p.scores,
    reason: p.reason,
    designedBy: designed.designedBy,
    capabilities,
  };
  return { plan, evidence: ev };
}

export function chosenVariant(plan: WorkflowPlanDTO): PlanVariantDTO {
  return plan.variants.find((v) => v.id === plan.chosen) ?? plan.variants[0]!;
}

const GATE_STEP: WorkflowStep = {
  id: "review",
  type: "approval_gate",
  title: "You approve each item",
  detail: "Every item is shown next to what it came from. Nothing is written or sent until you approve this exact batch; a changed item is a new batch. Auto-run is off.",
  connector: null,
  sideEffect: false,
};

/** The legacy step list (read / draft / approval_gate / send / log) for the gate, the runner and the app. The approval
 * step always sits before the first commit; the first commit is the item's `send`, later ones are `log`. */
export function legacySteps(v: PlanVariantDTO): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  let commits = 0;
  for (const s of v.steps) {
    // s20 review 4: a UI commit on a catalog app is done on screen, never through that app's connector send.
    const connector = s.capability !== null && s.capability.via === "catalog" && s.capability.capability !== "ui.commit" ? s.capability.target : null;
    if (s.type === "commit") {
      if (commits === 0) out.push({ ...GATE_STEP });
      out.push({ id: s.id, type: commits === 0 ? "send" : "log", title: s.title, detail: s.detail, connector, sideEffect: true });
      commits += 1;
      continue;
    }
    out.push({ id: s.id, type: s.type === "draft" ? "draft" : "read", title: s.title, detail: s.detail, connector, sideEffect: false });
  }
  if (commits === 0) out.push({ ...GATE_STEP });
  return out;
}

/** Catalog connectors the plan uses: required when a commit needs them. */
export function planConnectors(v: PlanVariantDTO): WorkflowJson["connectors"] {
  const req = new Map<string, boolean>();
  for (const s of v.steps) {
    if (s.capability === null || s.capability.via !== "catalog" || connectorById(s.capability.target) === undefined) continue;
    req.set(s.capability.target, (req.get(s.capability.target) ?? false) || (s.type === "commit" && s.capability.capability !== "ui.commit"));
  }
  return [...req.entries()].sort((a, b) => Number(b[1]) - Number(a[1]) || (a[0] < b[0] ? -1 : 1)).map(([id, required]) => ({ id, required }));
}

const yamlStr = (s: string) => JSON.stringify(s);

function stepLine(s: PlanStepDTO, legacy: WorkflowStep | undefined, i: number): string {
  const title = legacy?.title ?? s.title;
  const detail = legacy?.detail ?? s.detail;
  const tag = s.type.toUpperCase();
  const need = s.capability === null ? "" : ` Needs: ${s.capability.need} (${s.capability.capability}, ${s.capability.role}).`;
  const when = s.when === null ? "" : ` Only ${s.when}.`;
  const gate = s.gated ? " Waits for your approval." : "";
  return `${i + 1}. **${title}** [${tag}].${when} ${detail}${need}${gate}`;
}

/** SKILL.md of a plan workflow: fixed text, catalog/app names, plain step words and code-computed numbers. */
export function renderPlanSkillMd(wf: WorkflowJson): string {
  const plan = wf.plan!;
  const v = chosenVariant(plan);
  const title = PLAN_TITLES[plan.outputType];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const gates = wf.steps.filter((s) => s.type === "approval_gate").map((s) => s.id);
  const other = plan.variants.find((x) => x.id !== v.id);
  const score = (id: string) => plan.probe.find((p) => p.variant === id);
  return [
    "---",
    `name: ${slug}`,
    `description: ${yamlStr(wf.description)}`,
    `connectors: [${wf.connectors.map((c) => c.id).join(", ")}]`,
    `targets: [${[...new Set(v.steps.flatMap((s) => (s.capability === null ? [] : [s.capability.target])))].join(", ")}]`,
    `gates: [${gates.join(", ")}]`,
    `auto_run: ${wf.autoRun ? "on" : "off"}`,
    `output: ${plan.outputType}`,
    `models: { design: ${wf.models.draft}, steps: ${wf.models.cheap} }`,
    "---",
    "",
    `# ${title}`,
    "",
    "## What this does",
    wf.description,
    "",
    `Estimated saving: ${wf.estimate.arithmetic} (range ${wf.estimate.lowHoursSaved.toFixed(1)}-${wf.estimate.highHoursSaved.toFixed(1)} h/wk). Measured time replaces this estimate after the first week.`,
    "",
    `## Steps (${v.label})`,
    ...v.steps.map((s, i) => stepLine(s, wf.steps.find((l) => l.id === s.id), i)),
    "",
    "## Why these steps",
    `Two versions were tried on last week's real items: ${plan.variants.map((x) => `"${x.label}" ${score(x.id)?.arithmetic ?? ""}`).join("; ")}. Kept "${v.label}" (${plan.reason}${plan.chosenBy === "user" ? ", your choice" : ""}).${other === undefined ? "" : ` The other one stays available.`}`,
    "",
    "## Rules",
    "- Nothing is written or sent before you approve the exact item. Every commit step waits for that approval, enforced in code.",
    "- Values (ids, amounts, dates, names) are copied by code from what was read. A model only writes text steps, in your tone, and any number it adds is flagged.",
    "- Each need is resolved per app in order: its connector, Composio, its API, then using the app on screen. If none works, stop and say which.",
    "- Do exactly the approved item, once.",
    "",
    "## Files",
    "- `workflow.json`: the typed plan (both versions), the steps, schedule and flags.",
    "- `facts.md`: facts text steps may use. Edit it.",
    "",
  ].join("\n");
}
