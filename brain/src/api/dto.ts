// Analysis -> public JSON shapes (src/api/types.ts). Formatting lives here; numbers come from the pipeline untouched.
import type { UnderstandingStatusDTO } from "./s14-types.ts";
import type { Analysis, Insight } from "../analyze.ts";
import type { Connector } from "../connectors/catalog.ts";
import type { DayLabel, Figure, Span, TaskStats, TaskUnderstanding } from "../types.ts";
import {
  API_VERSION,
  CAPTIONER_OFF,
  type CaptionerStatusDTO,
  type ConnectorDTO,
  type DashboardResponse,
  type EvidenceResponse,
  type FigureDTO,
  type FigureName,
  type InsightDTO,
  type InsightUnderstandingDTO,
  type InsightsResponse,
  type ObserverState,
  type SpanDTO,
  type StatusResponse,
  type TimelineResponse,
} from "./types.ts";

const RECORDING_WINDOW_MS = 5 * 60_000;
export const KEEP_DAYS = 7;

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

function display(f: Figure): string {
  switch (f.unit) {
    case "ratio":
      return `${(f.value * 100).toFixed(1)}%`;
    case "minutes":
      return `${f.value.toFixed(1)} min`;
    case "per_day":
      return `${round(f.value, 1)}/day`;
    case "days":
      return `${f.value} ${f.value === 1 ? "day" : "days"}`;
    case "score":
      return f.value.toFixed(2);
    case "count":
      return String(f.value);
  }
}

function figure(f: Figure): FigureDTO {
  return { value: f.value, unit: f.unit, display: display(f), eventCount: f.eventIds.length };
}

export function connectorDTO(c: Connector, role: ConnectorDTO["role"]): ConnectorDTO {
  return { id: c.id, name: c.name, how: c.how, reach: c.reach, role, ...(c.limits === undefined ? {} : { limits: c.limits }) };
}

export function insightConnectors(i: Insight): ConnectorDTO[] {
  return [...(i.connectors.primary === null ? [] : [connectorDTO(i.connectors.primary, "primary")]), ...i.connectors.also.map((c) => connectorDTO(c, "also"))];
}

function statFigures(s: TaskStats): Record<Exclude<FigureName, "saving">, Figure> {
  return {
    instances: s.instances,
    daysActive: s.daysActive,
    instancesPerDay: s.instancesPerDay,
    medianMinutes: s.medianMinutes,
    p90Minutes: s.p90Minutes,
    activeMinutes: s.activeMinutes,
    share: s.share,
    sameness: s.sameness,
  };
}

function insightDTO(a: Analysis, i: Insight): InsightDTO {
  const task = a.tasks.find((t) => t.id === i.taskId);
  const figs = statFigures(i.stats);
  const figures = Object.fromEntries(Object.entries(figs).map(([k, f]) => [k, figure(f)])) as Record<Exclude<FigureName, "saving">, FigureDTO>;
  const s = i.saving;
  return {
    id: i.id,
    rank: i.rank,
    taskId: i.taskId,
    kind: i.label.kind,
    name: i.label.name,
    description: i.label.description,
    category: i.profile.category,
    app: { bundleId: i.profile.app, name: i.profile.appName, host: i.profile.host },
    template: i.profile.template,
    figures,
    saving: {
      weeklyItems: s.weeklyItems,
      weeklyHoursNow: s.weeklyHoursNow,
      weeklyHoursAfter: s.weeklyHoursAfter,
      weeklyHoursSaved: s.weeklyHoursSaved,
      savingPct: s.savingPct,
      reviewSecondsPerItem: s.reviewSecondsPerItem,
      range: { low: { ...s.range.low }, high: { ...s.range.high } },
      arithmetic: s.arithmetic,
      assumptions: [...s.assumptions],
    },
    score: { value: i.score.value, formula: "volume × sameness × reachability × (1 − judgement) × (1 − risk/2)", factors: { ...i.score.factors } },
    judge: { judgement: i.judge.judgement, risk: i.judge.risk, reasons: [...i.judge.reasons] },
    connectors: insightConnectors(i),
    identifiers: {
      counterpartyCount: i.profile.identifiers.counterparties.length,
      domainCount: i.profile.identifiers.domains.length,
      topDomains: topDomains(task?.instances.flatMap((x) => x.identifiers.domains) ?? [], 5),
    },
    keywords: [...i.profile.ocrKeywords],
    examples: (task?.instances ?? []).slice(0, 3).map((inst) => ({
      instanceId: inst.id,
      day: inst.day,
      start: inst.start,
      minutes: inst.activeMs / 60_000,
      title: a.spansById.get(inst.spanIds[0] ?? "")?.title ?? "",
    })),
    ...(i.profile.understanding === undefined ? {} : { understanding: understandingDTO(i.profile.understanding) }),
  };
}

/** s12 (additive): the induced task model, without span lists or identifier values beyond the item count. */
function understandingDTO(u: TaskUnderstanding): InsightUnderstandingDTO {
  return {
    goal: u.goal,
    steps: u.steps.map((s) => ({ id: s.id, name: s.name, verb: s.verb, object: s.object, surface: s.surface, app: s.app, host: s.host, perInstance: s.perInstance, repeatsPerInstance: s.repeatsPerInstance, core: s.core })),
    loop: [...u.loop],
    surfaces: u.surfaces.map((s) => ({ ...s })),
    reach: { value: u.reach.value, perSurface: u.reach.perSurface.map((s) => ({ app: s.app, host: s.host, via: s.via, connectorId: s.connectorId, reach: s.reach })) },
    identifiers: { items: u.identifiers.items, containers: [...u.identifiers.containers] },
  };
}

