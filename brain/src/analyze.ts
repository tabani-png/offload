// The brain pipeline: store -> spans -> tasks -> stats -> judge + connectors -> ranked insights with savings.
import { connectorsFor, type ConnectorMatch } from "./connectors/catalog.ts";
import { groupTasks, indexSpans, type Labeler } from "./grouping/group.ts";
import { heuristicJudge, type Judge, type JudgeResult } from "./insights/judge.ts";
import { rankingScore, type ScoreFactors } from "./insights/rank.ts";
import { estimateSaving, type SavingEstimate, type SavingSignals } from "./insights/saving.ts";
import { DEFAULT_SESSION_OPTIONS, sessionizeDays, totalActiveMs, type SessionOptions } from "./sessionize.ts";
import { computeTaskStats } from "./stats.ts";
import { readStore, type ReaderEnv, type StoreRead } from "./store/reader.ts";
import type { DayLabel, OffloadEvent, Span, Task, TaskLabel, TaskProfile, TaskStats, UserContext } from "./types.ts";
import type { SpanDescription } from "./understanding/describe.ts";
import { StubEmbedder, type Embedder } from "./understanding/embed.ts";
import { isGenericVerb } from "./understanding/verbs.ts";
import { stepClass } from "./plan/steps.ts";
import { framesFromEvents, mergeFrames, type FrameNote } from "./understanding/frames.ts";
import { understandingJudge } from "./understanding/labeler.ts";
import { understandSpans } from "./understanding/pipeline.ts";
import { connectorsForReach } from "./understanding/reach.ts";
import { sanitizeUserContext } from "./understanding/context.ts";
import { windowFrameNotes } from "./understanding/notes-source.ts";

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
  /** Also the reader's clock: days older than 7 local days at now() are refused. */
  now?: () => number;
  /** Reader environment (OFFLOAD_OBSERVER_BIN, OFFLOAD_KEYS). Default process.env. */
  env?: ReaderEnv;
  /** s12: "v1" (default until s15) = app/host rule grouping; "v2" = span descriptions + local embeddings + induction. */
  understanding?: "v1" | "v2";
  /** v2: local embedder. Default StubEmbedder (deterministic, offline); the CLI offers Ollama. */
  embedder?: Embedder;
  /** v2: frame notes. Default: notes among the store's events plus the fixture sidecar (analyzeHome). */
  frames?: readonly FrameNote[];
  /** Optional onboarding context {role, industry}: passed to the labeler and judge as context only. */
  userContext?: UserContext;
  /** s14 (set by analyzeHome): notes per source and invalid notes found by the readers. */
  framesBySource?: { events: number; sidecar: number; store: number };
  invalidFrames?: number;
}

export interface UnderstandingInfo {
  version: "v2";
  embedder: string;
  framesRead: number;
  framesUsed: number;
  invalidFrames: number;
  descriptions: SpanDescription[];
  /** s14: the notes used (masked text only) and the span -> induced step map, for the workflow builder and dry run. */
  frames: FrameNote[];
  stepOf: Map<string, string>;
  /** s14: where the notes came from (analyzeHome; zeros when the caller passed frames). */
  framesBySource: { events: number; sidecar: number; store: number };
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
  /** v2 only. */
  understanding?: UnderstandingInfo;
  /** s22 (additive): tasks that repeat enough but the judge holds back (a person is at the keyboard, e.g. watching a
   * coding agent). Not insights and not ranked; the solution designer still proposes setup or tool fixes for them. */
  heldBack?: HeldBackTask[];
}

/** s20: what makes a task's saving low-confidence: its share, how many apps it spans, how much of it is only "looking". */
export function savingSignals(p: TaskProfile, share: number): SavingSignals {
  const u = p.understanding;
  if (u === undefined) return { share };
  const total = u.steps.reduce((n, s) => n + s.activeMs, 0);
  const generic = u.steps.filter((s) => isGenericVerb(s.verb)).reduce((n, s) => n + s.activeMs, 0);
  const surfaces = new Set(u.surfaces.map((s) => `${s.app}|${s.host}`)).size;
  // s20 review: no text or record write anywhere = the plan can only read and ask (no saving is claimed for it).
  const readOnly = u.steps.length > 0 && u.steps.every((s) => stepClass(s) !== "text" && stepClass(s) !== "record");
  return { share, surfaces, genericShare: total === 0 ? 0 : generic / total, ...(readOnly ? { readOnly } : {}) };
}

export type HeldBackTask = Omit<Insight, "rank"> & { heldBack: { reason: string } };

export const insightIdFor = (taskId: string) => `ins_${taskId.replace(/^t_/, "")}`;

