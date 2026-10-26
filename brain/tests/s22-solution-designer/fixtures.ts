// s22 fixtures: repeated tasks built the way the pipeline builds them (spans per instance, v2 steps with a span ->
// step map, stats as Figures, the real s04 saving estimate and the real connector catalog). The designer under test
// gets these as input; nothing in its logic is replaced.
import { connectorsFor, type ConnectorMatch } from "../../src/connectors/catalog.ts";
import { estimateSaving } from "../../src/insights/saving.ts";
import type { SolutionSubject } from "../../src/solutions/types.ts";
import type { Category, Figure, FigureUnit, Task, TaskInstance, TaskProfile, TaskStats, UnderstandingStep } from "../../src/types.ts";

export interface StepSpec {
  verb: string;
  object: string;
  surface: string;
  appName: string;
  host?: string;
  category: Category;
  /** Active minutes per instance. */
  minutes: number;
}

export interface FixtureSpec {
  id: string;
  kind: string;
  name: string;
  category: Category;
  app?: string;
  appName: string;
  host?: string;
  template: string;
  titles?: string[];
  ocr?: string[];
  keysPerMinute: number;
  sameness: number;
  instances: number;
  daysActive: number;
  /** v2 steps (minutes per instance); without them the task is v1 and `minutesPerInstance` is used. */
  steps?: StepSpec[];
  minutesPerInstance?: number;
  judgement: number;
  risk?: number;
  /** Reachability when the connector is not in the catalog (v2 computer use 0.35, none 0). */
  reach?: number;
  heldBack?: string;
}

export interface Fixture {
  subject: SolutionSubject;
  task: Task;
  stepOf: Map<string, string>;
  windowDays: number;
}

const fig = (value: number, unit: FigureUnit, eventIds: string[] = []): Figure => ({ value, unit, eventIds });

export function buildFixture(s: FixtureSpec): Fixture {
  const steps = s.steps ?? [];
  const perInstance = steps.length > 0 ? steps.reduce((n, x) => n + x.minutes, 0) : (s.minutesPerInstance ?? 5);
  const stepOf = new Map<string, string>();
  const instances: TaskInstance[] = [];
  const spanIds: string[] = [];
  const DAY = 86_400_000;
  const base = Date.UTC(2026, 9, 19, 9);
  for (let i = 0; i < s.instances; i++) {
    const day = i % s.daysActive;
    const ids = steps.length > 0 ? steps.map((_, k) => `sp_${s.id}_${i}_${k}`) : [`sp_${s.id}_${i}`];
    steps.forEach((_, k) => stepOf.set(ids[k]!, `st_${s.id}_${k}`));
    spanIds.push(...ids);
    const start = base + day * DAY + i * 3_600_000;
    instances.push({ id: `in_${s.id}_${i}`, taskId: `t_${s.id}`, day: `2026-10-${19 + day}`, spanIds: ids, start, end: start + perInstance * 60_000, activeMs: perInstance * 60_000, eventIds: ids.map((x) => `ev_${x}`), identifiers: { counterparties: [], domains: [] } });
  }
  const uSteps: UnderstandingStep[] = steps.map((x, k) => ({
    id: `st_${s.id}_${k}`,
    name: `${x.verb} ${x.object}`,
    verb: x.verb,
    object: x.object,
    surface: x.surface,
    surfaceKey: `${x.appName}|${x.host ?? ""}`,
    app: x.appName,
    appName: x.appName,
    host: x.host ?? "",
    category: x.category,
    spans: s.instances,
    activeMs: x.minutes * 60_000 * s.instances,
    perInstance: 1,
    repeatsPerInstance: 1,
    meanPosition: k,
    core: true,
  }));
  const profile: TaskProfile = {
    taskId: `t_${s.id}`,
    signature: s.id,
    app: s.app ?? s.appName,
    appName: s.appName,
    host: s.host ?? "",
    urlPattern: "",
    template: s.template,
    category: s.category,
    exampleTitles: s.titles ?? [s.template],
    ocrKeywords: s.ocr ?? [],
    identifiers: { counterparties: [], domains: [] },
    instanceCount: s.instances,
    keysPerMinute: s.keysPerMinute,
    schedulingShare: 0,
    ...(steps.length === 0
      ? {}
      : {
          understanding: {
            version: 2 as const,
            goal: s.name,
            steps: uSteps,
            loop: uSteps.map((x) => x.id),
            startStep: uSteps[0]!.id,
            startSurface: uSteps[0]!.surface,
            identifiers: { items: 0, examples: [], containers: [] },
            counterparts: [],
            surfaces: steps.map((x) => ({ app: x.appName, appName: x.appName, host: x.host ?? "", minutes: x.minutes * s.instances })),
            instanceBoundaries: [],
            evidenceSpanIds: [...spanIds],
            frameIds: [],
            reach: { value: s.reach ?? 0, perSurface: [] },
            sources: { frames: 1, rules: 0 },
          },
        }),
  };
  const eventIds = instances.flatMap((x) => x.eventIds);
  const stats: TaskStats = {
    taskId: profile.taskId,
    instances: fig(s.instances, "count", eventIds),
    daysActive: fig(s.daysActive, "days", eventIds),
    instancesPerDay: fig(s.instances / s.daysActive, "per_day", eventIds),
    medianMinutes: fig(perInstance, "minutes", eventIds),
    p90Minutes: fig(perInstance, "minutes", eventIds),
    activeMinutes: fig(perInstance * s.instances, "minutes", eventIds),
    share: fig(0.3, "ratio", eventIds),
    sameness: fig(s.sameness, "score", eventIds),
    samenessBreakdown: { score: s.sameness, titleSimilarity: s.sameness, stepSimilarity: s.sameness, stepMethod: "ocr" },
  };
  const real = connectorsFor(profile);
  const connectors: ConnectorMatch = s.reach === undefined ? real : { primary: null, also: [], all: [], reachability: s.reach };
  const saving = estimateSaving({ instances: s.instances, daysActive: s.daysActive, windowDays: 7, medianMinutes: perInstance, eventIds });
  const factors = { volume: 0.3, sameness: s.sameness, reachability: connectors.reachability, judgement: s.judgement, risk: s.risk ?? 0.2 };
  const subject: SolutionSubject = {
    id: `ins_${s.id}`,
    taskId: profile.taskId,
    label: { kind: s.kind, name: s.name, description: s.name },
    profile,
    stats,
    judge: { judgement: s.judgement, risk: s.risk ?? 0.2, reasons: [s.heldBack ?? "fixture"] },
    connectors,
    score: { value: 0.1, factors },
    saving,
    ...(s.heldBack === undefined ? {} : { heldBack: { reason: s.heldBack } }),
  };
  return { subject, task: { id: profile.taskId, profile, label: subject.label, instances, spanIds }, stepOf, windowDays: 7 };
}

