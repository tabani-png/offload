// s12 any-domain task induction, Task Model Induction style (arXiv 2608.20319), deterministic.
//  1. Steps: span descriptions join the step cluster with their exact surface+verb+object key, else the best cluster
//     by embedding similarity + surface + verb/object (a new cluster when nothing fits). After each day a global merge
//     joins near-duplicate clusters (same surface, or same app with the same described surface and verb).
//  2. Tasks: steps link when spans of both share an item-level identifier close in time (an identifier seen on few
//     spans: an invoice number, a ticket id, a file name), or when one reliably follows the other. Linked steps are one
//     task (connected components).
//  3. Instances: a task's spans in time order split on a new day, a long gap, an identifier that conflicts with the
//     current instance, or the task's start surface coming round again with a new item (the loop model).
import { cosine } from "./embed.ts";
import { RULES_CONFIDENCE, type SpanDescription } from "./describe.ts";
import type { InstanceBoundaryReason } from "../types.ts";

export interface InduceOptions {
  /** Score needed to join an existing step cluster (0..1). */
  assignThreshold: number;
  /** Centroid cosine to merge two clusters on the same surface. */
  sameSurfaceMerge: number;
  /** Centroid cosine to merge clusters in one app whose described surface and verb agree. */
  describedSurfaceMerge: number;
  /** Centroid cosine to merge clusters on the same surface about the same object. */
  sameObjectMerge: number;
  /** Centroid cosine to merge any two clusters in one app. */
  crossSurfaceMerge: number;
  /** An identifier on at most this many spans names one item; more = a container (a sheet, an org, a supplier). */
  itemDfMax: number;
  linkGapMs: number;
  transitionGapMs: number;
  transitionMinCount: number;
  transitionMinRate: number;
  transitionMinSideRate: number;
  cooccurMinCount: number;
  cooccurMinRate: number;
  instanceGapMs: number;
  sameItemGapMs: number;
  /** A step in at least this share of instances is part of the loop. */
  coreShare: number;
}

export const DEFAULT_INDUCE_OPTIONS: Readonly<InduceOptions> = {
  assignThreshold: 0.7,
  sameSurfaceMerge: 0.8,
  describedSurfaceMerge: 0.8,
  sameObjectMerge: 0.5,
  crossSurfaceMerge: 0.93,
  itemDfMax: 12,
  linkGapMs: 20 * 60_000,
  transitionGapMs: 30_000,
  transitionMinCount: 5,
  transitionMinRate: 0.7,
  transitionMinSideRate: 0.15,
  cooccurMinCount: 2,
  cooccurMinRate: 0.15,
  instanceGapMs: 10 * 60_000,
  sameItemGapMs: 45_000,
  coreShare: 0.6,
};

export interface StepCluster {
  id: string;
  members: SpanDescription[];
  sum: number[];
  activeMs: number;
  verbs: Map<string, number>;
  objects: Map<string, number>;
  surfaces: Map<string, number>;
  surfaceKeys: Map<string, number>;
  steps: Map<string, number>;
  activities: Map<string, number>;
  /** Verbs of every confident frame in the members (a span can hold "read" and "reply"). */
  frameVerbs: Map<string, number>;
}

export interface InducedInstance {
  id: string;
  day: string;
  spans: SpanDescription[];
  start: number;
  end: number;
  activeMs: number;
  reason: InstanceBoundaryReason;
  itemIds: Set<string>;
  /** Item ids seen per screen (app + host + path pattern): a different item on a screen already in the instance
   * starts a new instance (the next invoice PDF, the next ticket). */
  surfaceItems: Map<string, Set<string>>;
}

export interface InducedStep {
  cluster: StepCluster;
  perInstance: number;
  repeatsPerInstance: number;
  meanPosition: number;
  core: boolean;
}

export interface InducedTask {
  /** Step ids, sorted: the stable signature of the task. */
  signature: string;
  steps: InducedStep[];
  spans: SpanDescription[];
  instances: InducedInstance[];
  startStep: string;
  startSurface: string;
  itemIds: string[];
  containerIds: string[];
}

export interface Induction {
  tasks: InducedTask[];
  steps: StepCluster[];
  stepOf: Map<string, string>;
}

