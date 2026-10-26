// Counts, shares, lengths, cadence and outcomes of the reads. All code (ADR 0005): a model never writes one of these
// numbers. Outcomes are counts with their sample sizes; no rate is computed anywhere.
import { MIN_OUTCOME_SAMPLE, type Cadence, type MessageRead, type Outcomes, type PatternOutcome, type PlaybookMessage, type Share, type Stats } from "./types.ts";

const DAY = 86_400_000;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

export function nearestRank(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

/** Counts of values over n items (an item may carry several values), sorted by count then value. */
export function shares(values: readonly string[], n: number): Share[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].map(([value, count]) => ({ value, count, share: n === 0 ? 0 : round2(count / n) })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

export const lengthBand = (w: number) => (w <= 40 ? "short" : w <= 80 ? "medium" : "long");
export const moveSequence = (r: Pick<MessageRead, "moves">) => r.moves.join(">");

/** The reads that set the shape of a first message: openers, or every read when the workflow has none. */
export const leadReads = (reads: readonly MessageRead[]) => {
  const ft = reads.filter((r) => r.role === "first_touch");
  return ft.length > 0 ? ft : [...reads];
};

export function computeStats(reads: readonly MessageRead[]): Stats {
  const lead = leadReads(reads);
  const n = lead.length;
  const w = lead.map((r) => r.shape.words);
  const p90 = nearestRank(w, 0.9);
  const maxLinks = Math.max(0, ...lead.map((r) => r.shape.links));
  const maxQ = Math.max(1, nearestRank(lead.map((r) => r.shape.questions), 0.9));
  return {
    messages: reads.length,
    byRole: shares(reads.map((r) => r.role), reads.length),
    intent: shares(lead.map((r) => r.intent), n),
    audience: shares(lead.map((r) => r.audience), n),
    opener: shares(lead.map((r) => r.opener), n),
    cta: shares(lead.map((r) => r.cta), n),
    ctaTimeBoxed: lead.filter((r) => r.ctaTimeBoxed).length,
    proof: shares(lead.flatMap((r) => r.proof), n),
    hooks: shares(lead.flatMap((r) => r.hooks), n),
    objections: shares(reads.flatMap((r) => r.objections), reads.length),
    moveSequences: shares(reads.map((r) => `${r.role}:${moveSequence(r)}`), reads.length),
    medianWords: median(w),
    p90Words: p90,
    maxQuestions: maxQ,
    messagesWithLinks: lead.filter((r) => r.shape.links > 0).length,
    messagesWithAttachments: lead.filter((r) => r.shape.attachments > 0).length,
    limits: { maxWords: Math.max(20, Math.ceil((p90 * 1.25) / 10) * 10), maxLinks, maxQuestions: maxQ },
  };
}

function patternRow(dimension: PatternOutcome["dimension"], value: string, rs: readonly MessageRead[]): PatternOutcome {
  const replied = rs.filter((r) => r.outcome === "replied").length;
  const noReply = rs.filter((r) => r.outcome === "no_reply").length;
  return { dimension, value, sent: rs.length, replied, noReply, unknown: rs.length - replied - noReply, enough: replied + noReply >= MIN_OUTCOME_SAMPLE };
}

export function computeOutcomes(reads: readonly MessageRead[]): Outcomes {
  const ft = reads.filter((r) => r.role === "first_touch");
  const rows: PatternOutcome[] = [];
  const dim = (d: PatternOutcome["dimension"], valuesOf: (r: MessageRead) => string[]) => {
    const vals = [...new Set(ft.flatMap(valuesOf))].sort();
    const part = vals.map((v) => patternRow(d, v, ft.filter((r) => valuesOf(r).includes(v))));
    rows.push(...part.sort((a, b) => b.sent - a.sent || (a.value < b.value ? -1 : 1)));
  };
  dim("opener", (r) => [r.opener]);
  dim("cta", (r) => [r.cta]);
  dim("hook", (r) => (r.hooks.length === 0 ? ["none"] : r.hooks));
  dim("proof", (r) => (r.proof.length === 0 ? ["none"] : r.proof));
  dim("length", (r) => [lengthBand(r.shape.words)]);
  const all = patternRow("opener", "", ft);
  return { scope: "first_touch", messages: ft.length, replied: all.replied, noReply: all.noReply, unknown: all.unknown, minSample: MIN_OUTCOME_SAMPLE, byPattern: rows };
}

export function computeCadence(reads: readonly MessageRead[], messages: readonly PlaybookMessage[]): Cadence {
  const at = new Map(messages.map((m) => [m.id, m.sentAt]));
  const threads = new Map<string, MessageRead[]>();
  for (const r of reads) threads.set(r.threadKey, [...(threads.get(r.threadKey) ?? []), r]);
  const gaps: number[] = [];
  let unclear = 0;
  let withFollowUp = 0;
  let maxFollowUps = 0;
  for (const rs of threads.values()) {
    const first = rs.find((r) => r.role === "first_touch");
    const fus = rs.filter((r) => r.role === "follow_up");
    if (fus.length > 0) withFollowUp += 1;
    maxFollowUps = Math.max(maxFollowUps, fus.length);
    const fu = fus[0];
    if (fu === undefined) continue;
    const gap = first === undefined ? -1 : (at.get(fu.id) ?? 0) - (at.get(first.id) ?? 0);
    if (gap > 0) gaps.push(Math.max(1, Math.round(gap / DAY)));
    else unclear += 1;
  }
  const fuReads = reads.filter((r) => r.role === "follow_up");
  return {
    threads: threads.size,
    followUps: fuReads.length,
    threadsWithFollowUp: withFollowUp,
    maxFollowUps,
    medianDaysToFollowUp: gaps.length === 0 ? null : median(gaps),
    timingUnclear: unclear,
    followUpMoves: shares(fuReads.flatMap((r) => r.objections), fuReads.length),
    enough: fuReads.length >= MIN_OUTCOME_SAMPLE,
  };
}