function topDomains(domains: readonly string[], k: number): string[] {
  const n = new Map<string, number>();
  for (const d of domains) n.set(d, (n.get(d) ?? 0) + 1);
  return [...n.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, k)
    .map(([d]) => d);
}

export function spanDTO(a: Analysis, s: Span): SpanDTO {
  return {
    id: s.id,
    day: s.day,
    start: s.start,
    end: s.end,
    activeMinutes: s.activeMs / 60_000,
    app: s.app,
    appName: s.appName,
    title: s.title,
    host: s.host,
    taskId: a.taskOfSpan.get(s.id) ?? null,
    eventIds: [...s.eventIds],
  };
}

export function toInsights(a: Analysis): InsightsResponse {
  return {
    version: API_VERSION,
    generatedAt: a.generatedAt,
    window: { days: [...a.windowDays], activeMinutes: a.totalActiveMs / 60_000, events: a.events.length },
    insights: a.insights.map((i) => insightDTO(a, i)),
  };
}

export function toEvidence(a: Analysis, insight: Insight): EvidenceResponse {
  const task = a.tasks.find((t) => t.id === insight.taskId);
  const figs = statFigures(insight.stats);
  const figures = Object.fromEntries(Object.entries(figs).map(([k, f]) => [k, { eventIds: [...f.eventIds] }])) as Record<Exclude<FigureName, "saving">, { eventIds: string[] }>;
  return {
    version: API_VERSION,
    insightId: insight.id,
    taskId: insight.taskId,
    figures: { ...figures, saving: { eventIds: [...insight.saving.eventIds] } },
    instances: (task?.instances ?? []).map((i) => ({
      id: i.id,
      day: i.day,
      start: i.start,
      end: i.end,
      activeMinutes: i.activeMs / 60_000,
      spanIds: [...i.spanIds],
      counterparties: [...i.identifiers.counterparties],
    })),
    spans: (task?.spanIds ?? []).map((id) => a.spansById.get(id)).filter((s): s is Span => s !== undefined).map((s) => spanDTO(a, s)),
  };
}

export function toTimeline(a: Analysis, day: DayLabel): TimelineResponse {
  const spans = a.spans.filter((s) => s.day === day).sort((x, y) => x.start - y.start);
  const byTask = new Map<string, number>();
  for (const s of spans) {
    const t = a.taskOfSpan.get(s.id);
    if (t !== undefined) byTask.set(t, (byTask.get(t) ?? 0) + s.activeMs / 60_000);
  }
  return {
    version: API_VERSION,
    day,
    activeMinutes: spans.reduce((n, s) => n + s.activeMs, 0) / 60_000,
    spans: spans.map((s) => spanDTO(a, s)),
    byTask: [...byTask.entries()]
      .map(([taskId, minutes]) => {
        const task = a.tasks.find((t) => t.id === taskId);
        return { taskId, name: task?.label.name ?? taskId, kind: task?.label.kind ?? "unknown", minutes };
      })
      .sort((x, y) => y.minutes - x.minutes),
  };
}

export function toDashboard(a: Analysis): DashboardResponse {
  return {
    version: API_VERSION,
    automations: [],
    totals: { estimatedHoursSavedPerWeek: 0, measuredHoursSavedPerWeek: null },
    suggestions: a.insights.slice(0, 3).map((i) => ({ insightId: i.id, name: i.label.name, weeklyHoursSaved: i.saving.weeklyHoursSaved })),
  };
}

function localMidnightAfter(day: DayLabel, addDays: number): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + addDays).getTime();
}

export function toStatus(a: Analysis, now: number, captioner: CaptionerStatusDTO = CAPTIONER_OFF): StatusResponse & { understanding: UnderstandingStatusDTO } {
  let last: { ts: number; kind: string } | null = null;
  for (const e of a.events) if (last === null || e.ts >= last.ts) last = { ts: e.ts, kind: e.kind };
  let state: ObserverState = "no_data";
  if (last !== null) state = last.kind === "pause" ? "paused" : now - last.ts <= RECORDING_WINDOW_MS ? "recording" : "stale";
  const oldest = a.store.days[0]?.day ?? null;
  return {
    version: API_VERSION,
    observer: { state, lastEventAt: last?.ts ?? null },
    store: {
      days: a.store.days.map((d) => ({ day: d.day, source: d.source, events: d.events.length, badLines: d.bad.length, errors: [...d.errors] })),
      events: a.store.eventCount,
      badLines: a.store.badLineCount,
    },
    retention: { keepDays: KEEP_DAYS, nextPurgeDay: oldest, nextPurgeAt: oldest === null ? null : localMidnightAfter(oldest, KEEP_DAYS + 1) },
    analysis: { generatedAt: a.generatedAt, windowDays: [...a.windowDays], tasks: a.tasks.length, insights: a.insights.length },
    captioner: { ...captioner },
    // s14 (additive): which task finder ran, so the app can say when the simpler one is in use.
    understanding: understandingStatus(a),
  };
}

export function understandingStatus(a: Analysis): UnderstandingStatusDTO {
  return a.understanding === undefined ? { version: "v1", embedder: null, framesRead: 0 } : { version: "v2", embedder: a.understanding.embedder, framesRead: a.understanding.framesRead };
}
