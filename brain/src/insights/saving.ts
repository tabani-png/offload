// S6 Saving estimate (ADR 0005: numbers are deterministic; the model never produces them). Pure.
// Inputs are rounded to what the arithmetic string shows before any maths, so the user can check it by hand.

export interface SavingInput {
  instances: number;
  daysActive: number;
  /** Days in the observation window (normally 7). */
  windowDays: number;
  medianMinutes: number;
  eventIds: readonly string[];
  /** s20: the task's own observed active minutes in the window. When given, the weekly time the estimate starts from
   * can never exceed the task's observed weekly time (instance counts from an over-merged task are not trusted). */
  activeMinutes?: number;
  /** s20: signals that make the estimate low-confidence (see confidenceOf). */
  signals?: SavingSignals;
}

export interface SavingSignals {
  /** Share of all active time this task holds (0..1). */
  share?: number;
  /** Distinct apps/sites the task spans. */
  surfaces?: number;
  /** Share of the task's time whose screens were only described with a generic looking verb (0..1). */
  genericShare?: number;
}

/** s20: one task holding more than this share across at least MERGED_SURFACES apps is likely several tasks. */
export const MERGED_SHARE = 0.5;
export const MERGED_SURFACES = 4;
export const MIN_CONFIDENT_INSTANCES = 5;
export const GENERIC_SHARE_MAX = 0.5;
/** Rounding slack of the cap (see estimateSaving). */
export const CAP_SLACK = 0.1;

export interface SavingOptions {
  /** Seconds a person spends reviewing one automated item. Default 20 (research: 15-30 s, measured after week 1). */
  reviewSeconds?: number;
  /** Range: the low case reviews this many times slower and leaves `lowManualShare` of items manual. */
  lowReviewFactor?: number;
  lowManualShare?: number;
  /** Range: the high case reviews this many times faster. */
  highReviewFactor?: number;
}

export interface SavingRange {
  hoursSaved: number;
  pct: number;
}

export interface SavingEstimate {
  perDay: number;
  daysPerWeek: number;
  weeklyItems: number;
  medianMinutes: number;
  reviewSecondsPerItem: number;
  weeklyHoursNow: number;
  weeklyHoursAfter: number;
  weeklyHoursSaved: number;
  /** 0..1 */
  savingPct: number;
  range: { low: SavingRange; high: SavingRange };
  arithmetic: string;
  assumptions: string[];
  eventIds: string[];
  /** s20: the task's observed weekly hours (null when the caller gave no activeMinutes). */
  observedWeeklyHours: number | null;
  /** s20: true when instances x median exceeded the observed time and the estimate was cut to it. */
  capped: boolean;
  /** s20: "low" when any reason below holds; the UI should not headline a low-confidence saving. */
  confidence: "normal" | "low";
  confidenceReasons: string[];
}

export const DEFAULT_REVIEW_SECONDS = 20;

const round1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;
const fmt1 = (x: number) => round1(x).toFixed(1);
/** "100" for whole numbers, "99.4" otherwise. */
const fmtCount = (x: number) => (Number.isInteger(round1(x)) ? String(round1(x)) : fmt1(x));
const pctText = (p: number) => `${Math.round(p * 100)}%`;

function savingFor(nowH: number, afterH: number): SavingRange {
  const saved = Math.max(0, nowH - afterH);
  return { hoursSaved: saved, pct: nowH === 0 ? 0 : saved / nowH };
}

/** Plain reasons a saving estimate is not to be trusted at face value. Pure. */
export function confidenceOf(input: Pick<SavingInput, "instances" | "daysActive" | "signals">, capped: boolean): string[] {
  const out: string[] = [];
  if (capped) out.push("The item count implies more time than was observed on this task, so the saving is capped at the observed time.");
  if (input.instances < MIN_CONFIDENT_INSTANCES) out.push(`Only ${input.instances} times seen.`);
  if (input.daysActive < 2) out.push("Seen on one day only.");
  const sig = input.signals ?? {};
  if ((sig.share ?? 0) > MERGED_SHARE && (sig.surfaces ?? 0) >= MERGED_SURFACES)
    out.push(`One task holds ${Math.round((sig.share ?? 0) * 100)}% of all screen time across ${sig.surfaces} apps; it is likely several tasks.`);
  if ((sig.genericShare ?? 0) >= GENERIC_SHARE_MAX) out.push("Most of its screens were only described as looking (reviewing, viewing), not what was done.");
  return out;
}

