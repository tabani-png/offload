// s22 service: analysis -> solution sets, the design pass, choosing a kind (workflow -> the existing drafter
// unchanged; tool / setup / remove_step -> a draft brief), and the additive fields of GET /insights.
import type { Analysis, Insight } from "../analyze.ts";
import type { InsightsResponse } from "../api/types.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import type { UserContext } from "../types.ts";
import { draftGeneralWorkflow, draftWorkflow, isGeneralInsight, NotFoundError } from "../workflows/drafter.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { writeBrief, type SolutionBrief } from "./brief.ts";
import { designSolutionWords } from "./design.ts";
import { rulesSolutions } from "./rules.ts";
import { SOLUTION_KINDS, type SolutionKind, type SolutionSet, type SolutionSubject } from "./types.ts";

/** "N" = insight #N, "ins_…" = an insight or a held-back task by id, "held:N" = held-back task #N. */
export function resolveSubject(a: Analysis, ref: string): SolutionSubject {
  const held = a.heldBack ?? [];
  const h = /^held:(\d+)$/.exec(ref);
  if (h !== null) {
    const s = held[Number(h[1]) - 1];
    if (s === undefined) throw new NotFoundError(`no held-back task #${h[1]} (there are ${held.length})`);
    return s;
  }
  if (/^\d+$/.test(ref)) {
    const i = a.insights[Number(ref) - 1];
    if (i === undefined) throw new NotFoundError(`no insight #${ref} (there are ${a.insights.length})`);
    return i;
  }
  const s = a.insights.find((i) => i.id === ref) ?? held.find((t) => t.id === ref);
  if (s === undefined) throw new NotFoundError(`no insight ${ref}`);
  return s;
}

/** The rules set (no model): what GET /insights shows. */
export function solutionsFor(a: Analysis, subject: SolutionSubject): SolutionSet {
  const task = a.tasks.find((t) => t.id === subject.taskId);
  if (task === undefined) throw new NotFoundError(`no task ${subject.taskId}`);
  return rulesSolutions({ subject, task, windowDays: a.windowDays.length, ...(a.understanding === undefined ? {} : { stepOf: a.understanding.stepOf }) });
}

export interface DesignOptions {
  analysis: Analysis;
  ref: string;
  model: Model;
  models: ModelConfig;
  user?: UserContext;
}

/** Rules, then the Opus wording pass (figures untouched). */
export async function designSolutions(o: DesignOptions): Promise<{ subject: SolutionSubject; set: SolutionSet }> {
  const subject = resolveSubject(o.analysis, o.ref);
  const set = await designSolutionWords({ subject, set: solutionsFor(o.analysis, subject), model: o.model, models: o.models, ...(o.user === undefined ? {} : { user: o.user }) });
  return { subject, set };
}

export type ChooseResult = { kind: "workflow"; workflow: WorkflowJson; created: boolean } | { kind: Exclude<SolutionKind, "workflow" | "leave_alone">; brief: SolutionBrief; created: boolean };

export class ChooseError extends Error {}

export function parseKind(v: unknown): SolutionKind | null {
  return typeof v === "string" && (SOLUTION_KINDS as readonly string[]).includes(v) ? (v as SolutionKind) : null;
}

/** workflow: exactly what POST /workflows/draft does for this insight; tool/setup/remove_step: a draft brief. */
export async function chooseSolution(o: { home: string; analysis: Analysis; set: SolutionSet; kind: SolutionKind; model: Model; models: ModelConfig; user?: UserContext; now?: () => number }): Promise<ChooseResult> {
  const option = o.set.options.find((x) => x.kind === o.kind);
  if (option === undefined) throw new ChooseError(`no ${o.kind} option`);
  if (o.kind === "leave_alone") throw new ChooseError("leave_alone has nothing to build");
  if (option.weeklyHoursSaved <= 0 && option.handoff.to === "none") throw new ChooseError(`${o.kind} is not a fit for this task: ${option.why}`);
  if (option.handoff.to === "workflow_drafter") {
    const insightId = option.handoff.insightId;
    const common = { home: o.home, analysis: o.analysis, insightId, models: o.models, ...(o.now === undefined ? {} : { now: o.now }) };
    const r = isGeneralInsight(o.analysis, insightId) ? await draftGeneralWorkflow({ ...common, model: o.model, ...(o.user === undefined ? {} : { user: o.user }) }) : draftWorkflow(common);
    return { kind: "workflow", ...r };
  }
  const r = writeBrief(o.home, o.set, option, (o.now ?? Date.now)());
  return { kind: r.brief.kind, ...r };
}

/** The short form on each insight of GET /insights (rules only, no model call). */
export interface SolutionsSummaryDTO {
  top: SolutionKind;
  /** s26: the person chose to leave this task alone (left-alone.json); it is not suggested again. */
  leftAlone: boolean;
  observedWeeklyHours: number;
  options: Array<{ kind: SolutionKind; what: string; weeklyHoursSaved: number; effort: string; confidence: string }>;
}

export function solutionsSummary(set: SolutionSet, leftAlone = false): SolutionsSummaryDTO {
  return { top: set.top, leftAlone, observedWeeklyHours: set.observedWeeklyHours, options: set.options.map((x) => ({ kind: x.kind, what: x.what, weeklyHoursSaved: x.weeklyHoursSaved, effort: x.effort.level, confidence: x.confidence.level })) };
}

export interface HeldBackDTO {
  id: string;
  taskId: string;
  kind: string;
  name: string;
  description: string;
  category: string;
  reason: string;
  activeMinutes: number;
  instances: number;
  solutions: SolutionsSummaryDTO;
}

/** GET /insights plus, additively, `solutions` on each insight and `heldBack[]`. toInsights itself is unchanged. */
export function withSolutions(a: Analysis, body: InsightsResponse, left: ReadonlySet<string> = new Set()): InsightsResponse & { heldBack: HeldBackDTO[] } {
  const byId = new Map<string, Insight>(a.insights.map((i) => [i.id, i]));
  const insights = body.insights.map((dto) => {
    const i = byId.get(dto.id);
    return i === undefined ? dto : { ...dto, solutions: solutionsSummary(solutionsFor(a, i), left.has(i.taskId)) };
  });
  const heldBack = (a.heldBack ?? []).map((h) => ({
    id: h.id,
    taskId: h.taskId,
    kind: h.label.kind,
    name: h.label.name,
    description: h.label.description,
    category: h.profile.category,
    reason: h.heldBack.reason,
    activeMinutes: h.stats.activeMinutes.value,
    instances: h.stats.instances.value,
    solutions: solutionsSummary(solutionsFor(a, h), left.has(h.taskId)),
  }));
  return { ...body, insights, heldBack };
}
