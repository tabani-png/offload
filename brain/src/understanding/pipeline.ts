// s12 understanding v2 pipeline: spans + frame notes -> span descriptions -> local embeddings -> induced tasks ->
// v1-shaped Tasks (TaskProfile + instances), so stats, ranking, saving, the API and evidence work unchanged.
import { createHash } from "node:crypto";
import { detectOwnEmails, looksLikeScheduling, type Labeler } from "../grouping/group.ts";
import { domainOf, extractEmails, ocrTokens } from "../grouping/normalize.ts";
import type { Identifiers, Span, Task, TaskInstance, TaskProfile, TaskUnderstanding, UnderstandingStep, UserContext } from "../types.ts";
import { describeSpans, refineDescriptions, type DescriptionRefiner, type SpanDescription } from "./describe.ts";
import type { Embedder } from "./embed.ts";
import { attachFrames, type FrameNote } from "./frames.ts";
import { induceTasks, topOf, type InducedTask, type InduceOptions, type Induction } from "./induce.ts";
import { isWriteVerb, understandingLabeler } from "./labeler.ts";
import { estimateReach } from "./reach.ts";

export interface UnderstandOptions {
  frames: readonly FrameNote[];
  embedder: Embedder;
  ownEmails?: readonly string[];
  labeler?: Labeler;
  user?: UserContext;
  refiner?: DescriptionRefiner;
  induce?: Partial<InduceOptions>;
}

export interface Understanding {
  tasks: Task[];
  descriptions: SpanDescription[];
  induction: Induction;
  embedder: string;
  framesUsed: number;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);

function emailIdentifiers(spans: readonly Span[], own: ReadonlySet<string>): Identifiers {
  const emails = new Set<string>();
  for (const s of spans) {
    for (const e of extractEmails(s.title)) emails.add(e);
    for (const o of s.ocr) for (const e of extractEmails(o.text)) emails.add(e);
  }
  const counterparties = [...emails].filter((e) => !own.has(e)).sort();
  return { counterparties, domains: [...new Set(counterparties.map(domainOf))].sort() };
}

/** A step that writes in at least 30% of its spans is named by its write verb (read the ticket, then reply: "reply"). */
function stepVerb(verbs: ReadonlyMap<string, number>, frameVerbs: ReadonlyMap<string, number>, spans: number): string {
  const top = topOf(verbs);
  if (isWriteVerb(top)) return top;
  const writes = new Map([...frameVerbs].filter(([v, n]) => isWriteVerb(v) && n >= 0.3 * spans));
  return writes.size > 0 ? topOf(writes) : top;
}

function stepName(verb: string, object: string, surface: string): string {
  return `${verb} ${object} on ${surface}`;
}

function goalOf(steps: readonly UnderstandingStep[], loop: readonly string[]): string {
  const core = loop.map((id) => steps.find((s) => s.id === id)).filter((s): s is UnderstandingStep => s !== undefined);
  const use = core.length > 0 ? core : steps.slice(0, 1);
  return use.map((s) => `${s.verb} ${s.object} (${s.surface})`).join(", then ");
}

