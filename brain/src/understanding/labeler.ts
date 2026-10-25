// s12 default Labeler and Judge for induced tasks. Rules only, built from the task model; tasks that live entirely in
// mail keep v1's email labels and judgement (they were tuned on the outreach demo). User context is accepted and
// ignored here: it is for model prompts (context.ts).
import { defaultLabeler, type LabelContext, type Labeler } from "../grouping/group.ts";
import { heuristicJudge, type Judge, type JudgeInput, type JudgeResult } from "../insights/judge.ts";
import { connectorById } from "../connectors/catalog.ts";
import type { TaskLabel, TaskProfile, UnderstandingStep } from "../types.ts";
import { surfaceReach } from "./reach.ts";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "work";

const cap = (s: string) => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

const WRITE_VERBS = new Set(["enter", "key in", "copy", "paste", "fill in", "update", "edit", "log", "record", "tag", "file", "upload", "write", "type", "reply", "answer", "send", "respond", "match", "reconcile", "move", "create", "add"]);
const TRANSFER_VERBS = new Set(["enter", "key in", "copy", "paste", "fill in", "update", "edit", "log", "record", "tag", "file", "upload", "match", "reconcile", "move", "create", "add", "look up", "find", "check", "type"]);
const TEMPLATED_REPLY_VERBS = new Set(["reply", "answer", "respond", "send", "triage"]);
const REVIEW_VERBS = new Set(["review", "screen", "assess", "evaluate", "approve", "decide", "compare"]);
const LIVE_VERBS = new Set(["attend", "meet", "call", "present"]);
const READ_VERBS = new Set(["read", "skim", "browse", "view", "watch", "chat", "scroll"]);

export const isWriteVerb = (v: string) => WRITE_VERBS.has(v);

function mailOnly(p: TaskProfile): boolean {
  const u = p.understanding;
  return u !== undefined && u.steps.length > 0 && u.steps.every((s) => s.category === "email");
}

/** The step that changes something: the core write step with the most time, else the core step with the most time. */
export function actionStep(steps: readonly UnderstandingStep[]): UnderstandingStep | undefined {
  const pool = steps.filter((s) => s.core).length > 0 ? steps.filter((s) => s.core) : [...steps];
  const byTime = [...pool].sort((a, b) => b.activeMs - a.activeMs || (a.id < b.id ? -1 : 1));
  return byTime.find((s) => isWriteVerb(s.verb)) ?? byTime[0];
}

function appLabel(s: UnderstandingStep): string {
  // A catalog connector knows the product's name (mail.google.com is "Gmail", not "Google").
  const known = surfaceReach({ app: s.app, host: s.host, urlPattern: s.surfaceKey.split("|")[2] ?? "", activeMs: 0 });
  if (known.connectorId !== null) return connectorById(known.connectorId)?.name ?? s.appName;
  if (s.host === "") return s.appName;
  const parts = s.host.replace(/^www\./, "").split(".");
  const base = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
  return cap(base);
}

export const understandingLabeler = {
  label(p: TaskProfile, context?: LabelContext): TaskLabel {
    const u = p.understanding;
    if (u === undefined || mailOnly(p)) return defaultLabeler.label(p);
    void context;
    const act = actionStep(u.steps);
    if (act === undefined) return defaultLabeler.label(p);
    const loop = u.loop.map((id) => u.steps.find((s) => s.id === id)).filter((s): s is UnderstandingStep => s !== undefined);
    const apps = [...new Set(loop.map(appLabel))];
    const first = loop[0];
    const name =
      loop.length >= 2 && first !== undefined && first.id !== act.id
        ? `${cap(first.verb)} ${first.object} → ${act.verb} ${act.object}`
        : `${cap(act.verb)} ${act.object} in ${appLabel(act)}`;
    return {
      kind: `task.${slug(act.verb)}-${slug(act.object)}`,
      name,
      description: `${p.instanceCount} times: ${u.goal}${apps.length > 1 ? ` (${apps.join(" → ")})` : ""}`,
    };
  },
} satisfies Labeler;

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

function verbJudgement(verb: string, sameness: number): number {
  if (LIVE_VERBS.has(verb)) return 0.9;
  if (REVIEW_VERBS.has(verb)) return 0.45;
  if (TEMPLATED_REPLY_VERBS.has(verb)) return 0.35;
  if (TRANSFER_VERBS.has(verb)) return 0.2;
  if (READ_VERBS.has(verb)) return 0.6;
  if (verb === "write") return clamp(1 - sameness, 0.1, 0.9);
  return 0.5;
}

/**
 * Judgement = active-time-weighted mean over the steps of a per-verb judgement (live 0.9, review 0.45, templated
 * replies 0.35, data transfer 0.2, reading 0.6). A task with no write step is reading: at least 0.6.
 * Risk: replies or sends to someone outside = 0.5; writes to records = 0.2; read only = 0.
 */
export const understandingJudge = {
  judge(input: JudgeInput): JudgeResult {
    const p = input.profile;
    const u = p.understanding;
    // Mail-only tasks keep v1's tuned email judgement; without any frame note the verbs are rule guesses, so v1's
    // category judgement is the honest answer too.
    if (u === undefined || mailOnly(p) || u.sources.frames === 0) return heuristicJudge.judge(input);
    const total = u.steps.reduce((n, s) => n + s.activeMs, 0);
    if (total === 0) return heuristicJudge.judge(input);
    let j = u.steps.reduce((n, s) => n + verbJudgement(s.verb, input.sameness) * s.activeMs, 0) / total;
    const writes = u.steps.filter((s) => isWriteVerb(s.verb));
    const reasons: string[] = [];
    if (writes.length === 0) {
      j = Math.max(j, 0.6);
      reasons.push("reading only: nothing is changed");
    }
    const live = u.steps.filter((s) => LIVE_VERBS.has(s.verb)).reduce((n, s) => n + s.activeMs, 0);
    if (live / total >= 0.5) {
      j = Math.max(j, 0.9);
      reasons.push("live conversation");
    }
    const external = writes.some((s) => TEMPLATED_REPLY_VERBS.has(s.verb) || s.verb === "write") && u.counterparts.length > 0;
    const risk = writes.length === 0 ? 0 : external ? 0.5 : 0.2;
    if (writes.length > 0) reasons.push(external ? `replies to ${u.counterparts[0]}` : `writes to records in ${[...new Set(writes.map((s) => s.surface))].join(", ")}`);
    const review = u.steps.filter((s) => REVIEW_VERBS.has(s.verb));
    if (review.length > 0) reasons.push(`a person still decides when they ${review[0]!.verb} the ${review[0]!.object}`);
    return { judgement: round2(clamp(j)), risk, reasons };
  },
} satisfies Judge;
