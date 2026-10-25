// s14 model router (ADR 0008): every model call in the brain goes through one place that picks the Claude tier per
// route, escalates on trouble, demotes proven per-item steps, counts tokens and dollars, and enforces a monthly budget.
//   Opus 5.5   "understand the formula": naming/merging task profiles, deciding what a task really is, workflow design,
//              choosing between variants (wording; the choice itself is deterministic, ADR 0005), explaining a failure.
//   Sonnet 5.5 execution: drafting outputs, running workflow steps, tool and computer-use steps (s13), first runs.
//   Haiku 5.5  repeatable, high volume: frame captions, description refinement, classification, and per-item steps
//              once proven (PROVEN_RUNS clean runs without a user edit; any edit, low confidence, schema failure or
//              refusal promotes the step back to Sonnet).
//   Ladder     Haiku -> Sonnet -> Opus on refusal, a cut-off reply, or a failed check (`validate`), with the reason kept.
// Budget: at BUDGET_DEGRADE of the monthly cap, captions move from Haiku to the local Ollama model; at the cap every
// other paid route stops with a needs-you line. Nothing here writes a number into an output or opens a commit gate.
// The ledger on disk ($OFFLOAD_HOME/model-usage.json) holds routes, models, token counts, costs and short reasons only:
// never a prompt, a reply or a key.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, ModelRequest, ModelRole } from "./model.ts";

export type Route = "understand" | "design" | "choose" | "explain" | "execute" | "draft" | "item_step" | "caption" | "refine" | "classify";
export type Tier = "opus" | "sonnet" | "haiku";
export const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus"];

export const TIER_MODELS: Readonly<Record<Tier, string>> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
/** $ per million tokens (claude-api skill model table, cached 2026-10-06). */
export const PRICES: Readonly<Record<string, { input: number; output: number; cacheRead: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface RouteSpec {
  tier: Tier;
  effort: "low" | "medium" | "high";
  /** Opus routes think adaptively; the others leave thinking to the model's default at their effort. */
  adaptiveThinking: boolean;
}

export const ROUTES: Readonly<Record<Route, RouteSpec>> = {
  understand: { tier: "opus", effort: "high", adaptiveThinking: true },
  design: { tier: "opus", effort: "high", adaptiveThinking: true },
  choose: { tier: "opus", effort: "high", adaptiveThinking: true },
  explain: { tier: "opus", effort: "high", adaptiveThinking: true },
  execute: { tier: "sonnet", effort: "medium", adaptiveThinking: false },
  draft: { tier: "sonnet", effort: "medium", adaptiveThinking: false },
  item_step: { tier: "sonnet", effort: "medium", adaptiveThinking: false },
  caption: { tier: "haiku", effort: "low", adaptiveThinking: false },
  refine: { tier: "haiku", effort: "low", adaptiveThinking: false },
  classify: { tier: "haiku", effort: "low", adaptiveThinking: false },
};

/** The route of each existing call site. */
export const ROLE_ROUTES: Readonly<Record<ModelRole, Route>> = {
  draft: "draft",
  bucket: "classify",
  style_card: "classify",
  workflow_design: "design",
  step: "item_step",
  label: "understand",
  refine: "refine",
  explain: "explain",
};

/** Clean runs before a per-item step moves from Sonnet to Haiku. */
export const PROVEN_RUNS = 5;
/** Share of the monthly budget at which captions leave Claude for the local model. */
export const BUDGET_DEGRADE = 0.8;

/** What one backend call returns. */
export interface BackendReply {
  text: string;
  stopReason: "end_turn" | "max_tokens" | "refusal" | "stop_sequence" | "tool_use" | "pause_turn" | string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** The model that answered (a server-side fallback can differ from the one asked). */
  model: string;
}

export interface BackendRequest {
  model: string;
  route: Route;
  /** The caller's role (the stub and the Agent SDK backends branch on it). */
  role: ModelRole;
  system: string;
  prompt: string;
  maxTokens: number;
  effort: RouteSpec["effort"];
  adaptiveThinking: boolean;
}

export interface Backend {
  readonly kind: "api" | "claude-code" | "stub";
  /** Metered = real token counts (the API backend). */
  readonly metered: boolean;
  complete(req: BackendRequest): Promise<BackendReply>;
}

/** Any Model (the stub, the Agent SDK login) as a backend: one text reply, no token counts. */
export class ModelBackend implements Backend {
  readonly metered = false;
  constructor(
    readonly kind: "claude-code" | "stub",
    private readonly model: Model,
  ) {}
  async complete(req: BackendRequest): Promise<BackendReply> {
    const text = await this.model.complete({ role: req.role, model: req.model, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens });
    return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, model: req.model };
  }
}

