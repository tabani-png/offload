// The reporting period every screen shows: the current month so far, in the tenant's reporting timezone (ADR 0109).
// Days are `YYYY-MM-DD`; `to` is exclusive, as the API takes it. Pure: the clock and timezone are inputs.

import { monthName } from "./format.ts";

export interface MonthPeriod {
  month: string;
  from: string;
  to: string;
}

export interface Period extends MonthPeriod {
  /** "October so far" */
  label: string;
  timezone: string;
  /** The last six months, oldest first; the last one is this period. */
  trend: MonthPeriod[];
  /** Today (local): the morning digest's day. */
  today: string;
}

/** The local calendar day of `ts` in `tz`. */
export function localDay(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ts);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` day (no timezone involved). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** This month so far, including today: [first of the month, tomorrow). */
export function periodAt(now: number, tz: string): Period {
  const today = localDay(now, tz);
  const month = today.slice(0, 7);
  const to = addDays(today, 1);
  const trend = [-5, -4, -3, -2, -1].map((k) => {
    const m = addMonths(month, k);
    return { month: m, from: `${m}-01`, to: `${addMonths(m, 1)}-01` };
  });
  trend.push({ month, from: `${month}-01`, to });
  return { month, from: `${month}-01`, to, label: `${monthName(month)} so far`, timezone: tz, trend, today };
}
