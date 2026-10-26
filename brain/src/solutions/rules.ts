// s22 rules: the five solution kinds for one task, with every number computed here (ADR 0005). A model may later
// reword `what`, `why` and the brief text (design.ts); it never sees or changes a figure, the order or the evidence.
//   observed  = activeMinutes / 60 x 7 / window days                       (h/wk the person actually spent)
//   saving    = min(observed, observed x share x factor)                   (tool, setup)
//   remove    = min(observed, observed x share x removed), removed = the s04 review model's low case on the
//               measured minutes per item of the removed parts (insights/saving.ts: each item still approved)
//   workflow  = min(observed, s04 saving estimate) x share                 (the review model of insights/saving.ts)
//   confidence = fit x (0.6 + 0.4 x evidence), evidence = min(1, sqrt(instances / 8))
//   rank       = saving x confidence, ties -> fewer setup hours -> kind order; leave_alone first when nothing clears
//                LEAVE_ALONE_FLOOR or the task is one-off reading.
import { estimateSaving } from "../insights/saving.ts";
import type { Task } from "../types.ts";
import { partsOf } from "./signals.ts";
import { SOLUTION_KINDS, type BriefSpec, type ConfidenceLevel, type Effort, type PartTag, type SolutionKind, type SolutionOption, type SolutionSet, type SolutionSubject, type TaskPart } from "./types.ts";

/** The most of a part's measured time a flat assumption may claim. These shares are not measured (screen time does not
 * show how many approvals are routine or how many commands a script would cover), so none claims the larger half of
 * the time it addresses; the arithmetic prints the share, and measured runs replace it after the first week. */
export const MAX_FLAT_FACTOR = 0.5;
/** Share of the addressed time each kind removes, per part tag (the largest applicable tag of a part counts).
 *  Assumptions, each at most MAX_FLAT_FACTOR: what a fix leaves behind is the person's review of its output.
 *  tool: a script runs the commands / moves the data / fills the records, you check the result (0.5); a supervisor
 *    still needs you to read its summary (0.35); a prompt kit still needs the task-specific part typed (0.3); a digest
 *    still gets read (0.4).
 *  setup: an allowlist removes the routine approvals, the risky ones still ask (0.5); rules and a notification hook
 *    cut the watching, not the review (0.5); standing rules cut the repeated part of prompts (0.4); aliases, snippets
 *    and templates cut keystrokes, not the thinking (0.3, 0.2, 0.15). */
export const SOLUTION_FACTORS: Readonly<Record<"tool" | "setup", Partial<Record<PartTag, number>>>> = {
  tool: { code_manual: 0.5, copy_between: 0.5, data_entry: 0.5, agent_watch: 0.35, agent_prompt: 0.3, reading: 0.4 },
  setup: { approval_prompt: 0.5, agent_watch: 0.5, agent_prompt: 0.4, code_manual: 0.3, messaging: 0.2, data_entry: 0.15 },
};
/** Parts a pipeline can remove. Its share comes from the s04 review model on the measured time, not from a constant. */
const REMOVE_STEP_TAGS: Partial<Record<PartTag, number>> = { media_make: 1 };
/** How well each kind fits a part with this tag (0..1). */
const FIT: Readonly<Record<Exclude<SolutionKind, "workflow" | "leave_alone">, Partial<Record<PartTag, number>>>> = {
  tool: { code_manual: 0.75, copy_between: 0.75, data_entry: 0.55, agent_watch: 0.6, agent_prompt: 0.5, reading: 0.45 },
  setup: { approval_prompt: 0.85, agent_watch: 0.75, agent_prompt: 0.7, code_manual: 0.55, messaging: 0.4, data_entry: 0.35 },
  remove_step: { media_make: 0.8 },
};
/** Parts a workflow (read / transform / decide / draft / commit) can carry. */
const WORKFLOW_TAGS: readonly PartTag[] = ["messaging", "data_entry", "publish", "copy_between"];
/** Reading a digest tool can take over only when the reading is the same every time. */
const DIGEST_MIN_SAMENESS = 0.6;
export const EFFORT: Readonly<Record<SolutionKind, { level: Effort; setupHours: number }>> = {
  workflow: { level: "low", setupHours: 0.5 },
  tool: { level: "medium", setupHours: 4 },
  setup: { level: "low", setupHours: 1 },
  remove_step: { level: "medium", setupHours: 6 },
  leave_alone: { level: "none", setupHours: 0 },
};
/** h/wk x confidence an option must clear for leave_alone not to come first. */
export const LEAVE_ALONE_FLOOR = 0.5;