export class BudgetError extends Error {}
export class RefusalError extends Error {}

export interface Decision {
  at: number;
  route: Route;
  stepKey?: string;
  tiers: Tier[];
  model: string;
  /** Why it left the first tier, one short reason per step up (never content). */
  escalations: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface RouteTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  escalations: number;
}

interface Ledger {
  version: 1;
  month: string;
  routes: Partial<Record<Route, RouteTotals>>;
  models: Record<string, { calls: number; costUsd: number }>;
}

interface StepRecord {
  clean: number;
  tier: "sonnet" | "haiku";
  lastReason: string | null;
}

export interface RouterOptions {
  home: string;
  backend: Backend;
  now?: () => number;
  /** $ per month; null = no cap. Default: models.json `monthlyBudgetUsd`, else OFFLOAD_MONTHLY_BUDGET_USD. */
  monthlyBudgetUsd?: number | null;
  env?: Readonly<Record<string, string | undefined>>;
  /** Model per tier (models.json / env can override). */
  models?: Partial<Record<Tier, string>>;
}

const monthOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function costOf(model: string, u: BackendReply["usage"]): number {
  const p = PRICES[model];
  if (p === undefined) return 0;
  return Math.round(((u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead) / 1_000_000) * 1e6) / 1e6;
}

function writeJson(path: string, v: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readBudget(home: string, env: Readonly<Record<string, string | undefined>>): number | null {
  const p = join(home, "models.json");
  if (existsSync(p)) {
    try {
      const v = (JSON.parse(readFileSync(p, "utf8")) as { monthlyBudgetUsd?: unknown }).monthlyBudgetUsd;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    } catch {
      // models.json is also read by loadModelConfig, which reports a broken file.
    }
  }
  const e = Number(env.OFFLOAD_MONTHLY_BUDGET_USD);
  return env.OFFLOAD_MONTHLY_BUDGET_USD !== undefined && Number.isFinite(e) && e >= 0 ? e : null;
}

export interface RouterSummary {
  backend: Backend["kind"];
  metered: boolean;
  month: string;
  spentUsd: number;
  budgetUsd: number | null;
  /** Captions run on the local model because the budget is nearly spent. */
  captionsLocal: boolean;
  /** Paid routes are stopped: the budget is spent. */
  blocked: boolean;
  needsYou: string | null;
  routes: Partial<Record<Route, RouteTotals & { tier: Tier; model: string }>>;
}

export class ModelRouter {
  private readonly now: () => number;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly budgetOverride: number | null | undefined;
  private readonly tierModels: Record<Tier, string>;
  private readonly decisions: Decision[] = [];

  constructor(private readonly o: RouterOptions) {
    this.now = o.now ?? Date.now;
    this.env = o.env ?? process.env;
    this.budgetOverride = o.monthlyBudgetUsd;
    this.tierModels = { ...TIER_MODELS, ...(o.models ?? {}) };
  }

  get backend(): Backend {
    return this.o.backend;
  }

  private get ledgerPath() {
    return join(this.o.home, "model-usage.json");
  }

  private get stepsPath() {
    return join(this.o.home, "model-router.json");
  }

  budget(): number | null {
    return this.budgetOverride !== undefined ? this.budgetOverride : readBudget(this.o.home, this.env);
  }

  private ledger(): Ledger {
    const month = monthOf(this.now());
    if (existsSync(this.ledgerPath)) {
      try {
        const l = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Ledger;
        if (l.version === 1 && l.month === month) return l;
      } catch {
        // A broken ledger starts the month again rather than stopping every call.
      }
    }
    return { version: 1, month, routes: {}, models: {} };
  }

  spentUsd(): number {
    const l = this.ledger();
    return Math.round(Object.values(l.routes).reduce((n, r) => n + (r?.costUsd ?? 0), 0) * 1e6) / 1e6;
  }

  /** Captions may use Claude: the budget is below BUDGET_DEGRADE of the cap (or there is no cap). */
  captionOnClaude(): boolean {
    const b = this.budget();
    return b === null || this.spentUsd() < b * BUDGET_DEGRADE;
  }

  /** Paid routes stop at the cap. */
  blocked(): boolean {
    const b = this.budget();
    return b !== null && this.spentUsd() >= b;
  }

  /** s13 seam (connectors/computer/claude.ts PickModel): computer-use steps are execution, Sonnet 5.5 unless the tier
   * table says otherwise. Escalation for computer use is the planner's; this only names the model. */
  pickModel(route: "computer.step", _ctx: { targetId: string; turn: number }): string {
    void route;
    return this.modelFor("execute");
  }

  modelFor(route: Route, stepKey?: string): string {
    return this.tierModels[this.startTier(route, stepKey)];
  }

  private steps(): Record<string, StepRecord> {
    if (!existsSync(this.stepsPath)) return {};
    try {
      return (JSON.parse(readFileSync(this.stepsPath, "utf8")) as { steps?: Record<string, StepRecord> }).steps ?? {};
    } catch {
      return {};
    }
  }

  private saveSteps(steps: Record<string, StepRecord>): void {
    mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
    writeJson(this.stepsPath, { version: 1, steps });
  }

  startTier(route: Route, stepKey?: string): Tier {
    if (route === "item_step" && stepKey !== undefined) return this.steps()[stepKey]?.tier ?? "sonnet";
    return ROUTES[route].tier;
  }

  /** The record of one per-item step: a clean run counts toward Haiku; anything else promotes it back to Sonnet. */
  recordStepOutcome(stepKey: string, outcome: { ok: boolean; reason?: string }): StepRecord {
    const steps = this.steps();
    const cur = steps[stepKey] ?? { clean: 0, tier: "sonnet" as const, lastReason: null };
    const next: StepRecord = outcome.ok
      ? { clean: cur.clean + 1, tier: cur.clean + 1 >= PROVEN_RUNS ? "haiku" : cur.tier, lastReason: cur.lastReason }
      : { clean: 0, tier: "sonnet", lastReason: outcome.reason ?? "promoted" };
    steps[stepKey] = next;
    this.saveSteps(steps);
    return next;
  }

  /** s13 / the review screen: the user edited a drafted item of this step: back to Sonnet, count restarts. */
  recordUserEdit(stepKey: string): StepRecord {
    return this.recordStepOutcome(stepKey, { ok: false, reason: "you edited a draft" });
  }

  private record(d: Decision, cacheRead: number): void {
    this.decisions.push(d);
    if (this.decisions.length > 100) this.decisions.shift();
    const l = this.ledger();
    const r = l.routes[d.route] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, escalations: 0 };
    r.calls += 1;
    r.inputTokens += d.inputTokens;
    r.outputTokens += d.outputTokens;
    r.cacheReadTokens += cacheRead;
    r.costUsd = Math.round((r.costUsd + d.costUsd) * 1e6) / 1e6;
    r.escalations += d.escalations.length;
    l.routes[d.route] = r;
    const m = l.models[d.model] ?? { calls: 0, costUsd: 0 };
    m.calls += 1;
    m.costUsd = Math.round((m.costUsd + d.costUsd) * 1e6) / 1e6;
    l.models[d.model] = m;
    mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
    writeJson(this.ledgerPath, l);
  }

  /** Counts a call made outside complete() (the Claude captioner calls the SDK itself). */
  recordUsage(route: Route, model: string, usage: BackendReply["usage"], escalations: string[] = []): Decision {
    const d: Decision = { at: this.now(), route, tiers: [tierOf(model)], model, escalations, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: costOf(model, usage) };
    this.record(d, usage.cacheReadTokens);
    return d;
  }

  recentDecisions(): Decision[] {
    return this.decisions.map((d) => ({ ...d, tiers: [...d.tiers], escalations: [...d.escalations] }));
  }

  /** One routed completion with the escalation ladder. Throws BudgetError at the cap, RefusalError when every tier
   * declines. A failed `validate` on the top tier returns that reply: the caller's own fallback decides. */
  async complete(req: ModelRequest): Promise<string> {
    const route = req.route ?? ROLE_ROUTES[req.role];
    if (this.blocked() && this.o.backend.metered) throw new BudgetError("the monthly Claude budget is spent; raise it in Settings or wait for next month");
    const spec = ROUTES[route];
    const start = this.startTier(route, req.stepKey);
    const ladder = TIERS.slice(TIERS.indexOf(start));
    const escalations: string[] = [];
    const tried: Tier[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let cost = 0;
    let last: BackendReply | null = null;
    let lastModel = this.tierModels[start];
    for (const tier of ladder) {
      tried.push(tier);
      const model = this.tierModels[tier];
      lastModel = model;
      const reply = await this.o.backend.complete({ model, route, role: req.role, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? 2000, effort: tier === "opus" ? "high" : spec.effort, adaptiveThinking: tier === "opus" || spec.adaptiveThinking });
      usage = { inputTokens: usage.inputTokens + reply.usage.inputTokens, outputTokens: usage.outputTokens + reply.usage.outputTokens, cacheReadTokens: usage.cacheReadTokens + reply.usage.cacheReadTokens };
      cost += costOf(reply.model, reply.usage);
      last = reply;
      lastModel = reply.model;
      let why: string | null = null;
      if (reply.stopReason === "refusal") why = `${tier} declined`;
      else if (reply.stopReason === "max_tokens") why = `${tier} reply was cut off`;
      else if (req.validate !== undefined) {
        const v = req.validate(reply.text);
        if (v !== null) why = `${tier}: ${v.slice(0, 80)}`;
      }
      if (why === null) break;
      escalations.push(why);
    }
    const d: Decision = { at: this.now(), route, ...(req.stepKey === undefined ? {} : { stepKey: req.stepKey }), tiers: tried, model: lastModel, escalations, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: Math.round(cost * 1e6) / 1e6 };
    this.record(d, usage.cacheReadTokens);
    if (req.stepKey !== undefined && route === "item_step") this.recordStepOutcome(req.stepKey, escalations.length === 0 ? { ok: true } : { ok: false, reason: escalations[0]! });
    if (last === null || last.stopReason === "refusal") throw new RefusalError(`every model declined this ${route} request`);
    return last.text;
  }

  summary(): RouterSummary {
    const l = this.ledger();
    const budget = this.budget();
    const spent = this.spentUsd();
    const routes: RouterSummary["routes"] = {};
    for (const r of Object.keys(ROUTES) as Route[]) {
      const t = l.routes[r];
      if (t !== undefined) routes[r] = { ...t, tier: ROUTES[r].tier, model: this.tierModels[ROUTES[r].tier] };
    }
    const blocked = this.blocked();
    const needsYou =
      this.o.backend.kind === "claude-code"
        ? "Add a Claude key so Offload can pick the right model for each step and show what it costs."
        : blocked
          ? "This month's Claude budget is spent. Raise it in Settings; screens are read on this Mac meanwhile."
          : null;
    return { backend: this.o.backend.kind, metered: this.o.backend.metered, month: l.month, spentUsd: spent, budgetUsd: budget, captionsLocal: !this.captionOnClaude(), blocked, needsYou, routes };
  }

  usage(): RouterSummary & { models: Ledger["models"]; decisions: Decision[]; prices: typeof PRICES; provenRuns: number } {
    return { ...this.summary(), models: { ...this.ledger().models }, decisions: this.recentDecisions(), prices: PRICES, provenRuns: PROVEN_RUNS };
  }
}

export function tierOf(model: string): Tier {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

/** The router as a Model: every existing call site keeps calling `model.complete(req)`. */
export class RoutedModel implements Model {
  constructor(readonly router: ModelRouter) {}
  complete(req: ModelRequest): Promise<string> {
    return this.router.complete(req);
  }
}
