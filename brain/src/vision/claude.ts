// Claude captioner (s14 scope add, operator opt-in): reads one MASKED keyframe with Claude through the official
// Anthropic SDK and returns the same caption fields as the local captioner (Captioner interface, vision/types.ts).
// Rules:
// - The engine masks every frame before the brain sees it (cards, ids, OTPs, secure fields filled black; K2). This
//   file never unmasks, crops or re-encodes; it sends exactly the JPEG the observer stored.
// - Only to Anthropic's API (https://api.anthropic.com): the base URL is checked at construction and every request
//   URL is checked again before it is sent; redirects are refused.
// - The API key comes from ANTHROPIC_API_KEY or a macOS Keychain reference (OFFLOAD_ANTHROPIC_KEYCHAIN =
//   "service/account"), is held in memory only, and never appears in a log line, an error, a status or a DTO.
// - Structured output: output_config.format = the caption fields' JSON schema (from schemas/frame-note.schema.json);
//   stop_reason is checked before any content is read (refusal, max_tokens). Usage is counted per frame.
// - Not the default: selection is `serve --captioner claude`, or `auto` once CLAUDE_IN_AUTO is turned on (cli.ts).
import Anthropic from "@anthropic-ai/sdk";
import { TIER_MODELS } from "../models/router.ts";
import { spawnSync } from "node:child_process";
import { captionJsonSchema, CaptionShapeError, coerceFields } from "./schema.ts";
import { CaptionerFatalError } from "./ollama.ts";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.ts";
import type { Captioner, CaptionerHealth, CaptionFields, CaptionInput, CaptionUsage } from "./types.ts";

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
export const ANTHROPIC_HOST = "api.anthropic.com";
/** Cheapest current model that reads screenshots well; `--claude-vision-model claude-sonnet-5-5` for more care. */
export const DEFAULT_CLAUDE_VISION_MODEL = TIER_MODELS.haiku;
export const CLAUDE_VISION_MODELS = [TIER_MODELS.haiku, TIER_MODELS.sonnet, TIER_MODELS.opus] as const;

export class NonAnthropicHostError extends Error {}
/** Claude declined this frame (stop_reason "refusal"): retrying the same frame will not help. */
export class CaptionRefusedError extends Error {
  readonly noRetry = true;
}

/** The origin to call: only https://api.anthropic.com (any path, port, credentials or other host is refused). */
export function anthropicOrigin(raw: string = ANTHROPIC_ORIGIN): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NonAnthropicHostError("the Claude URL is not a valid URL");
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== ANTHROPIC_HOST || u.port !== "" || u.username !== "" || u.password !== "") {
    throw new NonAnthropicHostError(`screens go only to ${ANTHROPIC_ORIGIN}, not ${u.protocol}//${u.host}`);
  }
  return ANTHROPIC_ORIGIN;
}

export type KeyRunner = (cmd: string, args: readonly string[]) => { status: number | null; stdout: string };
const defaultRunner: KeyRunner = (cmd, args) => {
  const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 10_000 });
  return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" };
};

export interface KeySource {
  /** Where the key comes from, for status lines: never the key itself. */
  source: "env" | "keychain" | "none";
  key: string | null;
}

/** ANTHROPIC_API_KEY, else the Keychain item named by OFFLOAD_ANTHROPIC_KEYCHAIN ("service/account"), else none. */
export function resolveAnthropicKey(env: Readonly<Record<string, string | undefined>> = process.env, run: KeyRunner = defaultRunner): KeySource {
  const k = env.ANTHROPIC_API_KEY?.trim();
  if (k !== undefined && k !== "") return { source: "env", key: k };
  const ref = env.OFFLOAD_ANTHROPIC_KEYCHAIN?.trim();
  if (ref !== undefined && ref !== "") {
    const [service, account] = ref.split("/", 2);
    if (service === undefined || account === undefined || service === "" || account === "" || !/^[\w .@-]{1,120}$/.test(service) || !/^[\w .@-]{1,120}$/.test(account)) return { source: "none", key: null };
    const r = run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    const v = r.stdout.trim();
    if (r.status === 0 && v !== "") return { source: "keychain", key: v };
  }
  return { source: "none", key: null };
}

