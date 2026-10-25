// Local calendar days in an IANA timezone without the Date object (ADR 0109 §5: half-open periods of local days).
// Uses Intl tz data only; given the same ICU data the result is deterministic.

import { HoursSavedInputError, type Period } from "./types.ts";

const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      throw new HoursSavedInputError(`unknown timezone ${tz}`);
    }
    formatters.set(tz, f);
  }
  return f;
}

/** YYYY-MM-DD of the instant `ms` (epoch milliseconds) in timezone `tz`. */
export function localDay(ms: number, tz: string): string {
  if (!Number.isSafeInteger(ms)) throw new HoursSavedInputError(`timestamp must be integer ms, got ${String(ms)}`);
  let y = "", m = "", d = "";
  for (const p of formatter(tz).formatToParts(ms)) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return `${y.padStart(4, "0")}-${m}-${d}`;
}

export function assertPeriod(period: Period): void {
  if (!DAY_RE.test(period.from) || !DAY_RE.test(period.toExclusive)) {
    throw new HoursSavedInputError("period days must be YYYY-MM-DD");
  }
  if (period.toExclusive < period.from) throw new HoursSavedInputError("period ends before it starts");
}

/** endedAt ∈ [from, toExclusive) measured in local days of `tz`. */
export function inPeriod(ms: number, period: Period, tz: string): boolean {
  const day = localDay(ms, tz);
  return day >= period.from && day < period.toExclusive;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * First instant (epoch ms) whose local day in `tz` is `day` or later. Binary search over ±2 days around UTC midnight,
 * so DST days of 23 or 25 hours and midnight gaps resolve exactly. Useful for SQL range filters by S2-05.
 */
export function dayStartUtc(day: string, tz: string): number {
  if (!DAY_RE.test(day)) throw new HoursSavedInputError("day must be YYYY-MM-DD");
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const utcMidnight = daysFromCivil(y, m, d) * 86_400_000;
  let lo = utcMidnight - 2 * 86_400_000; // local day < `day` here (offsets are within ±14 h)
  let hi = utcMidnight + 2 * 86_400_000; // local day ≥ `day` here
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDay(mid, tz) >= day) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Half-open UTC instant bounds [startMs, endMsExclusive) of a period of local days. */
export function periodBoundsUtc(period: Period, tz: string): { readonly startMs: number; readonly endMsExclusive: number } {
  assertPeriod(period);
  return { startMs: dayStartUtc(period.from, tz), endMsExclusive: dayStartUtc(period.toExclusive, tz) };
}
