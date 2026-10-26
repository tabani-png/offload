// s22 design pass: Opus (role solution_design -> router route "design", ADR 0009) designs the WORDS of each solution
// option for this person's field: what to build, why, and the builder brief (inputs, outputs, where it runs, the
// Claude Code prompt, acceptance checks). It sees the masked task profile (understanding/context.ts profileSummary),
// the user-context block and the rules options as JSON: never OCR text, titles or identifiers. Kinds, their order,
// every figure, the effort, the confidence and the evidence stay the rules' (ADR 0005). Any other change, a digit, an
// angle bracket or an over-long field makes the whole reply ignored.
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import type { UserContext } from "../types.ts";
import { profileSummary, userContextBlock } from "../understanding/context.ts";
import type { SolutionOption, SolutionSet, SolutionSubject } from "./types.ts";

export const SOLUTION_DESIGN_LIMITS = { what: 200, why: 300, item: 200, items: 8, runsWhere: 200, builderPrompt: 3000 } as const;

export const SOLUTION_DESIGN_SYSTEM = [
  "You design the best fix for one repeated computer task a person does. The task can be from any field: coding with agents, design, bookkeeping, support, recruiting, writing, messages. Do not assume it is about email or sales.",
  "You get the task profile (masked), optional background about the person, and the candidate fixes as JSON, already ranked by measured time saved.",
  "Kinds: workflow = automate the steps through the apps (drafted items, approved by the person); tool = build a custom tool or script; setup = change the person's setup or config (IDE, coding-agent rules and permissions, shortcuts, templates); remove_step = replace a manual sub-process with an automated pipeline; leave_alone = do nothing.",
  "For each option rewrite only: what (one line, what to build), why, and for options with a brief: inputs, outputs, runsWhere, builderPrompt (a prompt a coding agent can build from) and acceptance (checks that prove it works).",
  "Keep every kind in the same order. Do not add or remove options. Use no digits anywhere: times and counts are measured elsewhere. Do not name people. Nothing you design may send, post or save without the person approving the exact item.",
  'Reply with JSON only: {"options":[{"kind":"...","what":"...","why":"...","brief":{"inputs":["..."],"outputs":["..."],"runsWhere":"...","builderPrompt":"...","acceptance":["..."]}}]}. Leave out "brief" for options without one.',
].join("\n");

interface Baseline {
  kind: string;
  what: string;
  why: string;
  share: string;
  brief?: { inputs: string[]; outputs: string[]; runsWhere: string; builderPrompt: string; acceptance: string[] };
}

function baselineOf(set: SolutionSet): { options: Baseline[] } {
  return {
    options: set.options.map((o) => ({
      kind: o.kind,
      what: o.what,
      why: o.why,
      // A word, not a number: the model knows which options matter without seeing a figure.
      share: o.share >= 0.5 ? "most of the time" : o.share > 0 ? "part of the time" : "none of the time",
      ...(o.handoff.to === "brief" ? { brief: { inputs: o.handoff.spec.inputs, outputs: o.handoff.spec.outputs, runsWhere: o.handoff.spec.runsWhere, builderPrompt: o.handoff.spec.builderPrompt, acceptance: o.handoff.spec.acceptance } } : {}),
    })),
  };
}

export function solutionDesignPrompt(subject: SolutionSubject, set: SolutionSet, user?: UserContext): string {
  const parts = set.parts.map((p) => `part: ${p.name} [${p.tags.join(", ") || "untagged"}]`).join("\n");
  return [userContextBlock(user), "<task_profile>", profileSummary(subject.profile), `name: ${subject.label.name}`, parts, "</task_profile>", "<baseline>", JSON.stringify(baselineOf(set), null, 2), "</baseline>"].filter((l) => l !== "").join("\n");
}

const BAD_LINE = /[\d<>\u0000-\u001f\u007f]/;
const BAD_BLOCK = /[\d<>\u0000-\u0009\u000b-\u001f\u007f]/;