/** True when a key is configured (env or Keychain reference), without reading the Keychain. */
export function claudeKeyConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" || (env.OFFLOAD_ANTHROPIC_KEYCHAIN?.trim() ?? "") !== "";
}

/** The caption fields' schema for structured outputs: the frame-note fields, all required, nothing else allowed.
 * Length and range limits are enforced in code after the reply (coerceFields), so only plain types are sent. */
export function claudeCaptionSchema(): Record<string, unknown> {
  const base = captionJsonSchema() as { properties: Record<string, Record<string, unknown>>; required: string[] };
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base.properties)) properties[k] = v.type === "array" ? { type: "array", items: { type: "string" } } : { type: v.type };
  return { type: "object", properties, required: [...base.required], additionalProperties: false };
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A fetch that refuses any URL whose host is not api.anthropic.com, and refuses redirects. */
export function guardedFetch(inner: FetchFn = (i, init) => fetch(i, init)): FetchFn {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== ANTHROPIC_HOST) throw new NonAnthropicHostError(`refused a request to ${u.host}: screens go only to ${ANTHROPIC_HOST}`);
    return inner(input, { ...init, redirect: "error" });
  };
}

export interface ClaudeOptions {
  model?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Keychain lookups (tests). */
  run?: KeyRunner;
  /** Must be https://api.anthropic.com (the default). */
  baseURL?: string;
  /** The HTTP layer under the host guard (tests pass a stub; nothing else ever reaches the network). */
  fetch?: FetchFn;
  /** Per request, ms (default 60 000). */
  timeoutMs?: number;
  /** SDK retries on 408/409/429/5xx and connection errors (default 2). */
  maxRetries?: number;
  maxTokens?: number;
  /** s14 model router (models/router.ts, ADR 0009): picks the caption model and counts the cost. Structural, so this
   * file does not import the router. */
  router?: CaptionRouter;
}

export interface CaptionRouter {
  modelFor(route: "caption"): string;
  recordUsage(route: "caption", model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, escalations?: string[]): { costUsd: number };
}

export class ClaudeCaptioner implements Captioner {
  readonly kind = "claude" as const;
  private readonly fixedModel: string;
  private readonly router: CaptionRouter | undefined;
  readonly keySource: KeySource["source"];
  private readonly client: Anthropic | null;
  private readonly maxTokens: number;
  private readonly totals: CaptionUsage = { frames: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, lastFrame: null, refusals: 0, costUsd: 0 };

  constructor(opts: ClaudeOptions = {}) {
    const origin = anthropicOrigin(opts.baseURL ?? ANTHROPIC_ORIGIN);
    this.fixedModel = opts.model ?? DEFAULT_CLAUDE_VISION_MODEL;
    if (!/^claude-[a-z0-9.-]{2,60}$/.test(this.fixedModel)) throw new CaptionerFatalError("invalid Claude model id");
    this.router = opts.model === undefined ? opts.router : undefined;
    const k = resolveAnthropicKey(opts.env ?? process.env, opts.run ?? defaultRunner);
    this.keySource = k.source;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.client =
      k.key === null
        ? null
        : new Anthropic({ apiKey: k.key, baseURL: origin, fetch: guardedFetch(opts.fetch) as never, timeout: opts.timeoutMs ?? 60_000, maxRetries: Math.max(0, opts.maxRetries ?? 2) });
  }

  /** The model for the next frame: the router's caption model, or the one given with --claude-vision-model. */
  get model(): string {
    return this.router?.modelFor("caption") ?? this.fixedModel;
  }

  get id(): string {
    return `claude:${this.model}`;
  }

