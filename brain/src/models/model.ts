// Every model call in the brain goes through `Model` so tests run offline and deterministic (StubModel).
// ADR 0005: models name things and write drafts; they never produce a time or saving figure.
import { executorEnv } from "../workflows/executor.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** draft = per-recipient emails (best model); bucket and style_card = cheap steps.
 * s14: workflow_design = the general workflow builder rewriting step text (best model); step = one text step of a
 * general workflow, e.g. a ticket reply (cheap model). Both see masked text only, never images (ADR 0007). */
export type ModelRole = "draft" | "bucket" | "style_card" | "workflow_design" | "step" | "label" | "refine" | "explain";

export interface ModelRequest {
  role: ModelRole;
  /** Model id, from `modelFor(role, config)`. */
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** s14 router (models/router.ts): the route when it is not the role's default one. */
  route?: import("./router.ts").Route;
  /** s14 router: a workflow step ("<workflowId>/<stepId>") whose tier is promoted or demoted by its record. */
  stepKey?: string;
  /** s14 router: a check of the reply; a non-null reason escalates to the next tier (Haiku -> Sonnet -> Opus). */
  validate?: (text: string) => string | null;
}

export interface Model {
  complete(req: ModelRequest): Promise<string>;
}

export interface ModelConfig {
  draft: string;
  cheap: string;
}

export const DEFAULT_MODELS: Readonly<ModelConfig> = { draft: "claude-opus-5-5", cheap: "claude-sonnet-5-5" };

export function modelFor(role: ModelRole, cfg: ModelConfig): string {
  return role === "draft" || role === "workflow_design" ? cfg.draft : cfg.cheap;
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-]{2,80}$/;

/** Defaults, then `$OFFLOAD_HOME/models.json` `{ draft?, cheap? }`, then OFFLOAD_MODEL_DRAFT / OFFLOAD_MODEL_CHEAP. */
export function loadModelConfig(home: string, env: Readonly<Record<string, string | undefined>> = process.env): ModelConfig {
  const cfg: ModelConfig = { ...DEFAULT_MODELS };
  const path = join(home, "models.json");
  if (existsSync(path)) {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) throw new Error(`${path}: expected an object`);
    for (const k of ["draft", "cheap"] as const) {
      const v = (raw as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || !MODEL_ID_RE.test(v)) throw new Error(`${path}: ${k} must be a model id`);
      cfg[k] = v;
    }
  }
  if (env.OFFLOAD_MODEL_DRAFT) cfg.draft = env.OFFLOAD_MODEL_DRAFT;
  if (env.OFFLOAD_MODEL_CHEAP) cfg.cheap = env.OFFLOAD_MODEL_CHEAP;
  return cfg;
}

// ---------- deterministic stub ----------

/** Pulls `<tag>…</tag>` out of a prompt. */
export function tagged(prompt: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(prompt);
  return m?.[1] ?? null;
}

/**
 * Offline model for tests and `--model stub`. Same prompt in, same text out.
 * draft (s10e): a full email shaped like the user's past ones, built only from the <facts> and <recipient> blocks
 * (plus the sign-off and the kind of ask from <examples> when the facts lack them): greeting, who and what, one line
 * on the recipient's fund, raise and traction, the ask, the name. A missing fact shows as [missing: ...]; no number
 * that is not in the facts. bucket: echoes <bucket_hint>; style_card: voice notes read from the examples.
 */
export class StubModel implements Model {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly overrides: Partial<Record<ModelRole, (req: ModelRequest) => string>> = {}) {}

  async complete(req: ModelRequest): Promise<string> {
    this.calls.push(req);
    const o = this.overrides[req.role];
    if (o !== undefined) return o(req);
    if (req.role === "bucket") return tagged(req.prompt, "bucket_hint") ?? "other";
    // s14: the design model echoes the rules variants (so stub plans equal the rules plans); a step draft is built
    // from the source text and the facts only (plan/text-step.ts stubStepDraft).
    if (req.role === "workflow_design") return tagged(req.prompt, "baseline") ?? "{}";
    if (req.role === "step") return stubStepDraft(req.prompt);
    const examples = parseExamples(tagged(req.prompt, "examples") ?? "");
    if (req.role === "style_card") return stubStyleCard(examples);
    return stubDraft(req.prompt, examples);
  }
}

/** Bodies of an <examples> block ("--- example N", "Subject: ...", blank line, body). */
function parseExamples(block: string): string[] {
  return block
    .split(/^--- example \d+\s*$/m)
    .map((part) => part.replace(/^\s*Subject:[^\n]*\n/, "").trim())
    .filter((x) => x !== "");
}

