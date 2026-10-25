// s14 per-instance evidence for the builder, the probe and the dry run: for every instance of a task, the spans of each
// understanding step, their OCR text (as the observer stored it: sensitive values masked), the frame notes and the
// identifiers.
// Pure: reads only the Analysis.
import type { Analysis } from "../analyze.ts";
import type { Span, Task, TaskInstance, TaskUnderstanding, UnderstandingStep } from "../types.ts";
import type { SpanDescription } from "../understanding/describe.ts";
import type { FrameNote } from "../understanding/frames.ts";

export interface StepSpans {
  stepId: string;
  spans: Span[];
  frames: FrameNote[];
  /** OCR snapshots, oldest first, as stored by the observer (ADR 0003 masking). Never sent to a model as is. */
  ocr: string[];
  identifiers: string[];
}

export interface InstanceEvidence {
  instance: TaskInstance;
  /** Understanding step ids the user took in this instance (from the induction's span -> step map). */
  steps: Set<string>;
  bySteps: Map<string, StepSpans>;
  /** Span ids in time order. */
  spanIds: string[];
  frameIds: string[];
  eventIds: string[];
  minutes: number;
}

export interface TaskEvidence {
  task: Task;
  understanding: TaskUnderstanding;
  instances: InstanceEvidence[];
  stepFrames: Map<string, FrameNote[]>;
  stepIdKinds: Map<string, Set<string>>;
  stepById: Map<string, UnderstandingStep>;
}

/** "order #4521" -> "order #"; "inv-10442" -> "inv-"; ids without a digit have no kind (names, domains), and a kind
 * needs a word ("#4521" alone says nothing about what it numbers). */
export function idKind(id: string): string | null {
  if (!/\d/.test(id)) return null;
  const k = id.replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  return /[a-z]{2}/i.test(k) ? k : null;
}

/**
 * Evidence for one task. Without v2 understanding (a v1 task), one synthetic step covers every span, so the builder
 * still works from app and category alone.
 */
export function taskEvidence(a: Analysis, taskId: string): TaskEvidence | null {
  const task = a.tasks.find((t) => t.id === taskId);
  if (task === undefined) return null;
  const understanding = task.profile.understanding ?? synthUnderstanding(task);
  const stepOf = a.understanding?.stepOf ?? new Map<string, string>();
  const descBySpan = new Map<string, SpanDescription>((a.understanding?.descriptions ?? []).map((d) => [d.spanId, d]));
  const framesById = new Map<string, FrameNote>((a.understanding?.frames ?? []).map((f) => [f.id, f]));
  const known = new Set(understanding.steps.map((s) => s.id));
  const fallback = understanding.steps[0]?.id ?? "st_all";
  const stepFor = (sid: string) => {
    const s = stepOf.get(sid);
    return s !== undefined && known.has(s) ? s : fallback;
  };
  const stepFrames = new Map<string, FrameNote[]>();
  const stepIdKinds = new Map<string, Set<string>>();
  const instances: InstanceEvidence[] = [];
  for (const inst of [...task.instances].sort((x, y) => y.start - x.start || (x.id < y.id ? -1 : 1))) {
    const bySteps = new Map<string, StepSpans>();
    const frameIds: string[] = [];
    for (const sid of inst.spanIds) {
      const span = a.spansById.get(sid);
      if (span === undefined) continue;
      const step = stepFor(sid);
      const d = descBySpan.get(sid);
      const frames = (d?.frameIds ?? []).map((id) => framesById.get(id)).filter((f): f is FrameNote => f !== undefined);
      frameIds.push(...frames.map((f) => f.id));
      const cur = bySteps.get(step) ?? { stepId: step, spans: [], frames: [], ocr: [], identifiers: [] };
      cur.spans.push(span);
      cur.frames.push(...frames);
      // As the observer stored it (sensitive values already masked, ADR 0003): code copies values from it locally.
      // Text that goes to a model is masked again with maskText (plan/text-step.ts), so no number reaches a prompt.
      cur.ocr.push(...span.ocr.map((o) => o.text));
      for (const id of d?.identifiers ?? []) if (!cur.identifiers.includes(id)) cur.identifiers.push(id);
      bySteps.set(step, cur);
      const sf = stepFrames.get(step) ?? [];
      sf.push(...frames);
      stepFrames.set(step, sf);
      const kinds = stepIdKinds.get(step) ?? new Set<string>();
      for (const id of d?.identifiers ?? []) {
        const k = idKind(id);
        if (k !== null) kinds.add(k);
      }
      stepIdKinds.set(step, kinds);
    }
    instances.push({ instance: inst, steps: new Set(bySteps.keys()), bySteps, spanIds: [...inst.spanIds], frameIds, eventIds: [...inst.eventIds], minutes: inst.activeMs / 60_000 });
  }
  return { task, understanding, instances, stepFrames, stepIdKinds, stepById: new Map(understanding.steps.map((s) => [s.id, s])) };
}

/** A one-step task model for a v1 task (app + category), so v1 insights can be built too. */
export function synthUnderstanding(task: Task): TaskUnderstanding {
  const p = task.profile;
  const verb = p.category === "email" ? "write" : p.category === "sheet" ? "update" : "update";
  const object = p.category === "email" ? "email" : p.category === "sheet" ? "row" : "record";
  const activeMs = task.instances.reduce((n, i) => n + i.activeMs, 0);
  const step: UnderstandingStep = {
    id: "st_all",
    name: `${verb} ${object} on ${p.appName}`,
    verb,
    object,
    surface: p.host === "" ? p.appName : p.host,
    surfaceKey: `${p.app}|${p.host}|${p.urlPattern}|${p.template}`,
    app: p.app,
    appName: p.appName,
    host: p.host,
    category: p.category,
    spans: task.spanIds.length,
    activeMs,
    perInstance: 1,
    repeatsPerInstance: 1,
    meanPosition: 0,
    core: true,
  };
  return {
    version: 2,
    goal: `${verb} ${object} (${step.surface})`,
    steps: [step],
    loop: [step.id],
    startStep: step.id,
    startSurface: step.surfaceKey,
    identifiers: { items: 0, examples: [], containers: [] },
    counterparts: [],
    surfaces: [{ app: p.app, appName: p.appName, host: p.host, minutes: activeMs / 60_000 }],
    instanceBoundaries: [],
    evidenceSpanIds: [...task.spanIds],
    frameIds: [],
    reach: { value: 0, perSurface: [] },
    sources: { frames: 0, rules: task.spanIds.length },
  };
}