export function estimateSaving(input: SavingInput, opts: SavingOptions = {}): SavingEstimate {
  const review = opts.reviewSeconds ?? DEFAULT_REVIEW_SECONDS;
  if (!Number.isFinite(review) || review < 0) throw new RangeError(`reviewSeconds must be a non-negative number, got ${review}`);
  if (input.windowDays <= 0) throw new RangeError("windowDays must be positive");
  const lowFactor = opts.lowReviewFactor ?? 1.5;
  const lowManual = opts.lowManualShare ?? 0.1;
  const highFactor = opts.highReviewFactor ?? 0.75;

  const perDay = input.daysActive === 0 ? 0 : round1(input.instances / input.daysActive);
  const daysPerWeek = round1((input.daysActive * 7) / input.windowDays);
  const weeklyItems = round1(perDay * daysPerWeek);
  const medianMinutes = round1(input.medianMinutes);

  // s20 sanity cap: the time saved can never exceed the time the task was observed taking.
  const rawNowH = (weeklyItems * medianMinutes) / 60;
  const observedH = input.activeMinutes === undefined || !Number.isFinite(input.activeMinutes) ? null : round1((Math.max(0, input.activeMinutes) / 60) * (7 / input.windowDays));
  // The per-day count and the median are rounded before the maths, so a raw figure up to CAP_SLACK over the observed
  // time is rounding, not a claim; beyond that, or whenever the saving alone would exceed the observed time, it is cut.
  const capped = observedH !== null && (round1(rawNowH) > observedH * (1 + CAP_SLACK) || rawNowH - Math.min(rawNowH, (weeklyItems * review) / 3600) > observedH);
  const nowH = capped ? observedH : rawNowH;
  const afterH = (weeklyItems * review) / 3600;
  const point = savingFor(nowH, afterH);
  const lowAfter = (weeklyItems * (1 - lowManual) * review * lowFactor) / 3600 + (weeklyItems * lowManual * medianMinutes) / 60;
  const highAfter = (weeklyItems * review * highFactor) / 3600;

  const reasons = confidenceOf(input, capped);
  // The printed saving is the difference of the printed figures, so it adds up by hand (REVIEW-1 L3).
  const shownNow = round1(nowH);
  const shownAfter = round1(Math.min(afterH, nowH));
  const shownSaved = Math.max(0, round1(shownNow - shownAfter));
  const arithmetic =
    `${fmtCount(perDay)}/day × ${fmtCount(daysPerWeek)} days × ${fmt1(medianMinutes)} min = ${capped ? `${round1(rawNowH).toFixed(1)} h/wk, capped at the ${shownNow.toFixed(1)} h/wk observed` : `${shownNow.toFixed(1)} h/wk`}` +
    ` → review ${fmtCount(weeklyItems)} × ${fmtCount(review)} s = ${shownAfter.toFixed(1)} h/wk` +
    ` → saves ${shownSaved.toFixed(1)} h/wk (${pctText(point.pct)})`;

  return {
    perDay,
    daysPerWeek,
    weeklyItems,
    medianMinutes,
    reviewSecondsPerItem: review,
    weeklyHoursNow: nowH,
    weeklyHoursAfter: Math.min(afterH, nowH),
    weeklyHoursSaved: point.hoursSaved,
    savingPct: point.pct,
    // The range never claims more than the observed time either (the high case reviews faster than the point).
    range: { low: savingFor(nowH, Math.max(lowAfter, nowH - (observedH ?? Infinity))), high: savingFor(nowH, Math.max(highAfter, nowH - (observedH ?? Infinity))) },
    arithmetic,
    assumptions: [
      `Each automated item still gets a ${fmtCount(review)} s human review before anything is sent.`,
      `Low case: review takes ${fmtCount(review * lowFactor)} s and ${Math.round(lowManual * 100)}% of items stay manual.`,
      `High case: review takes ${fmtCount(review * highFactor)} s.`,
      "Measured time replaces this estimate after the first week of runs.",
    ],
    eventIds: [...input.eventIds],
    observedWeeklyHours: observedH,
    capped,
    confidence: reasons.length > 0 ? "low" : "normal",
    confidenceReasons: reasons,
  };
}
