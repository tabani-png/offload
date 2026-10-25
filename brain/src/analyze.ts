// The brain pipeline: store -> spans -> tasks -> stats -> judge + connectors -> ranked insights with savings.
import { connectorsFor, type ConnectorMatch } from "./connectors/catalog.ts";
import { groupTasks, indexSpans, type Labeler } from "./grouping/group.ts";
import { heuristicJudge, type Judge, type JudgeResult } from "./insights/judge.ts";
import { rankingScore, type ScoreFactors } from "./insights/rank.ts";
import { estimateSaving, type SavingEstimate } from "./insights/saving.ts";
import { DEFAULT_SESSION_OPTIONS, sessionize, totalActiveMs, type SessionOptions } from "./sessionize.ts";
import { computeTaskStats } from "./stats.ts";
import { readStore, type StoreRead } from "./store/reader.ts";
import type { DayLabel, OffloadEvent, Span, Task, TaskLabel, TaskProfile, TaskStats } from "./types.ts";

export interface AnalyzeOptions {
  windowDays?: number;
  reviewSeconds?: number;
  labeler?: Labeler;
  judge?: Judge;
  /** Tasks with fewer instances are not offered as insights. Default 3. */
  minInstances?: number;
  /** Tasks judged at or above this judgement (live calls, engineering) need a human and are not offered. Default 0.8. */
  maxJudgement?: number;
  /** Insights whose estimated saving is below this (h/wk) are not offered: nothing to win. Default 0.25. */
  minWeeklyHoursSaved?: number;
  session?: SessionOptions;
  now?: () => number;
}

export interface Insight {
  id: string;
  rank: number;
  taskId: string;
  label: TaskLabel;
  profile: TaskProfile;
  stats: TaskStats;
  judge: JudgeResult;
  connectors: ConnectorMatch;
  score: { value: number; factors: ScoreFactors };
  saving: SavingEstimate;
}

export interface Analysis {
  generatedAt: number;
  store: StoreRead;
  windowDays: DayLabel[];
  events: OffloadEvent[];
  spans: Span[];
  spansById: Map<string, Span>;
  tasks: Task[];
  taskOfSpan: Map<string, string>;
  stats: Map<string, TaskStats>;
  insights: Insight[];
  totalActiveMs: number;
}

export const insightIdFor = (taskId: string) => `ins_${taskId.replace(/^t_/, "")}`;

export async function analyzeStore(store: StoreRead, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const judge = opts.judge ?? heuristicJudge;
  const minInstances = opts.minInstances ?? 3;
  const minSaved = opts.minWeeklyHoursSaved ?? 0.25;
  const maxJudgement = opts.maxJudgement ?? 0.8;
  const windowDays = store.days.map((d) => d.day);
  const spans = store.days.flatMap((d) => sessionize(d.events, d.day, opts.session ?? DEFAULT_SESSION_OPTIONS));
  const spansById = indexSpans(spans);
  const total = totalActiveMs(spans);
  const tasks = await groupTasks(spans, opts.labeler === undefined ? {} : { labeler: opts.labeler });

  const taskOfSpan = new Map<string, string>();
  const stats = new Map<string, TaskStats>();
  for (const t of tasks) {
    for (const sid of t.spanIds) taskOfSpan.set(sid, t.id);
    stats.set(t.id, computeTaskStats(t, { totalActiveMs: total, windowDays, spansById }));
  }

  const candidates: Omit<Insight, "rank">[] = [];
  for (const t of tasks) {
    const st = stats.get(t.id);
    if (st === undefined || st.instances.value < minInstances) continue;
    const verdict = await judge.judge({ profile: t.profile, sameness: st.sameness.value });
    if (verdict.judgement >= maxJudgement) continue;
    const connectors = connectorsFor(t.profile);
    const factors: ScoreFactors = {
      volume: st.share.value,
      sameness: st.sameness.value,
      reachability: connectors.reachability,
      judgement: verdict.judgement,
      risk: verdict.risk,
    };
    const value = rankingScore(factors);
    if (value <= 0) continue;
    const saving = estimateSaving(
      { instances: st.instances.value, daysActive: st.daysActive.value, windowDays: Math.max(1, windowDays.length), medianMinutes: st.medianMinutes.value, eventIds: st.instances.eventIds },
      opts.reviewSeconds === undefined ? {} : { reviewSeconds: opts.reviewSeconds },
    );
    if (saving.weeklyHoursSaved < minSaved) continue;
    candidates.push({ id: insightIdFor(t.id), taskId: t.id, label: t.label, profile: t.profile, stats: st, judge: verdict, connectors, score: { value, factors }, saving });
  }
  candidates.sort((a, b) => b.score.value - a.score.value || (a.id < b.id ? -1 : 1));

  return {
    generatedAt: (opts.now ?? Date.now)(),
    store,
    windowDays,
    events: store.days.flatMap((d) => d.events),
    spans,
    spansById,
    tasks,
    taskOfSpan,
    stats,
    insights: candidates.map((c, i) => ({ ...c, rank: i + 1 })),
    totalActiveMs: total,
  };
}

export async function analyzeHome(home: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
  return analyzeStore(readStore(home, { windowDays: opts.windowDays ?? 7 }), opts);
}