export function topOf(m: ReadonlyMap<string, number>): string {
  let best = "";
  let bw = -Infinity;
  for (const [k, w] of m) if (w > bw + 1e-9 || (Math.abs(w - bw) <= 1e-9 && k < best)) [best, bw] = [k, w];
  return best;
}

const inc = (m: Map<string, number>, k: string, w = 1) => {
  if (k !== "") m.set(k, (m.get(k) ?? 0) + w);
};
const stepKey = (d: SpanDescription) => `${d.surfaceKey}|${d.verb}|${d.object}`;

function newCluster(d: SpanDescription, v: readonly number[]): StepCluster {
  const c: StepCluster = { id: `st_${d.spanId.replace(/^sp_/, "")}`, members: [], sum: new Array<number>(v.length).fill(0), activeMs: 0, verbs: new Map(), objects: new Map(), surfaces: new Map(), surfaceKeys: new Map(), steps: new Map(), activities: new Map(), frameVerbs: new Map() };
  return c;
}

function addTo(c: StepCluster, d: SpanDescription, v: readonly number[]): void {
  c.members.push(d);
  for (let i = 0; i < v.length; i++) c.sum[i] = (c.sum[i] ?? 0) + v[i]!;
  c.activeMs += d.activeMs;
  inc(c.verbs, d.verb);
  inc(c.objects, d.object);
  inc(c.surfaces, d.surface.toLowerCase());
  inc(c.surfaceKeys, d.surfaceKey);
  inc(c.steps, d.step);
  inc(c.activities, d.activity);
  for (const v of d.frameVerbs) inc(c.frameVerbs, v);
}

function absorb(into: StepCluster, from: StepCluster): void {
  into.members.push(...from.members);
  into.members.sort((a, b) => a.start - b.start || (a.spanId < b.spanId ? -1 : 1));
  for (let i = 0; i < from.sum.length; i++) into.sum[i] = (into.sum[i] ?? 0) + from.sum[i]!;
  into.activeMs += from.activeMs;
  for (const k of ["verbs", "objects", "surfaces", "surfaceKeys", "steps", "activities", "frameVerbs"] as const) for (const [x, w] of from[k]) inc(into[k], x, w);
}

const appOfKey = (surfaceKey: string) => surfaceKey.split("|")[0] ?? "";

function score(d: SpanDescription, v: readonly number[], c: StepCluster): number {
  const top = topOf(c.surfaceKeys);
  const sameKey = c.surfaceKeys.has(d.surfaceKey) ? 1 : 0;
  const sameSurface = c.surfaces.has(d.surface.toLowerCase()) ? 1 : 0;
  const sameVerb = topOf(c.verbs) === d.verb ? 1 : 0;
  const sameObject = topOf(c.objects) === d.object ? 1 : 0;
  const otherCategory = c.members[0]?.category !== d.category ? 1 : 0;
  const otherApp = appOfKey(top) !== d.app ? 1 : 0;
  return 0.5 * cosine(v, c.sum) + 0.2 * sameKey + 0.1 * sameSurface + 0.1 * sameVerb + 0.1 * sameObject - 0.2 * otherCategory - 0.2 * otherApp;
}

function largestOnSurface(clusters: readonly StepCluster[], surfaceKey: string): StepCluster | undefined {
  let best: StepCluster | undefined;
  for (const c of clusters) {
    if (!c.surfaceKeys.has(surfaceKey) || c.members.every((m) => m.confidence < RULES_CONFIDENCE)) continue;
    if (best === undefined || c.members.length > best.members.length) best = c;
  }
  return best;
}

function mergeable(a: StepCluster, b: StepCluster, o: InduceOptions): boolean {
  const cos = cosine(a.sum, b.sum);
  const ka = topOf(a.surfaceKeys);
  const kb = topOf(b.surfaceKeys);
  if (ka === kb && cos >= o.sameSurfaceMerge) return true;
  // Same screen, same thing worked on, same described surface: one step whose spans voted different verbs.
  if (ka === kb && topOf(a.objects) === topOf(b.objects) && topOf(a.surfaces) === topOf(b.surfaces) && cos >= o.sameObjectMerge) return true;
  if (appOfKey(ka) !== appOfKey(kb)) return false;
  if (topOf(a.surfaces) === topOf(b.surfaces) && topOf(a.verbs) === topOf(b.verbs) && cos >= o.describedSurfaceMerge) return true;
  return cos >= o.crossSurfaceMerge;
}

