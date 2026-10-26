// Golden inputs for packages/hours-saved built from the objects the test devices sent (not from the database), so an
// endpoint answer can be compared with the package's answer on the same rows.
import {
  periodBoundsUtc,
  type BaselineSample,
  type ReportInput,
  type ReviewEvent,
  type RunInput,
  type RunOutcome,
  type Scope,
} from "../../../packages/hours-saved/src/index.ts";

export interface Sender {
  personId: string;
  departmentId: string | null;
  jobRoleId: string | null;
  objects: Array<Record<string, unknown>>;
}

export interface GoldenOpts {
  period: { from: string; toExclusive: string };
  timezone?: string;
  /** Only these people's runs (person scope). */
  personId?: string;
  workflow?: { workflowId: string; version: number };
}

/** What S2-05 must feed hs-1: runs ending in the period (latest per runId), their reviews, and every baseline sample of
 * the workflow versions those runs used. */
export function goldenInputs(senders: readonly Sender[], o: GoldenOpts): Pick<ReportInput, "runs" | "reviews" | "samples"> {
  const tz = o.timezone ?? "UTC";
  const { startMs, endMsExclusive } = periodBoundsUtc(o.period, tz);
  const runs = new Map<string, RunInput>();
  for (const s of senders) {
    for (const obj of s.objects) {
      if (obj.kind !== "run_outcome") continue;
      const run = obj as unknown as RunOutcome;
      if (run.endedAt < startMs || run.endedAt >= endMsExclusive) continue;
      if (o.personId !== undefined && s.personId !== o.personId) continue;
      if (o.workflow && (run.workflowId !== o.workflow.workflowId || run.version !== o.workflow.version)) continue;
      // Later objects for the same run replace earlier ones (ADR 0111 §4).
      runs.set(run.runId, { run, personId: s.personId, departmentId: s.departmentId, jobRoleId: s.jobRoleId });
    }
  }
  const runIds = new Set(runs.keys());
  const keys = new Set([...runs.values()].map((r) => `${r.run.workflowId}@${r.run.version}`));
  const reviews: ReviewEvent[] = [];
  const samples: BaselineSample[] = [];
  for (const s of senders) {
    for (const obj of s.objects) {
      if (obj.kind === "review_event" && runIds.has(obj.runId as string)) reviews.push(obj as unknown as ReviewEvent);
      if (obj.kind === "baseline_sample" && keys.has(`${obj.workflowId}@${obj.version}`)) samples.push(obj as unknown as BaselineSample);
    }
  }
  return { runs: [...runs.values()], reviews, samples };
}

export function goldenReport(senders: readonly Sender[], scope: Scope, children: ReportInput["children"], o: GoldenOpts & { floor?: number }): ReportInput {
  return {
    ...goldenInputs(senders, o),
    estimates: [],
    workflows: [],
    scope,
    children,
    period: o.period,
    timezone: o.timezone ?? "UTC",
    floor: o.floor ?? 5,
  };
}
