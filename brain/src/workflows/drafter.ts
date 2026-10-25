// Workflow drafter: Insight -> $OFFLOAD_HOME/workflows/<id>/ (SKILL.md, workflow.json, facts.md, recipients.csv,
// scripts/). The structure is deterministic (a template per task kind); the model only writes drafts later, per
// recipient. The estimate is the insight's saving estimate, copied with its arithmetic (ADR 0005).
// SKILL.md and the description are fixed template text: insight labels come from observed window titles and hosts
// (attacker-controllable text), so they never reach a prompt (REVIEW-1 M5). They are observed text too, so they are
// sealed in labels.json.enc under the capture day of the oldest instance and purged with it; workflow.json keeps
// fixed template names and ids only (REVIEW-2 N8, workflows/labels.ts).
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis, Insight } from "../analyze.ts";
import { insightConnectors } from "../api/dto.ts";
import { connectorById } from "../connectors/catalog.ts";
import { DEFAULT_MODELS, type ModelConfig } from "../models/model.ts";
import type { Bucket } from "../tone/types.ts";
import { localDay } from "../store/vault.ts";
import { FIXED_NAMES, sealLabels } from "./labels.ts";
import { RECIPIENTS_HEADER } from "./scripts/recipients.ts";
import { CRM_HEADER } from "./scripts/crm-log.ts";
import { ensureDir, readWorkflow, workflowDir, writePrivate, writeWorkflow } from "./store.ts";
import type { TemplateId, WorkflowJson, WorkflowStep } from "./types.ts";
import { buildPlan, chosenVariant, legacySteps, PLAN_DESCRIPTIONS, PLAN_TITLES, planConnectors, renderPlanSkillMd, wantsGeneralPlan } from "../plan/build.ts";
import type { CapabilityResolver } from "../plan/capabilities.ts";
import type { Model } from "../models/model.ts";
import type { UserContext } from "../types.ts";
import { carryChoices, chainReadsOnly, recommendTools, refineTools } from "../plan/tools.ts";
import { readUniverse } from "../connectors/universe.ts";
import { chainConnected } from "../connectors/chain.ts";
import { connectorStatus } from "./service.ts";
import { userContextBlock, profileSummary } from "../understanding/context.ts";

export class NotFoundError extends Error {}

export const FACTS_TEMPLATE = `# Facts for drafting
Only these facts may appear in drafts. Anything missing shows up as [missing: ...] in the draft. Edit freely.

company:
pitch:
raise:
traction:
ask:
sign:
subject: {company} <> {org}
`;

/** s10e: `$OFFLOAD_HOME/default-facts.md`, when present, seeds facts.md of new workflows (scripts/demo.sh writes the
 * fixture founder's facts there). It is the user's own text, never observed content. */
export const DEFAULT_FACTS_FILE = "default-facts.md";
function defaultFacts(home: string): string | null {
  const p = join(home, DEFAULT_FACTS_FILE);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  return text.trim() === "" || text.length > 16 * 1024 ? null : text;
}

export const workflowIdFor = (insightId: string) => `wf_${insightId.replace(/^ins_/, "")}`;

const SCRIPTS = ["recipients.ts", "crm-log.ts"] as const;

interface Template {
  id: TemplateId;
  bucket: Bucket;
  name: (i: Insight) => string;
  description: () => string;
  steps: (primary: string | null) => WorkflowStep[];
  connectors: (primary: string | null) => Array<{ id: string; required: boolean }>;
  schedule: WorkflowJson["schedule"];
  trigger: WorkflowJson["trigger"];
}

const GATE_STEP: WorkflowStep = {
  id: "review",
  type: "approval_gate",
  title: "You review the batch",
  detail: "Every draft is shown next to its recipient. Nothing is sent until you approve this exact batch; a changed draft is a new batch. Auto-run is off.",
  connector: null,
  sideEffect: false,
};