export async function analyzeStore(store: StoreRead, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const minInstances = opts.minInstances ?? 3;
  const minSaved = opts.minWeeklyHoursSaved ?? 0.25;
  const maxJudgement = opts.maxJudgement ?? 0.8;
  const windowDays = store.days.map((d) => d.day);
  // Days are sessionized in order so the last focus of a day carries into the next one (REVIEW-1 L4).
  const spans = sessionizeDays(store.days, opts.session ?? DEFAULT_SESSION_OPTIONS);
  const spansById = indexSpans(spans);
  const total = totalActiveMs(spans);
  const user = sanitizeUserContext(opts.userContext);
  let tasks: Task[];
  let understanding: UnderstandingInfo | undefined;
  if (opts.understanding === "v2") {
    const fromEvents = framesFromEvents(store.days.flatMap((d) => d.events));
    const frames = mergeFrames(opts.frames ?? [], fromEvents.frames);
    const embedder = opts.embedder ?? new StubEmbedder();
    const u = await understandSpans(spans, { frames, embedder, ...(opts.labeler === undefined ? {} : { labeler: opts.labeler }), ...(user === undefined ? {} : { user }) });
    tasks = u.tasks;
    understanding = { version: "v2", embedder: u.embedder, framesRead: frames.length, framesUsed: u.framesUsed, invalidFrames: fromEvents.invalid + (opts.invalidFrames ?? 0), descriptions: u.descriptions, frames, stepOf: u.induction.stepOf, framesBySource: opts.framesBySource ?? { events: fromEvents.frames.length, sidecar: 0, store: 0 } };
  } else {
    tasks = await groupTasks(spans, { ...(opts.labeler === undefined ? {} : { labeler: opts.labeler }), ...(user === undefined ? {} : { user }) });
  }
  const judge = opts.judge ?? (opts.understanding === "v2" ? understandingJudge : heuristicJudge);

  const taskOfSpan = new Map<string, string>();
  const stats = new Map<string, TaskStats>();
  for (const t of tasks) {
    for (const sid of t.spanIds) taskOfSpan.set(sid, t.id);
    stats.set(t.id, computeTaskStats(t, { totalActiveMs: total, windowDays, spansById }));
  }

  const candidates: Omit<Insight, "rank">[] = [];
  const heldBack: HeldBackTask[] = [];
  for (const t of tasks) {
    const st = stats.get(t.id);
    if (st === undefined || st.instances.value < minInstances) continue;
    const verdict = await judge.judge({ profile: t.profile, sameness: st.sameness.value, ...(user === undefined ? {} : { user }) });
    const connectors = t.profile.understanding === undefined ? connectorsFor(t.profile) : connectorsForReach(t.profile.understanding.reach);
    if (verdict.judgement >= maxJudgement) {
      heldBack.push(heldBackTask(t, st, verdict, connectors, windowDays.length, opts.reviewSeconds));
      continue;
    }
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
      { instances: st.instances.value, daysActive: st.daysActive.value, windowDays: Math.max(1, windowDays.length), medianMinutes: st.medianMinutes.value, eventIds: st.instances.eventIds, activeMinutes: st.activeMinutes.value, signals: savingSignals(t.profile, st.share.value) },
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
    ...(understanding === undefined ? {} : { understanding }),
    heldBack: heldBack.sort((a, b) => b.stats.activeMinutes.value - a.stats.activeMinutes.value || (a.id < b.id ? -1 : 1)),
  };
}

function heldBackTask(t: Task, st: TaskStats, verdict: JudgeResult, connectors: ConnectorMatch, windowDays: number, reviewSeconds: number | undefined): HeldBackTask {
  const factors: ScoreFactors = { volume: st.share.value, sameness: st.sameness.value, reachability: connectors.reachability, judgement: verdict.judgement, risk: verdict.risk };
  const saving = estimateSaving(
    { instances: st.instances.value, daysActive: st.daysActive.value, windowDays: Math.max(1, windowDays), medianMinutes: st.medianMinutes.value, eventIds: st.instances.eventIds },
    reviewSeconds === undefined ? {} : { reviewSeconds },
  );
  return { id: insightIdFor(t.id), taskId: t.id, label: t.label, profile: t.profile, stats: st, judge: verdict, connectors, score: { value: rankingScore(factors), factors }, saving, heldBack: { reason: verdict.reasons[0] ?? "needs a person" } };
}

export async function analyzeHome(home: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const now = (opts.now ?? Date.now)();
  const store = readStore(home, { windowDays: opts.windowDays ?? 7, now, ...(opts.env === undefined ? {} : { env: opts.env }) });
  if (opts.understanding !== "v2" || opts.frames !== undefined) return analyzeStore(store, opts);
  // v2 (s14): notes from store events, the fixture sidecar (frames/<day>.jsonl[.enc]) and the s11 caption worker's
  // sealed notes store (frame-notes/<day>.jsonl.enc), merged by id.
  const notes = windowFrameNotes(home, store.days, now, opts.env ?? process.env);
  for (const e of notes.errors) console.error(`brain: ${e}`);
  return analyzeStore(store, { ...opts, frames: notes.frames, framesBySource: notes.bySource, invalidFrames: notes.invalid });
}
