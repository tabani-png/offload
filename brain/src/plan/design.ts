// s14 design model pass: Claude (claude-opus-5-5, role workflow_design) may rewrite the WORDING of the two rules
// variants for this person's field. It sees the masked task profile (understanding/context.ts profileSummary), the
// user context block and the rules variants as JSON; never images, never OCR text, never identifiers. Its reply may
// change only `label`, `summary` and each existing step's `title` and `detail`. Anything else (a new or missing step,
// a type, a capability, a gate, a digit) makes the whole reply ignored: the rules variants stand (ADR 0005, 0006).
import type { PlanVariantDTO } from "../api/s14-types.ts";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import type { TaskProfile, UserContext } from "../types.ts";
import { profileSummary, userContextBlock } from "../understanding/context.ts";

export const DESIGN_LIMITS = { label: 60, summary: 200, title: 120, detail: 400 } as const;

export const DESIGN_SYSTEM = [
  "You design the wording of a repeated computer task's workflow for the person who does it.",
  "You get the task profile (masked), optional background about the person, and two workflow variants as JSON.",
  "Rewrite only label, summary, and each step's title and detail so they read naturally for this person's field.",
  "Keep every variant id and every step id, in the same order. Do not add, remove or reorder steps.",
  "Do not use digits anywhere. Do not name people. Plain words, no jargon.",
  'Reply with JSON only: {"variants":[{"id":"a","label":"...","summary":"...","steps":[{"id":"...","title":"...","detail":"..."}]},{"id":"b",...}]}.',
].join("\n");

export function designPrompt(profile: TaskProfile, variants: readonly PlanVariantDTO[], user?: UserContext): string {
  const baseline = { variants: variants.map((v) => ({ id: v.id, label: v.label, summary: v.summary, steps: v.steps.map((s) => ({ id: s.id, type: s.type, title: s.title, detail: s.detail })) })) };
  return [userContextBlock(user), "<task_profile>", profileSummary(profile), "</task_profile>", "<baseline>", JSON.stringify(baseline, null, 2), "</baseline>"].filter((l) => l !== "").join("\n");
}

const BAD_TEXT = /[\d<>\u0000-\u001f\u007f]/;

function textOk(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim() !== "" && v.length <= max && !BAD_TEXT.test(v);
}

/** The rewritten variants, or null when the reply breaks any rule. */
export function applyDesignReply(variants: readonly PlanVariantDTO[], reply: string): PlanVariantDTO[] | null {
  const m = reply.match(/\{[\s\S]*\}/);
  if (m === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    // Not JSON: the rules wording stands.
    return null;
  }
  const rv = (parsed as { variants?: unknown }).variants;
  if (!Array.isArray(rv) || rv.length !== variants.length) return null;
  const out: PlanVariantDTO[] = [];
  for (let i = 0; i < variants.length; i++) {
    const base = variants[i]!;
    const r = rv[i] as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || r.id !== base.id) return null;
    for (const k of Object.keys(r)) if (!["id", "label", "summary", "steps"].includes(k)) return null;
    const label = r.label === undefined ? base.label : r.label;
    const summary = r.summary === undefined ? base.summary : r.summary;
    if (!textOk(label, DESIGN_LIMITS.label) || !textOk(summary, DESIGN_LIMITS.summary)) return null;
    const steps = r.steps;
    if (!Array.isArray(steps) || steps.length !== base.steps.length) return null;
    const newSteps = [];
    for (let j = 0; j < steps.length; j++) {
      const bs = base.steps[j]!;
      const s = steps[j] as Record<string, unknown> | null;
      if (typeof s !== "object" || s === null || s.id !== bs.id) return null;
      for (const k of Object.keys(s)) if (!["id", "type", "title", "detail"].includes(k)) return null;
      if (s.type !== undefined && s.type !== bs.type) return null;
      const title = s.title === undefined ? bs.title : s.title;
      const detail = s.detail === undefined ? bs.detail : s.detail;
      if (!textOk(title, DESIGN_LIMITS.title) || !textOk(detail, DESIGN_LIMITS.detail)) return null;
      // Everything but the words is the rules version's: type, capability, gate, condition, evidence.
      newSteps.push({ ...bs, title: title.trim(), detail: detail.trim() });
    }
    out.push({ ...base, label: label.trim(), summary: summary.trim(), steps: newSteps });
  }
  return out;
}

export interface DesignResult {
  variants: PlanVariantDTO[];
  designedBy: string;
}

/** One design call; any failure keeps the rules variants. */
export async function designVariants(o: { profile: TaskProfile; variants: readonly PlanVariantDTO[]; user?: UserContext; model: Model; models: ModelConfig }): Promise<DesignResult> {
  const id = modelFor("workflow_design", o.models);
  let reply: string;
  try {
    reply = await o.model.complete({ role: "workflow_design", model: id, system: DESIGN_SYSTEM, prompt: designPrompt(o.profile, o.variants, o.user), maxTokens: 4000, validate: (t) => (applyDesignReply(o.variants, t) === null ? "the reply broke the wording rules" : null) });
  } catch {
    // The model is optional for the structure: the rules variants are complete workflows.
    return { variants: [...o.variants], designedBy: "rules" };
  }
  const applied = applyDesignReply(o.variants, reply);
  if (applied === null) return { variants: [...o.variants], designedBy: "rules" };
  const same = JSON.stringify(applied) === JSON.stringify(o.variants);
  return { variants: applied, designedBy: same ? "rules" : id };
}
