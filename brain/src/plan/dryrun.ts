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
}

export interface GeneralDryRun {
  general: GeneralDryRunDTO;
  items: BatchItem[];
  /** The tool names the gate is asked about for every commit step (all denied in a dry run). */
  commitTools: string[];
  warnings: string[];
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
  for (const inst of ev.instances.slice(0, o.limit)) {
    let built;
    if (sh.outputType === "form_fields" || sh.outputType === "rows") built = buildFields(sh, inst);
    else {
      let text: string | null = null;
      const extra: string[] = [];
      if (textStep !== undefined) {
        const what = textStep.title.replace(/^Draft the /, "").replace(/ in your words$/, "");
        const d = await draftTextStep({ what, source: [sourceText(sh, inst), facts].filter((x) => x !== "").join("\n"), pack, model: o.model, models: o.models, stepKey: `${o.wf.id}/${textStep.id}`, ...(o.user === undefined ? {} : { user: o.user }) });
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
    const observedMinutes = round1(inst.minutes);
    const savedMinutes = Math.max(0, round1(observedMinutes - o.wf.reviewSecondsPerItem / 60));
    const dto: GeneralDryRunInstanceDTO = {
      instanceId: inst.instance.id,
      day: inst.instance.day,
      start: inst.instance.start,
      ours: built.ours,
      theirs: built.theirs,
      match: built.match,
      steps: { ours: [...predictedSteps(v, inst, ev)].sort(), theirs: [...inst.steps].sort() },
      evidence: { eventIds: inst.eventIds, spanIds: inst.spanIds, frameIds: [...new Set(inst.frameIds)] },
      estimate: { observedMinutes, reviewSeconds: o.wf.reviewSecondsPerItem, savedMinutes },
      commit: built.commit,
      warnings: built.warnings,
    };
    out.push(dto);
    const body = built.ours.text ?? built.ours.fields.map((f) => `${f.label}: ${f.value ?? "[left for you]"}`).join("\n");
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