  /** A key was found (env or Keychain). */
  get configured(): boolean {
    return this.client !== null;
  }

  usage(): CaptionUsage {
    return { ...this.totals, lastFrame: this.totals.lastFrame === null ? null : { ...this.totals.lastFrame } };
  }

  async caption(input: CaptionInput, signal?: AbortSignal): Promise<CaptionFields> {
    if (this.client === null) throw new CaptionerFatalError("no Claude account is set up (ANTHROPIC_API_KEY or OFFLOAD_ANTHROPIC_KEYCHAIN)");
    if (signal?.aborted === true) throw new Error("aborted");
    let msg: Anthropic.Message;
    const model = this.model;
    try {
      msg = await this.client.messages.create(
        {
          model,
          max_tokens: this.maxTokens,
          system: SYSTEM_PROMPT,
          output_config: { effort: "low", format: { type: "json_schema", schema: claudeCaptionSchema() } },
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(input.image).toString("base64") } },
                { type: "text", text: userPrompt(input.ref, input.context) },
              ],
            },
          ],
        },
        signal === undefined ? {} : { signal },
      );
    } catch (err) {
      throw classify(err);
    }
    // Usage counts even when the reply is unusable: it was paid for.
    const u = msg.usage;
    const frame = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
    this.totals.frames += 1;
    this.totals.inputTokens += u.input_tokens;
    this.totals.outputTokens += u.output_tokens;
    this.totals.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.totals.lastFrame = frame;
    const rec = this.router?.recordUsage("caption", msg.model ?? model, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0 }, msg.stop_reason === "refusal" ? ["haiku declined"] : []);
    this.totals.costUsd = Math.round(((this.totals.costUsd ?? 0) + (rec?.costUsd ?? 0)) * 1e6) / 1e6;
    if (msg.stop_reason === "refusal") {
      this.totals.refusals += 1;
      throw new CaptionRefusedError("Claude declined to describe this screen; it is skipped");
    }
    if (msg.stop_reason === "max_tokens") throw new CaptionShapeError("Claude's note was cut off (max_tokens)");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CaptionShapeError("Claude's reply is not JSON");
    }
    return coerceFields(parsed);
  }

  async health(): Promise<CaptionerHealth> {
    if (this.client === null) return { ok: false, detail: "no Claude account is set up" };
    try {
      await this.client.models.retrieve(this.model, {}, { timeout: 10_000, maxRetries: 0 });
      return { ok: true, detail: "ready" };
    } catch (err) {
      const e = classify(err);
      return { ok: false, detail: e.message };
    }
  }
}

/** SDK errors -> what the caption worker does with them. Messages are our own words (no key, no reply body). */
function classify(err: unknown): Error {
  if (err instanceof NonAnthropicHostError) return new CaptionerFatalError(err.message);
  if (err instanceof Anthropic.APIUserAbortError) return new Error("aborted");
  if (err instanceof Anthropic.AuthenticationError) return new CaptionerFatalError("Claude did not accept the account key (HTTP 401)");
  if (err instanceof Anthropic.PermissionDeniedError) return new CaptionerFatalError("this Claude account may not use this model (HTTP 403)");
  if (err instanceof Anthropic.NotFoundError) return new CaptionerFatalError("this Claude model is not available (HTTP 404)");
  if (err instanceof Anthropic.BadRequestError) return new CaptionerFatalError("Claude refused the request shape (HTTP 400)");
  if (err instanceof Anthropic.RateLimitError) return new Error("Claude rate limit reached (HTTP 429); will retry later");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error("Claude did not answer in time");
  if (err instanceof Anthropic.APIConnectionError) return new Error("Claude unreachable");
  if (err instanceof Anthropic.APIError) return new Error(`Claude answered HTTP ${err.status ?? "error"}`);
  return err instanceof Error ? new Error(err.message.slice(0, 160)) : new Error("Claude caption failed");
}