const lastLine = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? null;
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The name the examples sign with, when most of them agree. */
function exampleSign(examples: readonly string[]): string | null {
  const names = examples.map(lastLine).filter((l): l is string => l !== null && /^[A-Z][\w'-]{1,30}$/.test(l));
  const top = names[0];
  return top !== undefined && names.filter((n) => n === top).length * 2 > names.length ? top : null;
}

/** The first ask (a line ending in "?") the examples make that carries no number. */
function exampleAsk(examples: readonly string[]): string | null {
  for (const e of examples)
    for (const line of e.split("\n")) {
      const l = line.trim();
      const q = /[^.!?]*\?/.exec(l)?.[0]?.trim();
      if (q !== undefined && q.length > 3 && !/\d/.test(q)) return q;
    }
  return null;
}

function stubDraft(prompt: string, examples: readonly string[]): string {
  const recipient = JSON.parse(tagged(prompt, "recipient") ?? "{}") as Record<string, string>;
  const facts = parseFactLines(tagged(prompt, "facts") ?? "");
  const sign = facts.sign ?? exampleSign(examples) ?? "Muhammad";
  const first = recipient.firstName !== undefined && recipient.firstName !== "" ? recipient.firstName : "there";
  const intro: string[] = [];
  if (facts.company !== undefined) intro.push(facts.role !== undefined ? `I'm ${sign}, ${facts.role} of ${facts.company}.` : `I'm ${sign} from ${facts.company}.`);
  intro.push(facts.pitch !== undefined ? sentence(facts.pitch) : "[missing: pitch]");
  const lines = [`Hi ${first},`, "", intro.join(" ")];
  const org = recipient.org?.trim() ?? "";
  const notes = recipient.notes?.trim() ?? "";
  if (notes !== "") lines.push(`${sentence(notes)} That is why I'm writing to you first.`);
  else if (org !== "") lines.push(`${org} backs tools teams use every day, so I'm writing to you first.`);
  const raise = facts.raise !== undefined ? sentence(facts.raise).replace(/^raising\b/i, "We are raising") : "[missing: raise]";
  const traction = facts.traction !== undefined ? (/^traction\b/i.test(facts.traction) ? sentence(facts.traction) : `Traction: ${sentence(facts.traction)}`) : "[missing: traction]";
  lines.push("", `${raise} ${traction}`, "", facts.ask ?? exampleAsk(examples) ?? "Open to a short call next week?", "", sign);
  return lines.join("\n");
}

/** Voice notes a person would write about their own emails, read from the examples. No numbers (code measures). */
function stubStyleCard(examples: readonly string[]): string {
  const greet = examples.map((e) => /^(Hi|Hello|Hey|Dear)\b/.exec(e.trim())?.[1]).find((g) => g !== undefined);
  const sign = exampleSign(examples);
  const ask = exampleAsk(examples);
  return [
    greet !== undefined ? `- Opens with "${greet}" and the first name, then gets to the point in the first line.` : "- Opens with a short greeting and gets to the point in the first line.",
    "- Short and direct: one idea per paragraph, no pleasantries, no filler.",
    ask !== null ? `- One clear ask at the end, as a plain question ("${ask}").` : "- One clear ask at the end, as a plain question.",
    sign !== null ? `- Signs with the first name only ("${sign}").` : "- Signs with the first name only.",
  ].join("\n");
}

function parseFactLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^-?\s*([A-Za-z][\w ]*?):\s*(.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return out;
}

/** s14 step draft (stub): a short reply in the user's usual greeting and sign-off, naming what the source asks about,
 * with no number that is not in the source. Same prompt in, same text out. */
function stubStepDraft(prompt: string): string {
  const source = tagged(prompt, "source") ?? "";
  const card = tagged(prompt, "style_card") ?? "";
  const examples = parseExamples(tagged(prompt, "examples") ?? "");
  const greet = /greeting: "([^"]+)"/.exec(card)?.[1] ?? examples.map((e) => /^(Hi|Hello|Hey|Dear)\b[^\n]*/.exec(e.trim())?.[0]).find((g) => g !== undefined) ?? "Hi,";
  const sign = /sign-off: "([^"]+)"/.exec(card)?.[1] ?? exampleSign(examples) ?? "The team";
  const topic = source.split("\n").map((l) => l.trim()).find((l) => l !== "" && !/^customer:/i.test(l)) ?? "your message";
  const what = /Write the (.+?) now\.\s*$/m.exec(prompt)?.[1] ?? "reply";
  if (!/reply|answer|message|respon/i.test(what)) {
    // A note (scorecard, comment): what it is about and the gaps a person fills in. No number, no verdict.
    return [`${what.charAt(0).toUpperCase()}${what.slice(1)}: ${topic.replace(/[.?!]+$/, "")}`, "- What stands out: [missing: your read of the source]", "- Gaps against what you look for: [missing: your read]", "- Recommendation: [missing: your decision]"].join("\n");
  }
  const ask = /order #\d+/i.exec(source)?.[0];
  const lines = [greet.endsWith(",") ? greet : `${greet},`, "", `Thanks for getting in touch about "${topic.replace(/[.?!]+$/, "")}".`];
  lines.push(ask !== undefined ? `I have checked ${ask} and will update you here as soon as it moves.` : "I have looked into it and here is what happens next.");
  lines.push("", sign);
  return lines.join("\n");
}

// ---------- real model via the Claude Agent SDK ----------

/**
 * One-turn text completion through the Agent SDK (uses the local Claude Code login or ANTHROPIC_API_KEY).
 * No tools at all: built-ins off, no MCP servers, no setting sources, every permission request denied.
 */
/** The exact query() arguments of a model call (exported so tests pin them without a network call). The child gets
 * executorEnv: no OFFLOAD_TOKEN, no OFFLOAD_* setting, no connector secret (REVIEW-1 L5, REVIEW-2 N6). */
export function modelQueryOptions(req: ModelRequest, env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    prompt: req.prompt,
    options: {
      model: req.model,
      systemPrompt: req.system,
      tools: [] as string[],
      allowedTools: [] as string[],
      settingSources: [] as [],
      strictMcpConfig: true,
      mcpServers: {},
      env: executorEnv(env),
      maxTurns: 1,
      permissionMode: "default" as const,
      canUseTool: async () => ({ behavior: "deny" as const, message: "model calls have no tools" }),
    },
  };
}

export class AgentSdkModel implements Model {
  async complete(req: ModelRequest): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const q = query(modelQueryOptions(req, process.env));
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.subtype === "success" && !m.is_error) return m.result.trim();
      throw new Error(`model ${req.model} (${req.role}) failed: ${m.subtype}`);
    }
    throw new Error(`model ${req.model} (${req.role}) returned no result`);
  }
}
