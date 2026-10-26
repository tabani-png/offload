// s14 generic dry run: the chosen plan variant on last week's real instances, every side effect disabled. Per
// instance: what the workflow would have produced next to what the user did (outputs.ts), the steps both took, the
// evidence ids and the time arithmetic (code, ADR 0005). Text steps are drafted by the cheap model from masked text
// with the user's text tone (tone/text-source.ts; Sent mail for email outputs).
import type { Analysis } from "../analyze.ts";
import type { GeneralDryRunDTO, GeneralDryRunInstanceDTO } from "../api/s14-types.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import { loadTonePack } from "../tone/pack.ts";
import { buildTextTonePack, typedText, type TextExample, type TextTonePack } from "../tone/text-source.ts";
import type { UserContext } from "../types.ts";
import type { BatchItem } from "../workflows/batch.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { chosenVariant } from "./build.ts";
import { slugify } from "./capabilities.ts";
import { taskEvidence } from "./evidence.ts";
import { buildActions, buildFields, round1, shapeOf, sourceText } from "./outputs.ts";
import { predictedSteps } from "./probe.ts";
import { draftTextStep } from "./text-step.ts";
import { commitFor, missingWords } from "./commit-fields.ts";
import { readSchema, readUniverse } from "../connectors/universe.ts";
import { NameMap } from "../privacy/names.ts";
import { readNamePolicy, signNames } from "../privacy/policy.ts";
import { fillFromSource, queryText, sourceSpansBefore } from "./read-source.ts";

export interface GeneralDryRunOptions {
  home: string;
  analysis: Analysis;
  wf: WorkflowJson;
  model: Model;
  models: ModelConfig;
  limit: number;
  now: number;
  user?: UserContext;
  /** facts.md text: the only facts drafted text may state. */
  facts?: string;
  /** s27: the workflow's read source was read by Offload itself just now: its reading time counts as saved. */
  readAutomated?: boolean;
}

export interface GeneralDryRun {
  general: GeneralDryRunDTO;
  items: BatchItem[];
  /** The tool names the gate is asked about for every commit step (all denied in a dry run). */
  commitTools: string[];
  warnings: string[];
}

/** s26: the warning on a dry-run instance the workflow could not fill at all. */
export const NOTHING_TO_FILL = "nothing to fill from what was on screen: this one stays with you";

/** s26: a field output with no value filled and no text: the workflow would do none of this instance's work. */
export function producesNothing(outputType: string, ours: { fields: ReadonlyArray<{ value: string | null }>; text: string | null }): boolean {
  return (outputType === "rows" || outputType === "form_fields") && (ours.text ?? "") === "" && ours.fields.every((f) => f.value === null || f.value === "");
}

/** The gate sees a commit as mcp__<target>__commit until the s13 chain names the real tool. */
export const commitToolName = (target: string) => `mcp__${slugify(target).replace(/-/g, "_")}__commit`;

function emailPack(home: string, now: number): TextTonePack | null {
  const p = loadTonePack(home, now);
  if (p === null || p.corpus.length === 0) return null;
  const examples: TextExample[] = p.corpus.map((e) => ({ id: e.id, kind: "email", text: e.text, ts: e.sentAt, eventId: e.id }));
  return { kind: "email", examples, card: p.cards.other ?? p.cards.follow_up ?? "", measured: { examples: examples.length, medianWords: 0, greeting: null, signOff: null } };
}