/** Union-find over string keys. */
class Union {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra === rb) return;
    // The smaller id wins so the result does not depend on the order of unions.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

/** Identifier keys of a description: each identifier plus its long digit runs ("inv-20481" also links "#20481"). */
export function idKeys(d: SpanDescription): string[] {
  const keys = new Set<string>();
  for (const id of d.identifiers) {
    keys.add(id);
    for (const run of id.match(/\d{4,}/g) ?? []) keys.add(`~${run}`);
  }
  return [...keys];
}

export function induceTasks(descriptions: readonly SpanDescription[], vectorOf: (d: SpanDescription) => readonly number[], options: Partial<InduceOptions> = {}): Induction {
  const o: InduceOptions = { ...DEFAULT_INDUCE_OPTIONS, ...options };
  const descs = [...descriptions].sort((a, b) => a.start - b.start || (a.spanId < b.spanId ? -1 : 1));

  // 1. Step clusters, day by day, with a global merge after each day.
  let clusters: StepCluster[] = [];
  const byKey = new Map<string, StepCluster>();
  const days = [...new Set(descs.map((d) => d.day))].sort();
  for (const day of days) {
    for (const d of descs) {
      if (d.day !== day) continue;
      const v = vectorOf(d);
      let c = byKey.get(stepKey(d));
      if (c === undefined && d.confidence < RULES_CONFIDENCE) {
        // A vague frame ("looking at the screen") says nothing about the step: the surface decides, as in v1.
        c = largestOnSurface(clusters, d.surfaceKey);
      }
      if (c === undefined) {
        let best: StepCluster | undefined;
        let bestScore = o.assignThreshold;
        for (const cand of clusters) {
          const s = score(d, v, cand);
          if (s >= bestScore && (best === undefined || s > bestScore)) [best, bestScore] = [cand, s];
        }
        c = best;
      }
      if (c === undefined) {
        c = newCluster(d, v);
        clusters.push(c);
      }
      addTo(c, d, v);
      byKey.set(stepKey(d), c);
    }
    // Global merge: repeat until stable; the older cluster absorbs the newer one.
    for (let changed = true; changed; ) {
      changed = false;
      outer: for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          if (!mergeable(clusters[i]!, clusters[j]!, o)) continue;
          const [keep, gone] = [clusters[i]!, clusters[j]!];
          absorb(keep, gone);
          for (const [k, c] of byKey) if (c === gone) byKey.set(k, keep);
          clusters = clusters.filter((c) => c !== gone);
          changed = true;
          break outer;
        }
      }
    }
  }
  // Clusters made only of vague descriptions join the main cluster on their surface.
  for (const vague of [...clusters]) {
    if (!vague.members.every((m) => m.confidence < RULES_CONFIDENCE)) continue;
    const host = largestOnSurface(clusters.filter((c) => c !== vague), topOf(vague.surfaceKeys));
    if (host === undefined) continue;
    absorb(host, vague);
    clusters = clusters.filter((c) => c !== vague);
  }
  const stepOf = new Map<string, string>();
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  for (const c of clusters) for (const m of c.members) stepOf.set(m.spanId, c.id);
  const sizeOf = (id: string) => clusterById.get(id)?.members.length ?? 0;

  // 2. Item-level identifiers and step links.
  const df = new Map<string, number>();
  for (const d of descs) for (const k of idKeys(d)) df.set(k, (df.get(k) ?? 0) + 1);
  const isItem = (k: string) => (df.get(k) ?? 0) <= o.itemDfMax;
  const itemKeys = (d: SpanDescription) => idKeys(d).filter(isItem);

  const union = new Union();
  for (const c of clusters) union.find(c.id);

  const byItem = new Map<string, SpanDescription[]>();
  for (const d of descs) for (const k of itemKeys(d)) byItem.set(k, [...(byItem.get(k) ?? []), d]);
  const pairs = new Set<string>();
  const cooccur = new Map<string, number>();
  for (const list of byItem.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i]!, list[j]!];
        const [sa, sb] = [stepOf.get(a.spanId)!, stepOf.get(b.spanId)!];
        if (sa === sb || a.day !== b.day || Math.abs(b.start - a.start) > o.linkGapMs) continue;
        const pk = `${a.spanId}|${b.spanId}`;
        if (pairs.has(pk)) continue;
        pairs.add(pk);
        const ek = sa < sb ? `${sa}|${sb}` : `${sb}|${sa}`;
        cooccur.set(ek, (cooccur.get(ek) ?? 0) + 1);
      }
    }
  }
  for (const [ek, w] of cooccur) {
    const [a, b] = ek.split("|") as [string, string];
    if (w >= Math.max(o.cooccurMinCount, o.cooccurMinRate * Math.min(sizeOf(a), sizeOf(b)))) union.union(a, b);
  }

  const trans = new Map<string, number>();
  for (let i = 1; i < descs.length; i++) {
    const [x, y] = [descs[i - 1]!, descs[i]!];
    if (x.day !== y.day || y.start - x.end > o.transitionGapMs) continue;
    const [sx, sy] = [stepOf.get(x.spanId)!, stepOf.get(y.spanId)!];
    if (sx === sy) continue;
    trans.set(`${sx}>${sy}`, (trans.get(`${sx}>${sy}`) ?? 0) + 1);
  }
  for (const [tk, n] of trans) {
    const [a, b] = tk.split(">") as [string, string];
    // One step reliably follows the other (rate >= transitionMinRate on one side), and the link is not a rare event for
    // the other side either (>= transitionMinSideRate): an optional step inside the loop, not noise after a task.
    const [ra, rb] = [n / sizeOf(a), n / sizeOf(b)];
    if (n >= o.transitionMinCount && Math.max(ra, rb) >= o.transitionMinRate && Math.min(ra, rb) >= o.transitionMinSideRate) union.union(a, b);
  }

  // 3. Tasks = components; instances per task.
  const comps = new Map<string, StepCluster[]>();
  for (const c of clusters) {
    const r = union.find(c.id);
    comps.set(r, [...(comps.get(r) ?? []), c]);
  }
  const prevOf = new Map<string, SpanDescription | undefined>();
  descs.forEach((d, i) => prevOf.set(d.spanId, descs[i - 1]));

  const tasks: InducedTask[] = [];
  for (const steps of comps.values()) {
    const stepIds = new Set(steps.map((s) => s.id));
    const spans = steps.flatMap((s) => s.members).sort((a, b) => a.start - b.start || (a.spanId < b.spanId ? -1 : 1));
    const startStep = chooseStartStep(spans, stepIds, stepOf, prevOf, itemKeys, o);
    const instances = buildInstances(spans, startStep, stepOf, itemKeys, o);
    const induced = steps.map((c) => loopStats(c, instances, o)).sort((a, b) => a.meanPosition - b.meanPosition || b.cluster.activeMs - a.cluster.activeMs || (a.cluster.id < b.cluster.id ? -1 : 1));
    const startCluster = steps.find((c) => c.id === startStep);
    const startSurface = startCluster === undefined ? "" : topOf(startCluster.surfaceKeys);
    const allKeys = new Set(spans.flatMap((d) => idKeys(d)).filter((k) => !k.startsWith("~")));
    tasks.push({
      signature: [...stepIds].sort().join(","),
      steps: induced,
      spans,
      instances,
      startStep,
      startSurface,
      itemIds: [...allKeys].filter(isItem).sort(),
      containerIds: [...allKeys].filter((k) => !isItem(k)).sort(),
    });
  }
  tasks.sort((a, b) => (a.spans[0]?.start ?? 0) - (b.spans[0]?.start ?? 0) || (a.signature < b.signature ? -1 : 1));
  return { tasks, steps: clusters, stepOf };
}

