// Workflow schedules: the next due time of a 5-field cron expression in local time (s05c nextRunAt).
// Fields: minute 0-59, hour 0-23, day of month 1-31, month 1-12, day of week 0-7 (0 and 7 = Sunday). Each field is
// `*`, a number, a range a-b, a list, or a step (`*/n`, `a-b/n`). When both day fields are restricted, either one
// matching is enough (Vixie cron). No names (MON, JAN) and no `?`/`L`/`W`.
// The brain computes when a schedule is due; it does not fire it (nothing runs a workflow on its own yet).

interface Field {
  set: Set<number>;
  any: boolean;
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

function field(text: string, min: number, max: number): Field | null {
  if (text === "") return null;
  const set = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (m === null) return null;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, any: text === "*" };
}

/** null when the expression is not a valid 5-field cron. */
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const minute = field(mi, 0, 59);
  const hour = field(h, 0, 23);
  const d = field(dom, 1, 31);
  const month = field(mo, 1, 12);
  const w = field(dow, 0, 7);
  if (minute === null || hour === null || d === null || month === null || w === null) return null;
  if (w.set.has(7)) w.set.add(0);
  return { minute, hour, dom: d, month, dow: w };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.set.has(d.getDate());
  const dow = c.dow.set.has(d.getDay());
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dow;
  if (c.dow.any) return dom;
  return dom || dow;
}

/** Search horizon: a schedule that is not due within 5 years (e.g. Feb 30) has no next run. */
const MAX_DAYS = 366 * 5;

/** First due minute strictly after `after` (epoch ms), local time; null for an invalid or never-due expression. */
export function nextCronRun(expr: string, after: number): number | null {
  const c = parseCron(expr);
  if (c === null) return null;
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < MAX_DAYS; i++) {
    if (c.month.set.has(day.getMonth() + 1) && dayMatches(c, day)) {
      for (let h = 0; h < 24; h++) {
        if (!c.hour.set.has(h)) continue;
        for (let m = 0; m < 60; m++) {
          if (!c.minute.set.has(m)) continue;
          // new Date(y, mo, d, h, m) normalises DST gaps; the time must still be after the start.
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
          if (t >= start.getTime()) return t;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}