const TEMPLATES: Record<TemplateId, Template> = {
  investor_outreach: {
    id: "investor_outreach",
    bucket: "investor_outreach",
    name: () => "Investor outreach emails",
    description: () => "Drafts your investor outreach emails in your own tone, a batch at a time, and sends them from Gmail after you approve the batch.",
    steps: () => [
      { id: "read_list", type: "read", title: "Read the investor list", detail: "Read recipients.csv (an export of your investor sheet: email, first_name, last_name, org, notes).", connector: null, sideEffect: false, script: "scripts/recipients.ts" },
      { id: "pick", type: "read", title: "Pick the next people", detail: "Take the next people on the list who are not in crm-log.csv yet, up to the batch size.", connector: null, sideEffect: false, script: "scripts/recipients.ts" },
      { id: "draft", type: "draft", title: "Draft each email in your tone", detail: "For each person: your investor-outreach style card, the 3-5 closest emails you sent before, facts.md and the person's row. Numbers not in facts.md are flagged.", connector: null, sideEffect: false },
      GATE_STEP,
      { id: "send", type: "send", title: "Send from Gmail", detail: "Send each approved email exactly as approved, one at a time, from your Gmail.", connector: "gmail", sideEffect: true, tool: "mcp__gmail__send_email" },
      { id: "log", type: "log", title: "Log to the CRM sheet", detail: "Add a row per sent email to crm-log.csv, and to your CRM sheet when Google Sheets is connected.", connector: "google-sheets", sideEffect: true, script: "scripts/crm-log.ts", tool: "mcp__sheets__append_row" },
    ],
    connectors: () => [
      { id: "gmail", required: true },
      { id: "google-sheets", required: false },
    ],
    schedule: { type: "cron", cron: "0 9 * * 1-5", timezone: "local", note: "Weekdays at 09:00 a new batch is drafted and waits for your review." },
    trigger: { type: "schedule", detail: "Weekday mornings, or when you ask for the next batch." },
  },
  scheduling_reply: {
    id: "scheduling_reply",
    bucket: "scheduling",
    name: () => "Scheduling replies",
    description: () => "Finds threads that ask for a meeting time, checks your calendar and drafts a reply with two free slots in your tone.",
    steps: () => [
      { id: "find_threads", type: "read", title: "Find threads asking for a time", detail: "Search Gmail for unanswered replies that ask when you are free.", connector: "gmail", sideEffect: false, tool: "mcp__gmail__search_emails" },
      { id: "free_slots", type: "read", title: "Check your free slots", detail: "Read your calendar for the next 5 working days and take the first two free 30-minute slots.", connector: "google-calendar", sideEffect: false, tool: "mcp__calendar__find_free_slots" },
      { id: "draft", type: "draft", title: "Draft each reply in your tone", detail: "Your scheduling style card, the 3-5 closest replies you sent before and the two slots.", connector: null, sideEffect: false },
      GATE_STEP,
      { id: "send", type: "send", title: "Reply in the thread", detail: "Send each approved reply in its thread from your Gmail.", connector: "gmail", sideEffect: true, tool: "mcp__gmail__reply_email" },
      { id: "log", type: "log", title: "Log the reply", detail: "Add a row per reply to crm-log.csv.", connector: null, sideEffect: false, script: "scripts/crm-log.ts" },
    ],
    connectors: () => [
      { id: "gmail", required: true },
      { id: "google-calendar", required: true },
    ],
    schedule: { type: "manual" },
    trigger: { type: "new_email", detail: "When a reply asks for a time." },
  },
  generic: {
    id: "generic",
    bucket: "other",
    name: () => FIXED_NAMES.generic,
    description: () => "Drafts this repeated task for your review, then does it through the connected tool.",
    steps: (primary) => [
      { id: "read", type: "read", title: "Read what needs doing", detail: "Read the items waiting in the connected tool.", connector: primary, sideEffect: false },
      { id: "draft", type: "draft", title: "Draft each item", detail: "Draft each item from your past examples and facts.md.", connector: null, sideEffect: false },
      GATE_STEP,
      { id: "send", type: "send", title: "Apply in the tool", detail: "Apply each approved item through the connected tool.", connector: primary, sideEffect: true },
      { id: "log", type: "log", title: "Log it", detail: "Add a row per item to crm-log.csv.", connector: null, sideEffect: false, script: "scripts/crm-log.ts" },
    ],
    connectors: (primary) => (primary === null ? [] : [{ id: primary, required: true }]),
    schedule: { type: "manual" },
    trigger: { type: "manual", detail: "When you ask for the next batch." },
  },
};

export function templateFor(kind: string): TemplateId {
  if (kind === "email.outreach") return "investor_outreach";
  if (kind === "email.scheduling") return "scheduling_reply";
  return "generic";
}

