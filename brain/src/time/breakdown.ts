// s23: where the time went (by task, by app, by kind of work) and what could be faster, all computed in code from
// the analysis (ADR 0005: every number links to its events; no model call). Reads spans, never content (ADR 0003).
// Drafts nothing (ADR 0006): a finding may point at an insight a workflow could answer; it never creates one.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Analysis, Insight } from "../analyze.ts";
import type { TimeBreakdownResponse, TimeFinding, TimeFixKind, TimeMetric, TimeRow } from "../api/types.ts";
import type { DayLabel, Span } from "../types.ts";
import { formatHours } from "./format.ts";
import { kindOfSpan, WORK_KIND_NAMES, WORK_KINDS } from "./kinds.ts";

/** The fix kinds s22 ranks. Anything else from a fix source is shown as no fix kind, never guessed. */
export const FIX_KINDS: readonly TimeFixKind[] = ["workflow", "tool", "setup", "remove_step", "leave_alone"];

/** A fix source: the best kind of fix for an insight and the hours it saves a week (s22's top option), or null. */
export type FixOf = (insight: Insight) => Promise<{ kind: TimeFixKind; weeklyHoursSaved: number } | null>;

export interface TimeOptions {
  /** One stored day; omitted = the analysis window (the week). */
  day?: DayLabel;
  /** null = no fix source (s22 absent); undefined = s22's rules when brain/src/solutions is present, else none. */
  fixOf?: FixOf | null;
}

export const UNSORTED_ID = "unsorted";
const UNSORTED_NAME = "Not grouped";

const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

function minutesMetric(minutes: number, eventIds: Iterable<string>): TimeMetric {
  return { value: minutes, unit: "minutes", display: formatHours(minutes / 60), eventIds: sortedIds(eventIds) };
}

function weeklyMetric(hours: number, eventIds: readonly string[]): TimeMetric {
  return { value: hours, unit: "hours_per_week", display: formatHours(hours), eventIds: [...eventIds] };
}