/** Most of the operator's screen time: watching Claude Code work, approving its prompts, reviewing the diff. */
export const CODING_AGENT: FixtureSpec = {
  id: "agent",
  kind: "task.watch-agent-run",
  name: "Watching the coding agent",
  category: "code",
  app: "com.apple.Terminal",
  appName: "Terminal",
  template: "claude — ~/builds/offload",
  keysPerMinute: 8,
  sameness: 0.7,
  instances: 35,
  daysActive: 5,
  steps: [
    { verb: "watch", object: "agent run", surface: "Claude Code session", appName: "Terminal", category: "code", minutes: 17 },
    { verb: "approve", object: "permission prompt", surface: "Claude Code session", appName: "Terminal", category: "code", minutes: 4 },
    { verb: "review", object: "diff", surface: "Cursor editor", appName: "Cursor", category: "code", minutes: 3 },
  ],
  judgement: 0.8,
  heldBack: "engineering work",
};

/** A LinkedIn post a weekday: write it, generate the image in ChatGPT, fix it in Canva, publish. */
export const LINKEDIN_IMAGE: FixtureSpec = {
  id: "linkedin",
  kind: "task.publish-post",
  name: "LinkedIn posts with an image",
  category: "social",
  appName: "Google Chrome",
  host: "www.linkedin.com",
  template: "Feed | LinkedIn",
  keysPerMinute: 35,
  sameness: 0.55,
  instances: 5,
  daysActive: 5,
  steps: [
    { verb: "write", object: "post", surface: "LinkedIn post editor", appName: "Google Chrome", host: "www.linkedin.com", category: "social", minutes: 18 },
    { verb: "generate", object: "image", surface: "ChatGPT image chat", appName: "Google Chrome", host: "chatgpt.com", category: "browse", minutes: 30 },
    { verb: "edit", object: "image", surface: "Canva design", appName: "Google Chrome", host: "www.canva.com", category: "browse", minutes: 12 },
    { verb: "publish", object: "post", surface: "LinkedIn post editor", appName: "Google Chrome", host: "www.linkedin.com", category: "social", minutes: 6 },
  ],
  judgement: 0.4,
  reach: 0.35,
};

/** Follow-up emails in Gmail: templated replies to people who have not answered. */
export const EMAIL_FOLLOWUP: FixtureSpec = {
  id: "followup",
  kind: "email.replies",
  name: "Follow-up emails",
  category: "email",
  app: "com.google.Chrome",
  appName: "Google Chrome",
  host: "mail.google.com",
  template: "Re: <*> - Gmail",
  titles: ["Re: Following up on our call - Gmail"],
  ocr: ["following", "up", "checking", "in"],
  keysPerMinute: 90,
  sameness: 0.78,
  instances: 60,
  daysActive: 5,
  minutesPerInstance: 4,
  judgement: 0.25,
  risk: 0.5,
};

/** Reading different articles: every visit is new reading. */
export const ONE_OFF_BROWSING: FixtureSpec = {
  id: "browse",
  kind: "web.browsing",
  name: "Browsing articles",
  category: "browse",
  appName: "Google Chrome",
  host: "news.ycombinator.com",
  template: "<*> | Hacker News",
  titles: ["Show HN: a thing | Hacker News", "Ask HN: another | Hacker News"],
  keysPerMinute: 3,
  sameness: 0.2,
  instances: 6,
  daysActive: 4,
  minutesPerInstance: 9,
  judgement: 0.6,
  risk: 0,
};

export const ALL_FIXTURES = { coding: CODING_AGENT, linkedin: LINKEDIN_IMAGE, followup: EMAIL_FOLLOWUP, browsing: ONE_OFF_BROWSING } as const;