const yamlStr = (s: string) => JSON.stringify(s);

/** Fixed SKILL.md titles per template: never the observed label. */
const SKILL_TITLES: Record<TemplateId, string> = {
  investor_outreach: "Investor outreach emails",
  scheduling_reply: "Scheduling replies",
  generic: "Repeated task",
};

/** SKILL.md from fixed template text, catalog names, code-computed numbers and text the user edited through
 * PUT /workflows/:id/skill (workflows/skill.ts). Never observed labels. */
export function renderSkillMd(wf: WorkflowJson): string {
  if (wf.plan !== undefined) return renderPlanSkillMd(wf);
  const gates = wf.steps.filter((s) => s.type === "approval_gate").map((s) => s.id);
  const conn = wf.connectors.map((c) => `${c.id}${c.required ? "" : " (optional)"}`);
  const title = SKILL_TITLES[wf.template];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [
    "---",
    `name: ${slug}`,
    `description: ${yamlStr(wf.description)}`,
    `connectors: [${wf.connectors.map((c) => c.id).join(", ")}]`,
    `gates: [${gates.join(", ")}]`,
    `auto_run: ${wf.autoRun ? "on" : "off"}`,
    `models: { draft: ${wf.models.draft}, cheap: ${wf.models.cheap} }`,
    "---",
    "",
    `# ${title}`,
    "",
    "## What this does",
    wf.description,
    "",
    `Estimated saving: ${wf.estimate.arithmetic} (range ${wf.estimate.lowHoursSaved.toFixed(1)}-${wf.estimate.highHoursSaved.toFixed(1)} h/wk). Measured time replaces this estimate after the first week.`,
    "",
    "## Steps",
    ...wf.steps.map((s, i) => `${i + 1}. **${s.title}**${s.connector === null ? "" : ` (${connectorById(s.connector)?.name ?? s.connector})`}. ${s.detail}`),
    "",
    "## Rules",
    "- Nothing leaves this Mac before the review step approves the exact batch. The approval gate is enforced in code.",
    "- Drafts state only what is in facts.md and the recipient's row. Gaps show as [missing: ...].",
    "- Send exactly the approved text to exactly the approved recipient, once.",
    "- If a needed connector is not connected, stop and say which one.",
    "",
    "## Connectors",
    ...conn.map((c) => `- ${c}`),
    "",
    "## Files",
    "- `workflow.json`: the typed steps, schedule and flags.",
    "- `facts.md`: the only facts drafts may use. Edit it.",
    `- \`${wf.inputs.list}\`: who to write to. \`${wf.inputs.crmLog}\`: who was already written to.`,
    "- `scripts/`: the deterministic steps (pick recipients, CRM log).",
    "",
  ].join("\n");
}

export interface DraftWorkflowOptions {
  home: string;
  analysis: Analysis;
  insightId: string;
  /** facts.md content; default FACTS_TEMPLATE. Never overwrites an existing facts.md. */
  facts?: string;
  models?: ModelConfig;
  now?: () => number;
}