/** Groups spans into rows: minutes and event ids recomputed from each row's own spans, most minutes first, ties by id. */
function rowsOf(spans: readonly Span[], total: number, keyOf: (s: Span) => string, nameOf: (key: string, first: Span) => string): TimeRow[] {
  const groups = new Map<string, Span[]>();
  for (const s of spans) {
    const k = keyOf(s);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [s]);
    else list.push(s);
  }
  const rows: TimeRow[] = [];
  for (const [id, list] of groups) {
    const minutes = list.reduce((n, s) => n + s.activeMs, 0) / 60_000;
    rows.push({
      id,
      name: nameOf(id, list[0]!),
      minutes: minutesMetric(minutes, list.flatMap((s) => s.eventIds)),
      share: total > 0 ? minutes / total : 0,
      spanIds: list.map((s) => s.id),
    });
  }
  return rows.sort((a, b) => b.minutes.value - a.minutes.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Task names for the rows. Two tasks with one label name ("Calls in Google Chrome") are told apart by their masked
 * title template ("Calls in Google Chrome · Meet - Design review"), which is metadata the grouping already uses. */
function taskNames(a: Analysis): Map<string, string> {
  const count = new Map<string, number>();
  for (const t of a.tasks) count.set(t.label.name, (count.get(t.label.name) ?? 0) + 1);
  return new Map(a.tasks.map((t) => {
    const name = t.label.name;
    const template = t.profile.template.trim();
    return [t.id, (count.get(name) ?? 0) > 1 && template !== "" && !name.includes(template) ? `${name} · ${template}` : name];
  }));
}

let s22Loaded: Promise<((a: Analysis) => FixOf) | null> | undefined;

/** s22's rules (no model): the top option of the solution set, as GET /insights/:id/solutions ranks it. */
function s22FixSource(): Promise<((a: Analysis) => FixOf) | null> {
  s22Loaded ??= (async () => {
    if (!existsSync(join(import.meta.dir, "../solutions/service.ts"))) return null;
    const { solutionsFor } = await import("../solutions/service.ts");
    return (a: Analysis): FixOf =>
      async (insight) => {
        const set = solutionsFor(a, insight);
        const top = set.options.find((o) => o.kind === set.top);
        return top === undefined ? null : { kind: set.top, weeklyHoursSaved: top.weeklyHoursSaved };
      };
  })();
  return s22Loaded;
}

const fixKindOf = (kind: unknown): TimeFixKind | null => (typeof kind === "string" && (FIX_KINDS as readonly string[]).includes(kind) ? (kind as TimeFixKind) : null);

export async function timeBreakdown(a: Analysis, opts: TimeOptions = {}): Promise<TimeBreakdownResponse> {
  const day = opts.day;
  const spans = day === undefined ? a.spans : a.spans.filter((s) => s.day === day);
  const days = day === undefined ? [...a.windowDays].sort() : [day];
  const totalMinutes = spans.reduce((n, s) => n + s.activeMs, 0) / 60_000;
  const total = minutesMetric(totalMinutes, spans.flatMap((s) => s.eventIds));

  const taskName = taskNames(a);
  const byTask = rowsOf(spans, totalMinutes, (s) => a.taskOfSpan.get(s.id) ?? UNSORTED_ID, (id) => taskName.get(id) ?? UNSORTED_NAME);
  const byApp = rowsOf(spans, totalMinutes, (s) => s.app, (_id, first) => first.appName || first.app);
  const byKind = rowsOf(spans, totalMinutes, (s) => kindOfSpan(s), (id) => WORK_KIND_NAMES[id as (typeof WORK_KINDS)[number]]);

  let fixOf: FixOf | null;
  if (opts.fixOf === undefined) {
    const s22 = await s22FixSource();
    fixOf = s22 === null ? null : s22(a);
  } else fixOf = opts.fixOf;

  const rowOfTask = new Map(byTask.map((r) => [r.id, r]));
  const windowDays = Math.max(1, days.length);
  const findings: Array<TimeFinding & { rank: number }> = [];
  for (const insight of a.insights) {
    const row = rowOfTask.get(insight.taskId);
    if (row === undefined) continue; // the task has no time in this window (a day it did not happen)
    const taskMinutes: TimeMetric = { ...row.minutes, eventIds: [...row.minutes.eventIds] };
    const observed = ((taskMinutes.value / 60) * 7) / windowDays;
    const observedHoursPerWeek = weeklyMetric(observed, taskMinutes.eventIds);
    const answer = fixOf === null ? null : await fixOf(insight);
    const fixKind = answer === null ? null : fixKindOf(answer.kind);
    const estimate = answer === null ? insight.saving.weeklyHoursSaved : answer.weeklyHoursSaved;
    const freed = Math.min(observed, Math.max(0, Number.isFinite(estimate) ? estimate : 0));
    const hoursFreed = weeklyMetric(freed, taskMinutes.eventIds);
    const source = answer === null ? "estimate" : "best fix";
    const est = formatHours(Math.max(0, estimate));
    const seen = windowDays === 7 ? `${taskMinutes.display} in 7 days` : `${taskMinutes.display} in ${windowDays} ${windowDays === 1 ? "day" : "days"} × 7 / ${windowDays}`;
    const arithmetic = `${seen} = ${observedHoursPerWeek.display} a week; ${source} ${est} a week; min(${observedHoursPerWeek.display}, ${est}) = ${hoursFreed.display}`;
    findings.push({
      id: `tf_${insight.id.replace(/^ins_/, "")}`,
      taskId: insight.taskId,
      insightId: insight.id,
      name: taskName.get(insight.taskId) ?? insight.label.name,
      taskMinutes,
      observedHoursPerWeek,
      hoursFreed,
      arithmetic,
      fixKind,
      workflowInsightId: fixKind === null || fixKind === "workflow" ? insight.id : null,
      rank: insight.rank,
    });
  }
  findings.sort((x, y) => y.hoursFreed.value - x.hoursFreed.value || x.rank - y.rank);

  return {
    version: 1,
    window: { kind: day === undefined ? "week" : "day", days },
    total,
    byTask,
    byApp,
    byKind,
    findings: findings.map(({ rank: _rank, ...f }) => f),
    fixKinds: fixOf === null ? "absent" : "s22",
    rounding: "tenths-half-up",
  };
}
