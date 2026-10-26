/**
 * Schedules (ADR 0105 §5, ADR 0106 §7, ADR 0112 §7): 5-field POSIX cron in an IANA timezone, as Managed Agents
 * deployments take it. Any hour 1-3 is refused, so nothing fires between 01:00 and 03:59 local, where DST skips or
 * repeats hours. `nextRun` walks local wall-clock minutes: a local time that does not exist (spring forward) is
 * skipped, one that exists twice (fall back) fires once, at its first instant.
 */

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export const FORBIDDEN_HOURS = [1, 2, 3];

function field(src: string, f: { name: string; min: number; max: number }): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${f.name}: "${part}" is not a number, range, list or step`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo = f.min;
    let hi = f.max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : f.max) : Number(m[3]);
    }
    if (step < 1 || lo < f.min || hi > f.max || lo > hi) throw new Error(`${f.name}: "${part}" is outside ${f.min}-${f.max}`);
    for (let v = lo; v <= hi; v += step) out.add(f.name === "day of week" && v === 7 ? 0 : v);
  }
  return out;
}

/** Parses a 5-field cron; throws a plain-words error. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a schedule is 5 fields: minute hour day-of-month month day-of-week");
  const [mi, h, d, mo, w] = parts.map((p, i) => field(p, FIELDS[i]!));
  return { minutes: mi!, hours: h!, days: d!, months: mo!, weekdays: w!, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function isTimezone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Why a schedule is refused, or null. */
export function scheduleProblem(expr: string, tz: string): string | null {
  if (!isTimezone(tz)) return `${tz} is not an IANA timezone`;
  let c: Cron;
  try {
    c = parseCron(expr);
  } catch (e) {
    return (e as Error).message;
  }
  const bad = FORBIDDEN_HOURS.filter((h) => c.hours.has(h));
  if (bad.length > 0) return `runs between 01:00 and 03:59 local time are not allowed (daylight saving time skips or repeats those hours)`;
  return null;
}

interface Local {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const fmts = new Map<string, Intl.DateTimeFormat>();
function local(t: number, tz: string): Local {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/** The UTC instants whose local wall clock in `tz` reads exactly `l` (0, 1 or 2 of them). */
function instantsOf(l: Local, tz: string): number[] {
  const asUtc = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  const out: number[] = [];
  // Offsets on Earth are within -14h..+14h; check each quarter hour so every zone (incl. :30 / :45) is covered.
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const t = asUtc - off * 60_000;
    const x = local(t, tz);
    if (x.y === l.y && x.mo === l.mo && x.d === l.d && x.h === l.h && x.mi === l.mi && !out.includes(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function dayMatches(c: Cron, y: number, mo: number, d: number): boolean {
  if (!c.months.has(mo)) return false;
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const dom = c.days.has(d);
  const wd = c.weekdays.has(dow);
  // POSIX: when both day fields are restricted, either may match.
  if (!c.domStar && !c.dowStar) return dom || wd;
  if (!c.domStar) return dom;
  if (!c.dowStar) return wd;
  return true;
}

/** The first firing strictly after `after` (epoch ms), or null within the next 400 days. */
export function nextRun(expr: string, tz: string, after: number): number | null {
  const c = parseCron(expr);
  const start = local(after, tz);
  const startDay = Date.UTC(start.y, start.mo - 1, start.d);
  const hours = [...c.hours].sort((a, b) => a - b);
  const minutes = [...c.minutes].sort((a, b) => a - b);
  for (let i = 0; i < 400; i++) {
    const day = new Date(startDay + i * 86_400_000);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(c, y, mo, d)) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const ts = instantsOf({ y, mo, d, h, mi }, tz);
        const first = ts[0];
        if (first !== undefined && first > after) return first;
      }
    }
  }
  return null;
}

/** The epoch ms of a local wall-clock time; a time that does not exist (DST gap) moves to the first one after it. */
export function localInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  for (let step = 0; step < 4 * 60; step += 15) {
    const t = Date.UTC(y, mo - 1, d, h, mi + step);
    const x = new Date(t);
    const ts = instantsOf({ y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() }, tz);
    if (ts[0] !== undefined) return ts[0];
  }
  throw new Error(`no local time near ${y}-${mo}-${d} ${h}:${mi} in ${tz}`);
}

/** The local calendar day (YYYY-MM-DD) of an instant. */
export function localDay(t: number, tz: string): string {
  const l = local(t, tz);
  return `${l.y}-${String(l.mo).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
}