/** Writes the workflow folder for an insight. Idempotent: an existing workflow is returned unchanged. */
export function draftWorkflow(o: DraftWorkflowOptions): { workflow: WorkflowJson; created: boolean } {
  const insight = o.analysis.insights.find((i) => i.id === o.insightId);
  if (insight === undefined) throw new NotFoundError(`no insight ${o.insightId}`);
  const id = workflowIdFor(insight.id);
  const existing = readWorkflow(o.home, id);
  if (existing !== null) return { workflow: existing, created: false };

  const now = (o.now ?? Date.now)();
  const t = TEMPLATES[templateFor(insight.label.kind)];
  const primary = insight.connectors.primary?.id ?? null;
  const s = insight.saving;
  const wf: WorkflowJson = {
    version: 1,
    id,
    insightId: insight.id,
    taskId: insight.taskId,
    kind: insight.label.kind,
    template: t.id,
    name: t.name(insight),
    description: t.description(),
    bucket: t.bucket,
    createdAt: now,
    updatedAt: now,
    status: "drafting",
    activatedAt: null,
    pausedAt: null,
    autoRun: false,
    schedule: t.schedule,
    trigger: t.trigger,
    batchSize: 20,
    reviewSecondsPerItem: s.reviewSecondsPerItem,
    connectors: t.connectors(primary),
    inputs: { list: "recipients.csv", crmLog: "crm-log.csv", subjectTemplate: "{company} <> {org}" },
    steps: t.steps(primary),
    estimate: { weeklyHoursSaved: s.weeklyHoursSaved, savingPct: s.savingPct, arithmetic: s.arithmetic, lowHoursSaved: s.range.low.hoursSaved, highHoursSaved: s.range.high.hoursSaved },
    models: o.models ?? { ...DEFAULT_MODELS },
    insight: { name: "", kind: insight.label.kind, connectors: insightConnectors(insight) },
    lastDryRunAt: null,
    lastDryRunHash: null,
  };
  // s14: tool options for the send and log steps (an outreach platform for 100 a day, the CRM for the log).
  wf.volumePerDay = insight.stats.instancesPerDay.value;
  wf.tools = recommendTools({ legacy: { kind: wf.kind, steps: wf.steps }, perDay: insight.stats.instancesPerDay.value, connected: connectedIds(o.home), readsOnly: chainReadsOnly(o.home), universe: readUniverse(o.home) });
  // "drafting" is on disk while the folder is being written, so a crash leaves a visible half-draft.
  writeWorkflow(o.home, wf);
  const dir = workflowDir(o.home, id);
  ensureDir(join(dir, "scripts"));
  for (const f of SCRIPTS) copyFileSync(new URL(`./scripts/${f}`, import.meta.url), join(dir, "scripts", f));
  if (!existsSync(join(dir, "facts.md"))) writePrivate(join(dir, "facts.md"), o.facts ?? defaultFacts(o.home) ?? FACTS_TEMPLATE);
  if (!existsSync(join(dir, wf.inputs.list))) writePrivate(join(dir, wf.inputs.list), RECIPIENTS_HEADER + "\n");
  if (!existsSync(join(dir, wf.inputs.crmLog))) writePrivate(join(dir, wf.inputs.crmLog), CRM_HEADER + "\n");
  writePrivate(join(dir, "SKILL.md"), renderSkillMd(wf));
  const days = (o.analysis.tasks.find((t) => t.id === insight.taskId)?.instances ?? []).map((i) => i.day).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  sealLabels(o.home, id, { name: t.id === "generic" ? insight.label.name : wf.name, insightName: insight.label.name }, days[0] ?? localDay(now), now);
  wf.status = "ready_for_review";
  writeWorkflow(o.home, wf);
  return { workflow: wf, created: true };
}

// ---------- s14: general workflows from any task profile ----------

export interface DraftGeneralOptions extends DraftWorkflowOptions {
  model: Model;
  user?: UserContext;
  resolver?: CapabilityResolver;
}

/** True when POST /workflows/draft for this insight builds a general plan (not an s05 email template). */
export function isGeneralInsight(analysis: Analysis, insightId: string): boolean {
  const insight = analysis.insights.find((i) => i.id === insightId);
  return insight !== undefined && wantsGeneralPlan(insight);
}

/**
 * Builds and writes a general workflow folder (SKILL.md, workflow.json with the plan, facts.md). Idempotent like
 * draftWorkflow. The plan's two variants are probed on last week's instances here; the dry run shows the result.
 */
