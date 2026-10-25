// S4 Repeats. Pure maths over task instances. Every figure carries the event ids behind it.
import { maskText, ocrTokens, sequenceSimilarity, tokenize } from "./grouping/normalize.ts";
import type { DayLabel, Figure, SamenessBreakdown, Span, Task, TaskInstance, TaskStats } from "./types.ts";

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile, q in (0, 1]. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil(q * s.length)));
  return s[rank - 1]!;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface InstanceShape {
  titleTokens: readonly string[];
  stepTokens: ReadonlySet<string>;
  activeMs: number;
}

/** Evenly spaced, deterministic sample so pairwise maths stays cheap on large tasks. */
export function evenSample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor((i * items.length) / max)]!);
  return out;
}

function meanPairwise<T>(items: readonly T[], sim: (a: T, b: T) => number): number {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      total += sim(items[i]!, items[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

/** 1 - coefficient of variation, floored at 0: regular durations score near 1. */
export function durationRegularity(durations: readonly number[]): number {
  if (durations.length < 2) return 0;
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  if (mean === 0) return 0;
  const variance = durations.reduce((n, d) => n + (d - mean) ** 2, 0) / durations.length;
  return Math.max(0, 1 - Math.sqrt(variance) / mean);
}

export const SAMENESS_SAMPLE = 120;

/**
 * Sameness 0..1 = mean of title similarity (pairwise LCS over masked title tokens) and step similarity
 * (pairwise Jaccard over OCR content words; duration regularity when most instances have no OCR).
 * Fewer than two instances: 0, because nothing repeats.
 */
export function computeSameness(instances: readonly InstanceShape[]): SamenessBreakdown {
  if (instances.length < 2) return { score: 0, titleSimilarity: 0, stepSimilarity: 0, stepMethod: "duration" };
  const sample = evenSample(instances, SAMENESS_SAMPLE);
  const titleSimilarity = meanPairwise(sample, (a, b) => sequenceSimilarity(a.titleTokens, b.titleTokens));
  const withOcr = sample.filter((s) => s.stepTokens.size > 0);
  const useOcr = withOcr.length >= 2 && withOcr.length * 2 >= sample.length;
  const stepSimilarity = useOcr ? meanPairwise(withOcr, (a, b) => jaccard(a.stepTokens, b.stepTokens)) : durationRegularity(sample.map((s) => s.activeMs));
  return { score: (titleSimilarity + stepSimilarity) / 2, titleSimilarity, stepSimilarity, stepMethod: useOcr ? "ocr" : "duration" };
}

export function instanceShape(inst: TaskInstance, spansById: ReadonlyMap<string, Span>): InstanceShape {
  const spans = inst.spanIds.map((id) => spansById.get(id)).filter((s): s is Span => s !== undefined);
  const steps = new Set<string>();
  for (const s of spans) for (const o of s.ocr) ocrTokens(o.text).forEach((w) => steps.add(w));
  return { titleTokens: tokenize(maskText(spans[0]?.title ?? "")), stepTokens: steps, activeMs: inst.activeMs };
}

export interface StatsContext {
  /** Active ms across every span in the window (the denominator of share). */
  totalActiveMs: number;
  windowDays: readonly DayLabel[];
  spansById: ReadonlyMap<string, Span>;
}

const fig = (value: number, unit: Figure["unit"], eventIds: string[]): Figure => ({ value, unit, eventIds });

function idsOf(instances: readonly TaskInstance[]): string[] {
  return instances.flatMap((i) => i.eventIds);
}

export function computeTaskStats(task: Task, ctx: StatsContext): TaskStats {
  const insts = task.instances;
  const all = idsOf(insts);
  const byDuration = [...insts].sort((a, b) => a.activeMs - b.activeMs || (a.id < b.id ? -1 : 1));
  const n = byDuration.length;
  const medianInsts = n === 0 ? [] : n % 2 === 1 ? [byDuration[(n - 1) / 2]!] : [byDuration[n / 2 - 1]!, byDuration[n / 2]!];
  const p90Rank = Math.min(n, Math.max(1, Math.ceil(0.9 * n)));
  const p90Inst = n === 0 ? [] : [byDuration[p90Rank - 1]!];
  const minutes = insts.map((i) => i.activeMs / 60_000);
  const activeMs = insts.reduce((s, i) => s + i.activeMs, 0);
  const days = new Set(insts.map((i) => i.day)).size;
  const sameness = computeSameness(insts.map((i) => instanceShape(i, ctx.spansById)));
  return {
    taskId: task.id,
    instances: fig(n, "count", all),
    daysActive: fig(days, "days", all),
    instancesPerDay: fig(days === 0 ? 0 : n / days, "per_day", all),
    medianMinutes: fig(median(minutes), "minutes", idsOf(medianInsts)),
    p90Minutes: fig(percentile(minutes, 0.9), "minutes", idsOf(p90Inst)),
    activeMinutes: fig(activeMs / 60_000, "minutes", all),
    share: fig(ctx.totalActiveMs === 0 ? 0 : activeMs / ctx.totalActiveMs, "ratio", all),
    sameness: fig(sameness.score, "score", all),
    samenessBreakdown: sameness,
  };
}
