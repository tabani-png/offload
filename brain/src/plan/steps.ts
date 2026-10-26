// s14 step typing: an induced task model (s12 TaskUnderstanding) -> typed workflow steps, deterministically.
//   reading verbs         -> read
//   judgement verbs       -> read + decide
//   record writes         -> transform (fields from what was read) [+ draft when a text field is written] + commit
//   text writes           -> [read of the item when nothing was read before] + draft + commit
//   a step not in every instance -> a decide ("when ...") guarding it
// Every commit is gated (ADR 0006). Titles are fixed templates over the masked step words and catalog/app names.
import type { CapabilityNeedDTO, OutputType, PlanStepDTO, PlanVariantDTO } from "../api/s14-types.ts";
import type { TaskUnderstanding, UnderstandingStep } from "../types.ts";
import type { FrameNote } from "../understanding/frames.ts";
import { baseVerb } from "../understanding/verbs.ts";
import { commitCapability, readCapability, targetOf, type StepTarget } from "./capabilities.ts";

export const READ_VERBS = new Set(["read", "view", "browse", "skim", "check", "look up", "find", "open", "search", "watch", "scroll", "look at", "reading", "reviewing", "comparing"]);
export const JUDGE_VERBS = new Set(["review", "screen", "assess", "evaluate", "compare", "triage", "decide", "approve", "score", "grade", "vet"]);
export const RECORD_VERBS = new Set(["enter", "key in", "fill in", "update", "edit", "create", "add", "move", "log", "record", "tag", "file", "upload", "match", "reconcile", "copy", "paste", "type", "entering", "editing", "updating", "book", "schedule", "assign", "close"]);
export const TEXT_VERBS = new Set(["reply", "answer", "respond", "write", "send", "message", "comment", "post", "draft", "compose"]);

export type VerbClass = "read" | "judge" | "record" | "text";

export function verbClass(verb: string): VerbClass {
  // s20: gerunds ("writing", "typing", "filling in") are typed as their base verb, never as reading.
  const v = baseVerb(verb);
  if (TEXT_VERBS.has(v)) return "text";
  if (RECORD_VERBS.has(v)) return "record";
  if (JUDGE_VERBS.has(v)) return "judge";
  return "read";
}

/** s20: typing (or editing, creating) a message, note, reply or post writes text: it gets a draft, like "write". */
const TYPED_TEXT_VERBS = new Set(["type", "edit", "create", "add"]);
const TEXT_OBJECT_RE = /\b(message|messages|note|notes|reply|replies|email|emails|comment|comments|post|posts|draft|memo|answer|response)\b/i;

/** The verb class of a step: its verb's class, except that typing a text object is a text write. */
export function stepClass(s: Pick<UnderstandingStep, "verb" | "object">): VerbClass {
  const c = verbClass(s.verb);
  return c === "record" && TYPED_TEXT_VERBS.has(baseVerb(s.verb)) && TEXT_OBJECT_RE.test(s.object) ? "text" : c;
}

/** The word a text write is named by: its verb when that is a text verb ("reply"), else its object ("message"). */
const textWord = (s: Pick<UnderstandingStep, "verb" | "object">) => (TEXT_VERBS.has(baseVerb(s.verb)) ? s.verb : s.object);

/** Steps seen in fewer instances than this are left out of every variant (noise, one-offs). */
export const MIN_STEP_SHARE = 0.1;

const TEXT_FIELD_RE = /\b(scorecard|note|notes|comment|comments|summary|description|reply|message|feedback|memo|reason)\b/i;
const STAGE_RE = /\b(stage|status|pipeline|move|moved|advance)\b/i;