export async function draftGeneralWorkflow(o: DraftGeneralOptions): Promise<{ workflow: WorkflowJson; created: boolean }> {
  const insight = o.analysis.insights.find((i) => i.id === o.insightId);
  if (insight === undefined) throw new NotFoundError(`no insight ${o.insightId}`);
  const id = workflowIdFor(insight.id);
  const existing = readWorkflow(o.home, id);
  if (existing !== null) return { workflow: existing, created: false };
  const now = (o.now ?? Date.now)();
  const models = o.models ?? { ...DEFAULT_MODELS };
  const { plan } = await buildPlan({ analysis: o.analysis, insight, model: o.model, models, ...(o.user === undefined ? {} : { user: o.user }), ...(o.resolver === undefined ? {} : { resolver: o.resolver }) });
  const v = chosenVariant(plan);
  const s = insight.saving;
  const wf: WorkflowJson = {
    version: 1,
    id,
    insightId: insight.id,
    taskId: insight.taskId,
    kind: insight.label.kind,
    template: "generic",
    name: PLAN_TITLES[plan.outputType],
    description: PLAN_DESCRIPTIONS[plan.outputType],
    bucket: "other",
    createdAt: now,
    updatedAt: now,
    status: "drafting",
    activatedAt: null,
    pausedAt: null,
    autoRun: false,
    schedule: { type: "manual" },
    trigger: { type: "manual", detail: "When you ask for the next batch." },
    batchSize: 20,
    reviewSecondsPerItem: s.reviewSecondsPerItem,
    connectors: planConnectors(v),
    inputs: { list: "items.csv", crmLog: "done-log.csv", subjectTemplate: "" },
    steps: legacySteps(v),
    estimate: { weeklyHoursSaved: s.weeklyHoursSaved, savingPct: s.savingPct, arithmetic: s.arithmetic, lowHoursSaved: s.range.low.hoursSaved, highHoursSaved: s.range.high.hoursSaved },
    models,
    insight: { name: "", kind: insight.label.kind, connectors: insightConnectors(insight) },
    lastDryRunAt: null,
    lastDryRunHash: null,
    plan,
  };
  const ctx = [userContextBlock(o.user), "<task_profile>", profileSummary(insight.profile), "</task_profile>"].filter((l) => l !== "").join("\n");
  wf.volumePerDay = insight.stats.instancesPerDay.value;
  wf.tools = await refineTools(recommendTools({ plan: { outputType: plan.outputType, variant: v }, perDay: insight.stats.instancesPerDay.value, connected: connectedIds(o.home), readsOnly: chainReadsOnly(o.home), universe: readUniverse(o.home) }), { model: o.model, models, context: ctx });
  writeWorkflow(o.home, wf);
  const dir = workflowDir(o.home, id);
  if (!existsSync(join(dir, "facts.md"))) writePrivate(join(dir, "facts.md"), GENERAL_FACTS);
  writePrivate(join(dir, "SKILL.md"), renderSkillMd(wf));
  const days = (o.analysis.tasks.find((t) => t.id === insight.taskId)?.instances ?? []).map((i) => i.day).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  sealLabels(o.home, id, { name: insight.label.name, insightName: insight.label.name }, days[0] ?? localDay(now), now);
  wf.status = "ready_for_review";
  writeWorkflow(o.home, wf);
  return { workflow: wf, created: true };
}

export const GENERAL_FACTS = `# Facts for text steps
Only these facts may appear in drafted text (replies, notes, messages). Values copied from what is read need no entry here.

sign:
`;

/** Keeps the other variant (POST /workflows/:id/plan): the steps and SKILL.md follow it; edits to step text are reset. */
export function chooseVariant(home: string, id: string, variant: "a" | "b", now: number): WorkflowJson {
  const wf = readWorkflow(home, id);
  if (wf === null) throw new NotFoundError(`no workflow ${id}`);
  if (wf.plan === undefined) throw new NotFoundError(`workflow ${id} has no plan to choose from`);
  const plan = { ...wf.plan, chosen: variant, chosenBy: "user" as const };
  const v = chosenVariant(plan);
  const next: WorkflowJson = { ...wf, plan, steps: legacySteps(v), connectors: planConnectors(v), updatedAt: now };
  // Tool options follow the steps of the new variant; picks for steps that stay are kept.
  next.tools = carryChoices(recommendTools({ plan: { outputType: plan.outputType, variant: v }, perDay: perDayOf(wf), connected: connectedIds(home), readsOnly: chainReadsOnly(home), universe: readUniverse(home) }), wf.tools);
  // A different plan is a different workflow to review: the last dry run no longer stands for it.
  if (next.status === "active") next.status = "ready_for_review";
  next.lastDryRunHash = null;
  writeWorkflow(home, next);
  writePrivate(join(workflowDir(home, id), "SKILL.md"), renderSkillMd(next));
  return next;
}

/** Catalog ids that are connected now (connectors.json + env), for "already connected" and the default pick. */
export function connectedIds(home: string): Set<string> {
  try {
    // connectors.json + env, plus anything a cached s13 chain decision can commit through.
    return new Set([...Object.entries(connectorStatus(home, process.env)).filter(([, st]) => st === "connected").map(([id]) => id), ...chainConnected(home, Date.now())]);
  } catch {
    // An unreadable connectors.json: nothing counts as connected.
    return new Set();
  }
}

const perDayOf = (wf: WorkflowJson) => wf.volumePerDay ?? 0;