function chooseStartStep(
  spans: readonly SpanDescription[],
  stepIds: ReadonlySet<string>,
  stepOf: ReadonlyMap<string, string>,
  prevOf: ReadonlyMap<string, SpanDescription | undefined>,
  itemKeys: (d: SpanDescription) => string[],
  o: InduceOptions,
): string {
  // Where an item first shows up is where an instance starts (the invoice PDF before the bill form).
  const first = new Map<string, number>();
  const seen = new Set<string>();
  for (const d of spans) {
    for (const k of itemKeys(d)) {
      if (k.startsWith("~") || seen.has(k)) continue;
      seen.add(k);
      inc(first, stepOf.get(d.spanId) ?? "");
    }
  }
  const total = [...first.values()].reduce((a, b) => a + b, 0);
  if (total >= 3) return topOf(first);
  // No identifiers: the step the user most often enters the task from.
  const entries = new Map<string, number>();
  for (const d of spans) {
    const p = prevOf.get(d.spanId);
    const inTask = p !== undefined && stepIds.has(stepOf.get(p.spanId) ?? "") && p.day === d.day && d.start - p.end <= o.transitionGapMs;
    if (!inTask) inc(entries, stepOf.get(d.spanId) ?? "");
  }
  return topOf(entries);
}

function buildInstances(spans: readonly SpanDescription[], startStep: string, stepOf: ReadonlyMap<string, string>, itemKeys: (d: SpanDescription) => string[], o: InduceOptions): InducedInstance[] {
  const out: InducedInstance[] = [];
  let cur: InducedInstance | null = null;
  let hasStart = false;
  const open = (d: SpanDescription, reason: InstanceBoundaryReason) => {
    cur = { id: `in_${d.spanId.replace(/^sp_/, "")}`, day: d.day, spans: [], start: d.start, end: d.end, activeMs: 0, reason, itemIds: new Set(), surfaceItems: new Map() };
    out.push(cur);
    hasStart = false;
  };
  for (const d of spans) {
    const ids = itemKeys(d);
    const step = stepOf.get(d.spanId) ?? "";
    const base = `${d.app}|${d.host}|${d.urlPattern}`;
    const c = cur as InducedInstance | null;
    if (c === null) open(d, "first");
    else if (c.day !== d.day) open(d, "new_day");
    else if (d.start - c.end > o.instanceGapMs) open(d, "gap");
    else {
      const last = c.spans[c.spans.length - 1]!;
      const shared = ids.filter((k) => c.itemIds.has(k));
      const fresh = ids.filter((k) => !c.itemIds.has(k));
      const atStart = step === startStep && hasStart;
      const onSurface = c.surfaceItems.get(base);
      if (ids.length > 0 && shared.length === 0 && onSurface !== undefined && onSurface.size > 0) open(d, "new_item");
      else if (ids.length > 0 && c.itemIds.size > 0 && fresh.length === 0) {
        // Nothing new: the same item again (back to the ticket after the order lookup).
      } else if (atStart) {
        const sameItem = d.title === last.title && d.start - last.end <= o.sameItemGapMs && fresh.length === 0;
        if (!sameItem) open(d, "loop_restart");
      }
    }
    const inst = cur as unknown as InducedInstance;
    inst.spans.push(d);
    inst.end = Math.max(inst.end, d.end);
    inst.activeMs += d.activeMs;
    for (const k of ids) inst.itemIds.add(k);
    if (ids.length > 0) {
      const set = inst.surfaceItems.get(base) ?? new Set<string>();
      for (const k of ids) set.add(k);
      inst.surfaceItems.set(base, set);
    }
    if (step === startStep) hasStart = true;
  }
  return out;
}

function loopStats(c: StepCluster, instances: readonly InducedInstance[], o: InduceOptions): InducedStep {
  const members = new Set(c.members.map((m) => m.spanId));
  let containing = 0;
  let repeats = 0;
  let pos = 0;
  for (const inst of instances) {
    const idx = inst.spans.findIndex((s) => members.has(s.spanId));
    if (idx < 0) continue;
    containing += 1;
    repeats += inst.spans.filter((s) => members.has(s.spanId)).length;
    pos += idx;
  }
  const perInstance = instances.length === 0 ? 0 : containing / instances.length;
  return { cluster: c, perInstance, repeatsPerInstance: containing === 0 ? 0 : repeats / containing, meanPosition: containing === 0 ? 0 : pos / containing, core: perInstance >= o.coreShare };
}
