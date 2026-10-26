// Display formatting. Arithmetic stays in integer seconds; rounding happens only here (ADR 0109 §10).

/** hours = round_half_even(seconds / 360) / 10 */
export function displayHours(seconds: number): number {
  const x = seconds / 360;
  const f = Math.floor(x);
  const diff = x - f;
  const r = diff > 0.5 ? f + 1 : diff < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return r / 10;
}

const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const hoursText = (seconds: number): string => `${nf1.format(displayHours(seconds))} h`;
export const count = (n: number): string => nf0.format(n);
export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

export function minutesText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const usd = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

export function dayText(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d} ${SHORT[m - 1]} ${y}`;
}

export function monthName(month: string, short = false): string {
  const m = Number(month.split("-")[1]);
  return (short ? SHORT : MONTHS)[m - 1] ?? month;
}

/** Times are shown in UTC in the mock so snapshots are stable; S2-11 switches to the tenant timezone. */
export function timeText(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${SHORT[d.getUTCMonth()]}, ${hh}:${mm}`;
}

export function relativeText(ts: number, now: number): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const h = Math.round(abs / 3_600_000);
  const unit = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export const shortHash = (h: string): string => h.slice(0, 8);
