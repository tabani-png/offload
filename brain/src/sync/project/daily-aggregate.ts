// daily_aggregate: one person-day of workflow activity (runs, successes, device-computed saved seconds for self-view;
// the server recomputes them). Nothing per minute or per app.
import type { DailyAggregate, DailyInput, ProjectionContext } from "../types.ts";

/** hs-1 median (ADR 0109 §1): middle value, or floor of the two middle values' mean. */
export function medianSeconds(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const d = [...values].sort((a, b) => a - b);
  const n = d.length;
  return n % 2 === 1 ? d[(n - 1) / 2]! : Math.floor((d[n / 2 - 1]! + d[n / 2]!) / 2);
}

export function projectDailyAggregate(i: DailyInput, ctx: ProjectionContext): DailyAggregate {
  const workflows = i.workflows.slice(0, 200).map((w) => {
    const base = medianSeconds(w.baselineSeconds);
    // ADR 0109 §3-4, per run: saved = max(0, baseline × items sent − residual); no baseline or no review -> 0.
    let saved = 0;
    for (const r of w.successRuns) if (base !== null && r.residualSeconds !== null) saved += Math.max(0, base * r.sent - r.residualSeconds);
    return { workflowId: w.binding.workflowId, version: w.binding.version, runs: w.runs, successes: w.successRuns.length, savedSecondsDevice: Math.round(saved) };
  });
  return { id: ctx.ids("daily_aggregate", i.day, i.dayEnd), kind: "daily_aggregate", createdAt: i.dayEnd, day: i.day, activeWorkflows: i.activeWorkflows, workflows };
}