function toTask(t: InducedTask, spansById: ReadonlyMap<string, Span>, own: ReadonlySet<string>): Omit<Task, "label"> {
  const id = `t_${sha(`v2|${t.signature}`)}`;
  const steps: UnderstandingStep[] = t.steps.map((s) => {
    const c = s.cluster;
    const sk = topOf(c.surfaceKeys);
    const m = c.members.find((x) => x.surfaceKey === sk) ?? c.members[0]!;
    const verb = stepVerb(c.verbs, c.frameVerbs, c.members.length);
    const object = topOf(c.objects);
    const surface = c.members.find((x) => x.surface.toLowerCase() === topOf(c.surfaces))?.surface ?? m.surface;
    return {
      id: c.id,
      name: stepName(verb, object, surface),
      verb,
      object,
      surface,
      surfaceKey: sk,
      app: m.app,
      appName: m.appName,
      host: m.host,
      category: m.category,
      spans: c.members.length,
      activeMs: c.activeMs,
      perInstance: s.perInstance,
      repeatsPerInstance: s.repeatsPerInstance,
      meanPosition: s.meanPosition,
      core: s.core,
    };
  });
  const loop = steps.filter((s) => s.core).sort((a, b) => a.meanPosition - b.meanPosition || (a.id < b.id ? -1 : 1)).map((s) => s.id);
  const instances: TaskInstance[] = t.instances.map((inst) => {
    const spans = inst.spans.map((d) => spansById.get(d.spanId)!).filter((s) => s !== undefined);
    return {
      id: inst.id,
      taskId: id,
      day: inst.day,
      spanIds: inst.spans.map((d) => d.spanId),
      start: inst.start,
      end: inst.end,
      activeMs: inst.activeMs,
      eventIds: spans.flatMap((s) => s.eventIds),
      identifiers: emailIdentifiers(spans, own),
    };
  });
  const spans = t.spans.map((d) => spansById.get(d.spanId)!).filter((s) => s !== undefined);
  const surfacesMap = new Map<string, { app: string; appName: string; host: string; ms: number }>();
  for (const d of t.spans) {
    const k = `${d.app}|${d.host}`;
    const cur = surfacesMap.get(k) ?? { app: d.app, appName: d.appName, host: d.host, ms: 0 };
    cur.ms += d.activeMs;
    surfacesMap.set(k, cur);
  }
  const surfaces = [...surfacesMap.values()].sort((a, b) => b.ms - a.ms || (a.app + a.host < b.app + b.host ? -1 : 1)).map((s) => ({ app: s.app, appName: s.appName, host: s.host, minutes: s.ms / 60_000 }));
  const reach = estimateReach(t.spans.map((d) => ({ app: d.app, host: d.host, urlPattern: d.urlPattern, activeMs: d.activeMs })));
  const counterparts = new Map<string, number>();
  for (const d of t.spans) if (d.counterpart !== "") counterparts.set(d.counterpart, (counterparts.get(d.counterpart) ?? 0) + 1);
  const understanding: TaskUnderstanding = {
    version: 2,
    goal: goalOf(steps, loop),
    steps,
    loop,
    startStep: t.startStep,
    startSurface: t.startSurface,
    identifiers: { items: t.itemIds.length, examples: t.itemIds.slice(0, 5), containers: t.containerIds.slice(0, 10) },
    counterparts: [...counterparts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([c]) => c),
    surfaces,
    instanceBoundaries: t.instances.map((i) => ({ instanceId: i.id, start: i.start, reason: i.reason })),
    evidenceSpanIds: t.spans.map((d) => d.spanId),
    frameIds: t.spans.flatMap((d) => d.frameIds),
    reach,
    sources: { frames: t.spans.filter((d) => d.source === "frames").length, rules: t.spans.filter((d) => d.source === "rules").length },
  };
  // Profile fields v1 code reads come from the step with the most time (the "home" surface).
  const home = [...steps].sort((a, b) => b.activeMs - a.activeMs || (a.id < b.id ? -1 : 1))[0]!;
  const homeDesc = t.spans.find((d) => d.surfaceKey === home.surfaceKey) ?? t.spans[0]!;
  const activeMin = spans.reduce((n, s) => n + s.activeMs, 0) / 60_000;
  const keys = spans.reduce((n, s) => n + s.keys, 0);
  const df = new Map<string, number>();
  for (const inst of instances) {
    const words = new Set<string>();
    for (const sid of inst.spanIds) for (const o of spansById.get(sid)?.ocr ?? []) ocrTokens(o.text).forEach((w) => words.add(w));
    words.forEach((w) => df.set(w, (df.get(w) ?? 0) + 1));
  }
  const instText = (inst: TaskInstance) => inst.spanIds.flatMap((sid) => (spansById.get(sid)?.ocr ?? []).map((o) => o.text)).join("\n");
  const profile: TaskProfile = {
    taskId: id,
    signature: `v2|${t.signature}`,
    app: home.app,
    appName: home.appName,
    host: home.host,
    urlPattern: homeDesc.urlPattern,
    template: homeDesc.template,
    category: home.category,
    exampleTitles: [...new Set(spans.map((s) => s.title))].slice(0, 5),
    ocrKeywords: [...df.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([w]) => w),
    identifiers: emailIdentifiers(spans, own),
    instanceCount: instances.length,
    keysPerMinute: activeMin > 0 ? keys / activeMin : 0,
    schedulingShare: instances.length === 0 ? 0 : instances.filter((i) => looksLikeScheduling(instText(i))).length / instances.length,
    understanding,
  };
  return { id, profile, instances, spanIds: t.spans.map((d) => d.spanId) };
}

export async function understandSpans(spans: readonly Span[], opts: UnderstandOptions): Promise<Understanding> {
  const ownList = opts.ownEmails ?? detectOwnEmails(spans);
  const own = new Set(ownList.map((e) => e.toLowerCase()));
  const spansById = new Map(spans.map((s) => [s.id, s]));
  const framesBySpan = attachFrames(spans, opts.frames);
  let descriptions = describeSpans(spans, framesBySpan, { ownEmails: [...own] });
  if (opts.refiner !== undefined) descriptions = await refineDescriptions(descriptions, opts.refiner);
  const texts = [...new Set(descriptions.map((d) => d.text))];
  const vectors = await opts.embedder.embed(texts);
  const vecOf = new Map(texts.map((t, i) => [t, vectors[i]!]));
  const induction = induceTasks(descriptions, (d) => vecOf.get(d.text)!, opts.induce);
  const labeler = opts.labeler ?? understandingLabeler;
  const tasks: Task[] = [];
  for (const it of induction.tasks) {
    const t = toTask(it, spansById, own);
    const label = await (opts.user === undefined ? labeler.label(t.profile) : labeler.label(t.profile, { user: opts.user }));
    tasks.push({ ...t, label });
  }
  let framesUsed = 0;
  for (const l of framesBySpan.values()) framesUsed += l.length;
  return { tasks, descriptions, induction, embedder: opts.embedder.id, framesUsed };
}
