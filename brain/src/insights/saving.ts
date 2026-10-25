// S6 Saving estimate (ADR 0005: numbers are deterministic; the model never produces them). Pure.
// Inputs are rounded to what the arithmetic string shows before any maths, so the user can check it by hand.

export interface SavingInput {
  instances: number;
  daysActive: number;
  /** Days in the observation window (normally 7). */
  windowDays: number;
  medianMinutes: number;
  eventIds: readonly string[];
}

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

  const nowH = (weeklyItems * medianMinutes) / 60;
  const afterH = (weeklyItems * review) / 3600;
  const point = savingFor(nowH, afterH);
  const lowAfter = (weeklyItems * (1 - lowManual) * review * lowFactor) / 3600 + (weeklyItems * lowManual * medianMinutes) / 60;
  const highAfter = (weeklyItems * review * highFactor) / 3600;

  const arithmetic =
    `${fmtCount(perDay)}/day × ${fmtCount(daysPerWeek)} days × ${fmt1(medianMinutes)} min = ${fmt1(nowH)} h/wk` +
    ` → review ${fmtCount(weeklyItems)} × ${fmtCount(review)} s = ${fmt1(Math.min(afterH, nowH))} h/wk` +
    ` → saves ${fmt1(point.hoursSaved)} h/wk (${pctText(point.pct)})`;

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
    range: { low: savingFor(nowH, lowAfter), high: savingFor(nowH, highAfter) },
    arithmetic,
    assumptions: [
      `Each automated item still gets a ${fmtCount(review)} s human review before anything is sent.`,
      `Low case: review takes ${fmtCount(review * lowFactor)} s and ${Math.round(lowManual * 100)}% of items stay manual.`,
      `High case: review takes ${fmtCount(review * highFactor)} s.`,
      "Measured time replaces this estimate after the first week of runs.",
    ],
    eventIds: [...input.eventIds],
  };
}