const line = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max && !BAD_LINE.test(v);
const block = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max && !BAD_BLOCK.test(v);
// A field the model left as the rules wrote it is the rules' text (it may hold a digit from a task name); a field the
// model wrote must pass the checks.
const same = (v: unknown, base: unknown) => JSON.stringify(v) === JSON.stringify(base);
const list = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= SOLUTION_DESIGN_LIMITS.items && v.every((x) => line(x, SOLUTION_DESIGN_LIMITS.item));

/** The set with the reworded options, or null when the reply breaks any rule. */
export function applySolutionDesign(set: SolutionSet, reply: string): SolutionSet | null {
  const m = reply.match(/\{[\s\S]*\}/);
  if (m === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    // Not JSON: the rules wording stands.
    return null;
  }
  const ro = (parsed as { options?: unknown }).options;
  if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).some((k) => k !== "options")) return null;
  if (!Array.isArray(ro) || ro.length !== set.options.length) return null;
  const out: SolutionOption[] = [];
  for (let i = 0; i < set.options.length; i++) {
    const base = set.options[i]!;
    const r = ro[i] as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || r.kind !== base.kind) return null;
    for (const k of Object.keys(r)) if (!["kind", "what", "why", "brief", "share"].includes(k)) return null;
    if (r.share !== undefined && typeof r.share !== "string") return null;
    const what = r.what ?? base.what;
    const why = r.why ?? base.why;
    if ((!same(what, base.what) && !line(what, SOLUTION_DESIGN_LIMITS.what)) || (!same(why, base.why) && !line(why, SOLUTION_DESIGN_LIMITS.why))) return null;
    let handoff = base.handoff;
    if (r.brief !== undefined) {
      if (base.handoff.to !== "brief") return null;
      const b = r.brief as Record<string, unknown> | null;
      if (typeof b !== "object" || b === null) return null;
      for (const k of Object.keys(b)) if (!["inputs", "outputs", "runsWhere", "builderPrompt", "acceptance"].includes(k)) return null;
      const spec = base.handoff.spec;
      const inputs = b.inputs ?? spec.inputs;
      const outputs = b.outputs ?? spec.outputs;
      const acceptance = b.acceptance ?? spec.acceptance;
      const runsWhere = b.runsWhere ?? spec.runsWhere;
      const builderPrompt = b.builderPrompt ?? spec.builderPrompt;
      const ok = (same(inputs, spec.inputs) || list(inputs)) && (same(outputs, spec.outputs) || list(outputs)) && (same(acceptance, spec.acceptance) || list(acceptance)) && (same(runsWhere, spec.runsWhere) || line(runsWhere, SOLUTION_DESIGN_LIMITS.runsWhere)) && (same(builderPrompt, spec.builderPrompt) || block(builderPrompt, SOLUTION_DESIGN_LIMITS.builderPrompt));
      if (!ok) return null;
      const t = (x: string) => x.trim();
      handoff = { to: "brief", spec: { inputs: (inputs as string[]).map(t), outputs: (outputs as string[]).map(t), runsWhere: t(runsWhere as string), acceptance: (acceptance as string[]).map(t), builderPrompt: t(builderPrompt as string) } };
    }
    // Everything but the words is the rules': kind, figures, effort, confidence, evidence.
    out.push({ ...base, what: (what as string).trim(), why: (why as string).trim(), handoff });
  }
  return { ...set, options: out };
}

/** One design call; any failure keeps the rules wording. */
export async function designSolutionWords(o: { subject: SolutionSubject; set: SolutionSet; user?: UserContext; model: Model; models: ModelConfig }): Promise<SolutionSet> {
  const id = modelFor("solution_design", o.models);
  let reply: string;
  try {
    reply = await o.model.complete({ role: "solution_design", model: id, system: SOLUTION_DESIGN_SYSTEM, prompt: solutionDesignPrompt(o.subject, o.set, o.user), maxTokens: 6000, validate: (t) => (applySolutionDesign(o.set, t) === null ? "the reply broke the solution wording rules" : null) });
  } catch {
    // The model only words the options: the rules set is complete without it.
    return o.set;
  }
  const applied = applySolutionDesign(o.set, reply);
  if (applied === null) return o.set;
  const same = JSON.stringify(applied.options) === JSON.stringify(o.set.options);
  return { ...applied, designedBy: same ? "rules" : id };
}