export async function generalDryRun(o: GeneralDryRunOptions): Promise<GeneralDryRun> {
  const plan = o.wf.plan!;
  const v = chosenVariant(plan);
  const warnings: string[] = [];
  const ev = taskEvidence(o.analysis, o.wf.taskId);
  if (ev === null) return { general: { outputType: plan.outputType, variant: v.id, instances: [], totals: { instances: 0, matched: 0, total: 0, agreement: 0, arithmetic: "no instance of this task in the last 7 days" }, tone: null }, items: [], commitTools: [], warnings: ["this task has no instance in the last 7 days"] };
  const sh = shapeOf(v, ev, plan.outputType);
  const textStep = v.steps.find((s) => s.type === "draft" && s.writesText);
  // Tone only for text steps (SPEC 3): the user's own typed text on the commit screen, or Sent mail for email.
  let pack: TextTonePack | null = null;
  let toneSource: "sent_mail" | "observed_text" | "none" = "none";
  if (textStep !== undefined) {
    if (plan.outputType === "email") {
      pack = emailPack(o.home, o.now);
      if (pack !== null) toneSource = "sent_mail";
    } else {
      const spans = ev.instances.flatMap((i) => [...sh.commitSteps].flatMap((s) => i.bySteps.get(s)?.spans ?? []));
      const p = buildTextTonePack(plan.outputType, spans);
      if (p.examples.length > 0) {
        pack = p;
        toneSource = "observed_text";
      }
    }
    if (pack === null) warnings.push("no examples of your own texts yet: drafts are short and plain until Offload sees you write some");
  }
  const facts = (o.facts ?? "").split("\n").filter((l) => /^[a-z][\w ]{0,30}:\s*\S/i.test(l.trim())).join("\n");
  const out: GeneralDryRunInstanceDTO[] = [];
  const items: BatchItem[] = [];
  const universe = readUniverse(o.home);
  // s18: one name map per dry run, so the same person has the same placeholder in every instance's prompt. The facts
  // `sign:` line is the user's own name. The map never leaves this function's process.
  const names = new NameMap(readNamePolicy(o.home, signNames(facts)));
  const src = o.wf.read;
  const fromSource = src !== undefined && (sh.outputType === "form_fields" || sh.outputType === "rows");
  for (const inst of ev.instances.slice(0, o.limit)) {
    let built;
    let readMinutes = 0;
    if (fromSource && src !== undefined) {
      // s27: the values this instance needed were on the source's screen right before it: filled from there (code).
      const spans = sourceSpansBefore(o.analysis, o.wf.taskId, src, inst.instance);
      readMinutes = round1(spans.reduce((n, x) => n + x.activeMs, 0) / 60_000);
      const commitOcr = [...sh.commitSteps].flatMap((s) => inst.bySteps.get(s)?.ocr ?? []);
      built = fillFromSource(src, spans.flatMap((x) => x.ocr.map((t) => t.text)).join("\n"), commitOcr, { outputType: sh.outputType, verb: sh.commitVerb, object: sh.commitObject });
    } else if (sh.outputType === "form_fields" || sh.outputType === "rows") built = buildFields(sh, inst);
    else {
      let text: string | null = null;
      const extra: string[] = [];
      if (textStep !== undefined) {
        const what = textStep.title.replace(/^Draft the /, "").replace(/ in your words$/, "");
        const d = await draftTextStep({ what, source: [sourceText(sh, inst), facts].filter((x) => x !== "").join("\n"), pack, model: o.model, models: o.models, names, stepKey: `${o.wf.id}/${textStep.id}`, ...(o.user === undefined ? {} : { user: o.user }) });
        text = d.text;
        extra.push(...d.warnings);
      }
      const typed = [...sh.commitSteps].flatMap((s) => inst.bySteps.get(s)?.spans ?? []).map(typedText).find((t) => t !== null)?.text ?? null;
      built = buildActions(sh, inst, text, typed);
      built.warnings.push(...extra);
    }
    // The commit runs with the tool chosen for it (s14 tools): said in the summary, plainly.
    const commitTool = o.wf.tools?.find((t) => v.steps.some((s) => s.type === "commit" && s.id === t.stepId));
    const toolName = commitTool?.options.find((x) => x.id === commitTool.chosen)?.name;
    if (toolName !== undefined) built.ours.summary = `${built.ours.summary} (with ${toolName})`;
    // s16: the commit in the labelled form the chosen tool's gate policy binds; missing labels are said plainly.
    const chosenTool = commitTool === undefined || commitTool.chosen.startsWith("screen:") ? null : commitTool.chosen;
    const spec = commitFor(chosenTool, built.commit?.verb ?? "save", built.ours, inst, (slug) => readSchema(o.home, slug), (slug) => {
      const t = universe?.tools[slug];
      return t === undefined ? {} : { destructive: t.destructive, name: t.name };
    });
    built.commit = spec;
    if (spec.missing.length > 0) built.warnings.push(`Set up once before ${toolName ?? "the tool"} can save this: ${missingWords(spec.missing)}.`);
    const observedMinutes = round1(inst.minutes);
    // s26: an instance the workflow cannot fill at all stays with the person: it saves nothing (honest dry run).
    const nothing = producesNothing(sh.outputType, built.ours);
    if (nothing) built.warnings.push(NOTHING_TO_FILL);
    // s27: the reading time counts only when Offload reads the source itself.
    const counted = fromSource && o.readAutomated === true;
    const savedMinutes = nothing ? 0 : Math.max(0, round1(observedMinutes + (counted ? readMinutes : 0) - o.wf.reviewSecondsPerItem / 60));
    const dto: GeneralDryRunInstanceDTO = {
      instanceId: inst.instance.id,
      day: inst.instance.day,
      start: inst.instance.start,
      ours: built.ours,
      theirs: built.theirs,
      match: built.match,
      steps: { ours: [...predictedSteps(v, inst, ev)].sort(), theirs: [...inst.steps].sort() },
      evidence: { eventIds: inst.eventIds, spanIds: inst.spanIds, frameIds: [...new Set(inst.frameIds)] },
      estimate: { observedMinutes, reviewSeconds: o.wf.reviewSecondsPerItem, savedMinutes, ...(fromSource ? { readMinutes, readCounted: counted } : {}) },
      commit: built.commit,
      warnings: built.warnings,
    };
    out.push(dto);
    // s27: what the read step asks its source for is part of the approved text (the dry run's approval covers it).
    const reads = fromSource && src !== undefined ? `\n\nReads from ${src.targetName}: ${queryText(src)}` : "";
    const body = (built.ours.text ?? built.ours.fields.map((f) => `${f.label}: ${f.value ?? "[left for you]"}`).join("\n")) + reads;
    // makeBatch keys items by `to` (batch.ts); a general item has no recipient, so `to` carries the item key (the
    // instance id). s13's BatchItem.commit carries the real commit once it lands; nothing in a dry run is sent.
    items.push({ key: inst.instance.id.toLowerCase(), to: inst.instance.id.toLowerCase(), subject: built.ours.summary, body, sourceInstanceId: inst.instance.id, warnings: built.warnings });
  }
  const matched = out.reduce((n, i) => n + i.match.matched, 0);
  const total = out.reduce((n, i) => n + i.match.total, 0);
  const agreement = total === 0 ? 0 : Math.round((matched / total) * 1000) / 1000;
  const commitTools = [...new Set(v.steps.filter((s) => s.type === "commit" && s.capability !== null).map((s) => commitToolName(s.capability!.target)))];
  return {
    general: {
      outputType: plan.outputType,
      variant: v.id,
      instances: out,
      totals: { instances: out.length, matched, total, agreement, arithmetic: total === 0 ? `${out.length} instances, nothing on screen to compare with` : `${matched} of ${total} across ${out.length} instances match = ${Math.round(agreement * 100)}%` },
      tone: textStep === undefined ? null : { source: toneSource, examples: pack?.examples.length ?? 0 },
    },
    items,
    commitTools,
    warnings,
  };
}