/** What the frames of one understanding step say it produced (masked words: "draft bill", "stage change"). */
export function stepOutputs(frames: readonly FrameNote[]): string[] {
  const n = new Map<string, number>();
  for (const f of frames) for (const o of f.outputs ?? []) n.set(o.toLowerCase(), (n.get(o.toLowerCase()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([o]) => o);
}

/** What the frames of one step read from the screen ("invoice number", "amount"). */
export function stepInputs(frames: readonly FrameNote[]): string[] {
  const n = new Map<string, number>();
  for (const f of frames) for (const o of f.inputs ?? []) {
    // "job spec: Data Analyst" is an instance value; keep the field name only.
    const k = o.split(":")[0]!.trim().toLowerCase();
    if (k !== "") n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([o]) => o);
}

export interface PlanInput {
  understanding: TaskUnderstanding;
  /** Frame notes per understanding step id (from the spans of that step). */
  stepFrames: ReadonlyMap<string, readonly FrameNote[]>;
  /** Identifier kinds per understanding step id ("order #", "ticket #"): item ids with their digits taken out. */
  stepIdKinds: ReadonlyMap<string, ReadonlySet<string>>;
  /** True when the task lives in mail (category email). */
  mail: boolean;
}

/** The output type of the task (deterministic, from the commit step's verb, object, surface and frame outputs). */
export function outputTypeOf(input: PlanInput): OutputType {
  const steps = usable(input.understanding.steps);
  const writes = steps.filter((s) => stepClass(s) === "text" || stepClass(s) === "record");
  const commit = [...writes].sort((a, b) => Number(b.core) - Number(a.core) || b.activeMs - a.activeMs || (a.id < b.id ? -1 : 1))[0];
  if (commit === undefined) return "record";
  const outs = stepOutputs(input.stepFrames.get(commit.id) ?? []).join(" ");
  const words = `${commit.object} ${commit.surface} ${outs}`.toLowerCase();
  const t = targetOf(commit);
  if (stepClass(commit) === "text") {
    if (t.connectorId === "gmail" || input.mail || commit.category === "email") return "email";
    if (/\b(ticket|case|support|helpdesk)\b/.test(words) || /zendesk|freshdesk|intercom|helpscout|zoho/.test(commit.host)) return "ticket_reply";
    return "message";
  }
  if (STAGE_RE.test(words) || /\b(candidate|application|applicant|deal|opportunity)\b/.test(words)) return "stage_change";
  if (/\b(row|rows|sheet|spreadsheet|lead)\b/.test(words) || commit.category === "sheet" || t.connectorId === "google-sheets") return "rows";
  if (/\b(form|bill|invoice|entry|order|expense|receipt|claim|booking)\b/.test(words) || /^(enter|key in|fill in)$/.test(commit.verb)) return "form_fields";
  return "record";
}

const usable = (steps: readonly UnderstandingStep[]) =>
  [...steps].filter((s) => s.core || s.perInstance >= MIN_STEP_SHARE).sort((a, b) => a.meanPosition - b.meanPosition || Number(b.core) - Number(a.core) || (a.id < b.id ? -1 : 1));

const need = (t: StepTarget, words: string, capability: string, role: CapabilityNeedDTO["role"]): CapabilityNeedDTO => ({ need: words, target: t.target, targetName: t.targetName, capability, role, via: t.via });

function whenText(s: UnderstandingStep, kinds: ReadonlySet<string> | undefined): string {
  // A plain kind ("order #") reads as words; URL path kinds ("shop.com/orders/") do not.
  const k = [...(kinds ?? [])].filter((x) => /^[a-z][a-z ]{1,30}#?$/i.test(x)).sort()[0];
  return k !== undefined ? `when the item names ${k.replace(/\s*#$/, "")} number` : `when the ${s.object} is needed`;
}

/** The faithful skeleton: every usable step, optional ones behind a decide. */
export function skeleton(input: PlanInput, opts: { coreOnly: boolean }): PlanStepDTO[] {
  const out: PlanStepDTO[] = [];
  const counters = new Map<string, number>();
  const id = (type: string) => {
    const n = (counters.get(type) ?? 0) + 1;
    counters.set(type, n);
    return `${type}_${n}`;
  };
  const steps = usable(input.understanding.steps).filter((s) => !opts.coreOnly || s.core);
  // A workflow gathers first, then writes: reads and judgements in their order, then the writes in theirs.
  const isWrite = (s: UnderstandingStep) => stepClass(s) === "text" || stepClass(s) === "record";
  const reads = steps.filter((s) => !isWrite(s));
  const writes = steps.filter(isWrite);
  // A write screen where the item is also read (its frames read before writing: a ticket, the next lead row) is
  // where each item starts: it is read there first. Without any read at all, the first write's item is read.
  const picksItem = (s: UnderstandingStep) => (input.stepFrames.get(s.id) ?? []).some((f) => f.confidence >= 0.5 && f.verb !== undefined && !["text", "record"].includes(verbClass(f.verb)));
  const pickers = writes.filter(picksItem);
  if (pickers.length === 0 && reads.length === 0 && writes[0] !== undefined) pickers.push(writes[0]);
  for (const s of pickers) {
    const t = targetOf(s);
    out.push({ id: id("read"), type: "read", title: `Read the next ${s.object} in ${t.targetName}`, detail: `Open the next ${s.object} and read what it asks for.`, capability: need(t, `read ${s.object} from ${t.targetName}`, readCapability(t), "read"), gated: false, when: s.core ? null : whenText(s, input.stepIdKinds.get(s.id)), writesText: false, sourceSteps: [s.id] });
  }
  let commits = 0;
  for (const s of [...reads, ...writes]) {
    const t = targetOf(s);
    const cls = stepClass(s);
    const frames = input.stepFrames.get(s.id) ?? [];
    const optional = !s.core;
    const when = optional ? whenText(s, input.stepIdKinds.get(s.id)) : null;
    const base = { gated: false, when, writesText: false, sourceSteps: [s.id] };
    if (optional) out.push({ id: id("decide"), type: "decide", title: `Check whether to ${s.verb} the ${s.object}`, detail: `Only ${when}; otherwise this step is skipped.`, capability: null, ...base });
    if (cls === "read" || cls === "judge") {
      out.push({ id: id("read"), type: "read", title: `Read the ${s.object} in ${t.targetName}`, detail: inputsDetail(frames, s), capability: need(t, `read ${s.object} from ${t.targetName}`, readCapability(t), "read"), ...base });
      if (cls === "judge")
        out.push({ id: id("decide"), type: "decide", title: `Decide on the ${s.object}`, detail: `Weigh the ${s.object} the way you do (${s.verb}) and note why; you confirm before anything is saved.`, capability: null, ...base });
      continue;
    }
    const outs = stepOutputs(frames);
    if (cls === "record") {
      const fields = readFields(input, steps, s);
      out.push({ id: id("transform"), type: "transform", title: `Copy what was read into the ${s.object}`, detail: fields === "" ? `Map the values you read onto the ${s.object} fields. Numbers are copied by code, never written by a model.` : `Map ${fields} onto the ${s.object} fields. Numbers are copied by code, never written by a model.`, capability: null, ...base });
      const textOut = outs.find((o) => TEXT_FIELD_RE.test(o));
      if (textOut !== undefined) out.push({ id: id("draft"), type: "draft", title: `Draft the ${textOut} in your words`, detail: `Write the ${textOut} from what was read, in your usual style.`, capability: null, ...base, writesText: true });
    } else {
      const word = textWord(s);
      out.push({ id: id("draft"), type: "draft", title: `Draft the ${word} in your words`, detail: word === s.verb ? `Write the ${s.verb} from the ${s.object} and your past ${s.verb === "reply" ? "replies" : "messages"}, in your tone.` : `Write the ${word} from what was read and your past ones, in your tone.`, capability: null, ...base, writesText: true });
    }
    const role = commits === 0 ? "send" : "log";
    commits += 1;
    const verb = s.verb;
    out.push({
      id: id("commit"),
      type: "commit",
      title: cls === "text" ? (textWord(s) === verb ? `Send the ${verb} to the ${s.object} in ${t.targetName}` : `${s.category === "email" ? "Send" : "Save"} the ${s.object} in ${t.targetName}`) : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} the ${s.object} in ${t.targetName}`,
      detail: `${outs.length > 0 ? `Saves ${outs.join(" and ")}. ` : ""}Waits for your approval of this exact item; nothing is written before.`,
      capability: need(t, cls === "text" ? (textWord(s) === verb ? `send ${verb} to ${s.object} in ${t.targetName}` : `${s.category === "email" ? "send" : "save"} ${s.object} in ${t.targetName}`) : `${verb} ${s.object} in ${t.targetName}`, commitCapability(t, verb), role),
      ...base,
      gated: true,
    });
  }
  return out;
}

function inputsDetail(frames: readonly FrameNote[], s: UnderstandingStep): string {
  const ins = stepInputs(frames);
  return ins.length > 0 ? `Read ${ins.slice(0, 4).join(", ")} from the ${s.object}.` : `Read what the ${s.object} says.`;
}

function readFields(input: PlanInput, steps: readonly UnderstandingStep[], commit: UnderstandingStep): string {
  const reads = steps.filter((s) => s.meanPosition <= commit.meanPosition && s.id !== commit.id && stepClass(s) !== "record");
  const ins = [...new Set(reads.flatMap((s) => stepInputs(input.stepFrames.get(s.id) ?? [])))];
  return ins.slice(0, 4).join(", ");
}

/** A decide step that was never observed: check the result against the source before saving. */
function checkStep(): PlanStepDTO {
  return { id: "decide_check", type: "decide", title: "Check the result against the source before saving", detail: "Compare every field with what was read and stop on any difference.", capability: null, gated: false, when: null, writesText: false, sourceSteps: [] };
}

const signature = (steps: readonly PlanStepDTO[]) => steps.map((s) => `${s.type}:${s.sourceSteps.join(",")}`).join("|");

/**
 * Harness^2 "propose": two variants. A = every step you take (optional steps behind a decide); B = the core loop.
 * When the task has no optional step the two would be equal, so B adds a check step before the first commit instead.
 */
export function proposeVariants(input: PlanInput): [PlanVariantDTO, PlanVariantDTO] {
  const a = skeleton(input, { coreOnly: false });
  let b = skeleton(input, { coreOnly: true });
  let bLabel = "Core loop only";
  let bSummary = "Only the steps you take every time; the occasional ones are left to you.";
  if (signature(a) === signature(b)) {
    const at = b.findIndex((s) => s.type === "commit");
    b = [...b.slice(0, Math.max(0, at)), checkStep(), ...b.slice(Math.max(0, at))];
    bLabel = "With a check before saving";
    bSummary = "Your steps plus one extra check of every field before anything is saved.";
  }
  const optional = a.filter((s) => s.when !== null).length;
  return [
    { id: "a", label: "Every step you take", summary: optional > 0 ? "Your steps in your order, including the ones you only take sometimes, each behind a check." : "Your steps in your order.", steps: a },
    { id: "b", label: bLabel, summary: bSummary, steps: b },
  ];
}
