// Every model call in the brain goes through `Model` so tests run offline and deterministic (StubModel).
// ADR 0005: models name things and write drafts; they never produce a time or saving figure.
import { executorEnv } from "../workflows/executor.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** draft = per-recipient emails (best model); bucket and style_card = cheap steps. */
export type ModelRole = "draft" | "bucket" | "style_card";

export interface ModelRequest {
  role: ModelRole;
  /** Model id, from `modelFor(role, config)`. */
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
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
  return role === "draft" ? cfg.draft : cfg.cheap;
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
 * draft: an email built only from the <recipient> and <facts> blocks; bucket: echoes <bucket_hint>;
 * style_card: a fixed voice section.
 */
export class StubModel implements Model {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly overrides: Partial<Record<ModelRole, (req: ModelRequest) => string>> = {}) {}

  async complete(req: ModelRequest): Promise<string> {
    this.calls.push(req);
    const o = this.overrides[req.role];
    if (o !== undefined) return o(req);
    if (req.role === "bucket") return tagged(req.prompt, "bucket_hint") ?? "other";
    if (req.role === "style_card") {
      return ["- Short and direct. Gets to the point in the first line.", "- One clear ask, usually a short call.", "- No pleasantries, no filler.", "- Signs with the first name only."].join("\n");
    }
    const recipient = JSON.parse(tagged(req.prompt, "recipient") ?? "{}") as Record<string, string>;
    const facts = parseFactLines(tagged(req.prompt, "facts") ?? "");
    const first = recipient.firstName ?? "there";
    const lines = [`Hi ${first},`, ""];
    if (facts.pitch) lines.push(facts.pitch);
    const traction = [facts.raise, facts.traction].filter((x) => x !== undefined && x !== "").join(" ");
    if (traction !== "") lines.push(traction);
    if (recipient.org) lines.push(`I think it fits ${recipient.org}.`);
    lines.push("", facts.ask ?? "Open to a short call next week?", "", facts.sign ?? "Muhammad");
    return lines.join("\n");
  }
}

function parseFactLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^-?\s*([A-Za-z][\w ]*?):\s*(.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return out;
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