const round2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const h1 = (x: number) => `${x.toFixed(1)} h/wk`;
export const confidenceLevel = (v: number): ConfidenceLevel => (v >= 0.7 ? "high" : v >= 0.45 ? "medium" : "low");

export interface RulesInput {
  subject: SolutionSubject;
  task: Pick<Task, "spanIds" | "instances">;
  /** Days in the analysis window (normally 7). */
  windowDays: number;
  /** v2: span -> understanding step id. */
  stepOf?: ReadonlyMap<string, string>;
}

export function observedWeekly(subject: SolutionSubject, windowDays: number): { hours: number; arithmetic: string } {
  const days = Math.max(1, windowDays);
  const minutes = subject.stats.activeMinutes.value;
  const hours = round2(((minutes / 60) * 7) / days);
  return { hours, arithmetic: `${minutes.toFixed(1)} min over ${days} days × 7 / ${days} = ${hours.toFixed(2)} h/wk observed` };
}

interface Addressed {
  share: number;
  fit: number;
  factor: number;
  parts: TaskPart[];
  dominant: PartTag | null;
}

/** The parts a kind addresses, their share of the time, the time-weighted factor and fit, and the dominant tag. */
function addressed(parts: readonly TaskPart[], factors: Partial<Record<PartTag, number>>, fits: Partial<Record<PartTag, number>>, allow: (t: PartTag) => boolean = () => true): Addressed {
  const total = parts.reduce((n, p) => n + p.activeMs, 0);
  const hit: TaskPart[] = [];
  let shareFactor = 0;
  let fitSum = 0;
  let ms = 0;
  const byTag = new Map<PartTag, number>();
  for (const p of parts) {
    const tags = p.tags.filter((t) => factors[t] !== undefined && allow(t));
    if (tags.length === 0) continue;
    const best = tags.reduce((a, b) => ((factors[b] ?? 0) > (factors[a] ?? 0) ? b : a));
    hit.push(p);
    ms += p.activeMs;
    shareFactor += p.activeMs * (factors[best] ?? 0);
    fitSum += p.activeMs * (fits[best] ?? 0);
    byTag.set(best, (byTag.get(best) ?? 0) + p.activeMs);
  }
  if (total <= 0 || ms <= 0) return { share: 0, fit: 0, factor: 0, parts: hit, dominant: null };
  const dominant = [...byTag.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  return { share: ms / total, fit: fitSum / ms, factor: shareFactor / ms, parts: hit, dominant };
}

function evidenceOf(parts: readonly TaskPart[], task: RulesInput["task"]): SolutionOption["evidence"] {
  const spanIds = [...new Set(parts.flatMap((p) => p.spanIds))].sort();
  const set = new Set(spanIds);
  const instanceIds = task.instances.filter((i) => i.spanIds.some((s) => set.has(s))).map((i) => i.id);
  return { spanIds, instanceIds, parts: parts.map((p) => p.id) };
}

function confidence(fit: number, subject: SolutionSubject, reasons: string[]): SolutionOption["confidence"] {
  const instances = subject.stats.instances.value;
  const evidence = Math.min(1, Math.sqrt(instances / 8));
  const value = round2(clamp(fit * (0.6 + 0.4 * evidence)));
  return { value, level: confidenceLevel(value), reasons: [...reasons, `seen ${instances} times`] };
}

function effortOf(kind: SolutionKind, saved: number, setupHours = EFFORT[kind].setupHours, level = EFFORT[kind].level): SolutionOption["effort"] {
  return { level, setupHours, paybackWeeks: saved > 0 ? round2(setupHours / saved) : null };
}

const partList = (ps: readonly TaskPart[]) => ps.map((p) => p.name).join(", ");

// ---------- the rules wording (text only; design.ts may reword it) ----------

const TOOL_TEXT: Partial<Record<PartTag, { what: string; why: string; spec: Omit<BriefSpec, "builderPrompt"> }>> = {
  agent_watch: {
    what: "Build an agent supervisor that runs your coding agent's checks and pings you when a run finishes or needs you, so you stop watching the terminal",
    why: "Most of the time goes to watching an agent work; a supervisor can watch for you.",
    spec: { inputs: ["the coding agent's session output", "the project's test and lint commands"], outputs: ["a desktop notification when the run finishes, fails or asks a question", "a short summary of what changed and whether the checks passed"], runsWhere: "on this Mac, next to the coding agent (a local script or agent hook)", acceptance: ["a finished run raises one notification with the result", "a run that asks for input raises a notification at once", "the summary lists the files changed and the check results", "nothing is sent off this Mac"] },
  },
  code_manual: {
    what: "Script the commands you repeat (tests, builds, git steps) into one command or hook",
    why: "The same commands are typed again and again.",
    spec: { inputs: ["the repository", "the commands you run by hand"], outputs: ["one script or hook that runs them in order and reports the result"], runsWhere: "in the repository, on this Mac", acceptance: ["one command runs the whole sequence", "a failing step stops the sequence and says which one", "the script is checked in with a short README"] },
  },
  copy_between: {
    what: "A small script that moves the data between the two apps for you instead of copying it by hand",
    why: "Time goes to copying the same kind of data from one place to another.",
    spec: { inputs: ["the source app's export or API"], outputs: ["the same data in the target app, ready for your review"], runsWhere: "on this Mac, or as a scheduled job", acceptance: ["every copied value matches its source", "nothing is saved in the target before you approve the batch"] },
  },
  data_entry: {
    what: "An import script that fills the records from their source, for you to review",
    why: "Records are typed in by hand from a source that a script can read.",
    spec: { inputs: ["the source documents or rows"], outputs: ["filled records, held for your approval"], runsWhere: "on this Mac", acceptance: ["values are copied by code, never invented", "nothing is saved before you approve"] },
  },
  agent_prompt: {
    what: "A prompt kit for your coding agent: saved task prompts with the project context filled in",
    why: "The same context and instructions are typed into the agent again and again.",
    spec: { inputs: ["the prompts you type most", "the project's context files"], outputs: ["a command that fills a saved prompt and starts the agent with it"], runsWhere: "on this Mac, in the terminal or the IDE", acceptance: ["a saved prompt starts the agent with the project context", "prompts live in the repository and are easy to edit"] },
  },
  reading: {
    what: "A daily digest that gathers what you check into one short summary",
    why: "The same places are checked again and again for what changed.",
    spec: { inputs: ["the pages or feeds you check"], outputs: ["one summary of what is new since last time"], runsWhere: "on this Mac, on a schedule", acceptance: ["the digest lists only what changed", "each item links back to its source"] },
  },
};

const SETUP_TEXT: Partial<Record<PartTag, { what: string; why: string; spec: Omit<BriefSpec, "builderPrompt"> }>> = {
  approval_prompt: {
    what: "Tune your coding agent's setup: a permission allowlist for safe commands, project rules and a notification hook, so it stops waiting on you",
    why: "Time goes to approving the agent's routine requests and watching for the next one.",
    spec: { inputs: ["the agent's settings and project rules file", "the commands you approve every time"], outputs: ["an allowlist of safe commands", "project rules the agent reads at start", "a hook that notifies you when the agent needs you"], runsWhere: "in the agent's settings and the repository on this Mac", acceptance: ["routine safe commands run without a prompt", "risky commands still ask", "a notification fires when the agent waits for you"] },
  },
  agent_watch: {
    what: "Tune your coding agent's setup: project rules, a permission allowlist and a notification hook, so you can leave it running and come back when it needs you",
    why: "Most of the time goes to watching an agent work and waiting for it.",
    spec: { inputs: ["the agent's settings and project rules file", "how you run tests and checks"], outputs: ["project rules that tell the agent how to verify its work", "an allowlist for safe commands", "a hook that notifies you when the run ends or needs you"], runsWhere: "in the agent's settings and the repository on this Mac", acceptance: ["the agent runs the project's checks before it stops", "a notification fires when the run ends or asks a question", "risky commands still ask"] },
  },
  agent_prompt: {
    what: "Give your coding agent standing project rules and slash commands, so you stop retyping the same instructions",
    why: "The same instructions are typed into the agent again and again.",
    spec: { inputs: ["the instructions you repeat"], outputs: ["a project rules file", "slash commands for the common tasks"], runsWhere: "in the repository on this Mac", acceptance: ["a new session follows the rules without being told", "each common task is one slash command"] },
  },
  code_manual: {
    what: "Add shortcuts and aliases for the commands and edits you repeat",
    why: "The same commands are typed again and again.",
    spec: { inputs: ["the commands you repeat"], outputs: ["shell aliases or IDE tasks bound to keys"], runsWhere: "in your shell and IDE settings", acceptance: ["each repeated command is one alias or key"] },
  },
  messaging: {
    what: "Set up text templates and snippets for the messages you retype",
    why: "The same wording is typed again and again.",
    spec: { inputs: ["your most repeated messages"], outputs: ["snippets you expand with a short keyword"], runsWhere: "in your mail or chat app, or a text expander", acceptance: ["each repeated message is one snippet", "snippets keep your own wording"] },
  },
  data_entry: {
    what: "Set up templates, saved views and defaults for the records you fill in",
    why: "The same fields are filled with the same values again and again.",
    spec: { inputs: ["the fields you fill every time"], outputs: ["a template or saved view with the defaults set"], runsWhere: "in the app's settings", acceptance: ["a new record starts with the usual values filled"] },
  },
};

function builderPrompt(name: string, what: string, spec: Omit<BriefSpec, "builderPrompt">, parts: readonly TaskPart[]): string {
  return [
    `Build this for me: ${what}.`,
    `Why: my repeated task "${name}" takes time in these parts: ${partList(parts) || "the whole task"}.`,
    `Inputs: ${spec.inputs.join("; ")}.`,
    `Outputs: ${spec.outputs.join("; ")}.`,
    `Where it runs: ${spec.runsWhere}.`,
    "Done when:",
    ...spec.acceptance.map((a) => `- ${a}`),
    "Rules: nothing is sent, posted or saved to an outside account without my approval of the exact item; no secrets in the code; keep it small.",
  ].join("\n");
}

function notFit(kind: SolutionKind, what: string, why: string): SolutionOption {
  return { kind, what, why, weeklyHoursSaved: 0, share: 0, arithmetic: "not a fit: 0.0 h/wk", effort: effortOf(kind, 0), confidence: { value: 0, level: "low", reasons: [why] }, evidence: { spanIds: [], instanceIds: [], parts: [] }, handoff: { to: "none" } };
}

function capped(observed: number, raw: number): number {
  return round2(Math.min(observed, Math.max(0, raw)));
}

function workflowOption(i: RulesInput, parts: readonly TaskPart[], observed: number): SolutionOption {
  const s = i.subject;
  if (s.heldBack !== undefined) return notFit("workflow", "Not a workflow: a person is at the keyboard for this work", s.heldBack.reason);
  const hit = parts.filter((p) => p.tags.some((t) => WORKFLOW_TAGS.includes(t)));
  const total = parts.reduce((n, p) => n + p.activeMs, 0);
  const share = total <= 0 ? 0 : hit.reduce((n, p) => n + p.activeMs, 0) / total;
  const reach = s.score.factors.reachability;
  if (share === 0 || reach <= 0) return notFit("workflow", "Not a workflow: nothing here is sent, saved or posted", "a workflow drafts and commits items; this task has no step that writes anything");
  const base = Math.min(observed, s.saving.weeklyHoursSaved);
  const saved = capped(observed, base * share);
  const via = s.connectors.primary?.name ?? "the app on screen";
  const fit = clamp(0.35 + 0.65 * s.stats.sameness.value) * (1 - s.judge.judgement * 0.5) * (reach >= 0.5 ? 1 : 0.7);
  const tags = new Set(hit.flatMap((p) => p.tags));
  const verb = tags.has("messaging") ? "sends" : tags.has("publish") ? "posts" : "saves";
  const reasons = [`sameness ${s.stats.sameness.value.toFixed(2)}`, `reach ${reach.toFixed(2)} through ${via}`, `judgement ${s.judge.judgement.toFixed(2)}`];
  const eff = reach >= 0.8 ? EFFORT.workflow : { level: "medium" as const, setupHours: 2 };
  return {
    kind: "workflow",
    what: `Automate it as a workflow: Offload drafts each one, you approve it, and it ${verb} through ${via}`,
    why: "The steps repeat and the result goes through an app Offload can reach.",
    weeklyHoursSaved: saved,
    share: round2(share),
    arithmetic: `min(observed ${h1(observed)}, estimate ${h1(s.saving.weeklyHoursSaved)}) × ${pct(share)} of the time = ${h1(saved)}`,
    effort: effortOf("workflow", saved, eff.setupHours, eff.level),
    confidence: confidence(fit, s, reasons),
    evidence: evidenceOf(hit, i.task),
    handoff: { to: "workflow_drafter", insightId: s.id },
  };
}

function briefOption(kind: "tool" | "setup" | "remove_step", i: RulesInput, parts: readonly TaskPart[], observed: number): SolutionOption {
  const s = i.subject;
  const sameness = s.stats.sameness.value;
  const allow = kind === "tool" ? (t: PartTag) => t !== "reading" || sameness >= DIGEST_MIN_SAMENESS : () => true;
  const a = addressed(parts, kind === "remove_step" ? REMOVE_STEP_TAGS : SOLUTION_FACTORS[kind], FIT[kind], allow);
  if (a.dominant === null) {
    const label = kind === "tool" ? "Not a tool job: no part of it is mechanical enough to script" : kind === "setup" ? "No setup change stands out for this task" : "No step here can be removed by a pipeline";
    return notFit(kind, label, "none of its parts match what this kind of fix removes");
  }
  // remove_step: the pipeline makes each item and the person still approves it. The removed share is the s04 review
  // model's low case on the measured minutes per item of the removed parts: long making steps lose most of their
  // time, quick ones much less (an approval costs nearly as much as the step).
  let factor = a.factor;
  let factorNote = `${pct(a.factor)} removed`;
  if (kind === "remove_step") {
    const items = s.stats.instances.value;
    const perItem = items > 0 ? a.parts.reduce((n, p) => n + p.activeMs, 0) / 60_000 / items : 0;
    if (perItem <= 0) return notFit(kind, "No step here can be removed by a pipeline", "no measured time per item for the making step");
    const est = estimateSaving({ instances: items, daysActive: Math.max(1, s.stats.daysActive.value), windowDays: Math.max(1, i.windowDays), medianMinutes: perItem, eventIds: [] });
    factor = est.range.low.pct;
    factorNote = `${pct(factor)} removed (s04 review model on ${est.medianMinutes.toFixed(1)} min per item; ${est.assumptions[1]!.replace(/\.$/, "")})`;
  }
  const saved = capped(observed, observed * a.share * factor);
  let text: { what: string; why: string; spec: Omit<BriefSpec, "builderPrompt"> };
  if (kind === "remove_step") {
    const publishing = parts.some((p) => p.tags.includes("publish"));
    text = {
      what: publishing ? "Generate the post images automatically from the post text, so the design step disappears and you only approve each image" : `Replace "${partList(a.parts)}" with a pipeline that makes the images for you, for your approval`,
      why: "A manual making step sits inside the task; a pipeline can produce it from what you already wrote.",
      spec: {
        inputs: publishing ? ["the post text", "your brand style (colours, fonts, logo)"] : ["the text or data the images are made from", "your brand style"],
        outputs: ["an image per item in the sizes the destination needs, held for your approval"],
        runsWhere: "an image model reached through MCP or its API, started from this Mac",
        acceptance: ["each image follows the brand style", "every image waits for your approval before it is used", "a rejected image can be regenerated with one note", "nothing is posted by the pipeline"],
      },
    };
  } else {
    const table = kind === "tool" ? TOOL_TEXT : SETUP_TEXT;
    text = table[a.dominant] ?? { what: `Change how "${partList(a.parts)}" is done`, why: "Part of the task repeats the same way.", spec: { inputs: [], outputs: [], runsWhere: "on this Mac", acceptance: [] } };
  }
  const fitAdj = kind === "remove_step" && parts.length === 1 ? a.fit * 0.8 : a.fit;
  const spec: BriefSpec = { ...text.spec, builderPrompt: builderPrompt(s.label.name, text.what, text.spec, a.parts) };
  return {
    kind,
    what: text.what,
    why: text.why,
    weeklyHoursSaved: saved,
    share: round2(a.share),
    arithmetic: `observed ${h1(observed)} × ${pct(a.share)} of the time (${partList(a.parts)}) × ${factorNote} = ${h1(saved)}`,
    effort: effortOf(kind, saved),
    confidence: confidence(fitAdj, s, [`addresses ${pct(a.share)} of the time`]),
    evidence: evidenceOf(a.parts, i.task),
    handoff: { to: "brief", spec },
  };
}

const valueOf = (o: SolutionOption) => o.weeklyHoursSaved * o.confidence.value;

/** All five kinds for one task, ranked. Pure: same input, same output. */
export function rulesSolutions(i: RulesInput): SolutionSet {
  const s = i.subject;
  const parts = partsOf(s, i.task, i.stepOf);
  const obs = observedWeekly(s, i.windowDays);
  const others = [workflowOption(i, parts, obs.hours), briefOption("tool", i, parts, obs.hours), briefOption("setup", i, parts, obs.hours), briefOption("remove_step", i, parts, obs.hours)];
  const best = Math.max(0, ...others.map(valueOf));
  const allTags = new Set(parts.flatMap((p) => p.tags));
  const readingOnly = allTags.size > 0 && [...allTags].every((t) => t === "reading");
  const oneOff = readingOnly && s.stats.sameness.value < DIGEST_MIN_SAMENESS;
  const leaveFirst = oneOff || best < LEAVE_ALONE_FLOOR;
  const why = s.heldBack !== undefined && best < LEAVE_ALONE_FLOOR
    ? `a person is at the keyboard for it (${s.heldBack.reason}) and no change saves enough to be worth it`
    : oneOff
      ? "every visit is different reading, and the reading is the work"
      : best < LEAVE_ALONE_FLOOR
        ? "no fix saves enough time to be worth building"
        : "it repeats often enough that one of the fixes above is worth it";
  const leaveConf = leaveFirst ? round2(clamp(oneOff ? 0.6 + 0.4 * (1 - s.stats.sameness.value) : 0.6)) : round2(clamp(0.3 * (1 - s.stats.sameness.value)));
  const leave: SolutionOption = {
    kind: "leave_alone",
    what: leaveFirst ? `Leave it: ${why}` : "Leave it as it is",
    why,
    weeklyHoursSaved: 0,
    share: 0,
    arithmetic: "nothing changes: 0.0 h/wk",
    effort: effortOf("leave_alone", 0),
    confidence: { value: leaveConf, level: confidenceLevel(leaveConf), reasons: [why] },
    evidence: { spanIds: [], instanceIds: [], parts: [] },
    handoff: { to: "none" },
  };
  const order = (k: SolutionKind) => SOLUTION_KINDS.indexOf(k);
  others.sort((a, b) => valueOf(b) - valueOf(a) || a.effort.setupHours - b.effort.setupHours || order(a.kind) - order(b.kind));
  const options = leaveFirst ? [leave, ...others] : [...others, leave];
  return { version: 1, subjectId: s.id, taskId: s.taskId, name: s.label.name, heldBack: s.heldBack !== undefined, observedWeeklyHours: obs.hours, observedArithmetic: obs.arithmetic, parts, options, top: options[0]!.kind, designedBy: "rules" };
}
