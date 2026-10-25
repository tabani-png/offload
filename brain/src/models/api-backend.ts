// s14 Claude API backend for the model router (official @anthropic-ai/sdk). Per route: the tier's model, effort in
// output_config, adaptive thinking on Opus routes, the system prompt cached (cache_control ephemeral: it is fixed text
// per call site), server-side fallbacks ("default") on Opus 5.5 / Sonnet 5.5, and stop_reason handed to the router
// before any content is used. Only https://api.anthropic.com, through the same host guard as the Claude captioner.
// The key comes from ANTHROPIC_API_KEY or the Keychain reference (vision/claude.ts resolveAnthropicKey); never logged.
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_ORIGIN, anthropicOrigin, guardedFetch, resolveAnthropicKey, type KeyRunner } from "../vision/claude.ts";
import { TIER_MODELS, type Backend, type BackendReply, type BackendRequest } from "./router.ts";

/** Models that accept the server-side `fallbacks: "default"` form on the Claude API (claude-api skill). */
export const FALLBACK_MODELS = new Set([TIER_MODELS.opus, TIER_MODELS.sonnet]);
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ApiBackendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiBackendOptions {
  env?: Readonly<Record<string, string | undefined>>;
  run?: KeyRunner;
  fetch?: FetchFn;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** The request body the backend sends (exported so tests pin it). */
export function apiParams(req: BackendRequest) {
  const fallback = FALLBACK_MODELS.has(req.model);
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: req.prompt }],
    output_config: { effort: req.effort },
    ...(req.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    ...(fallback ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
  };
}

export class ApiBackend implements Backend {
  readonly kind = "api" as const;
  readonly metered = true;
  private readonly client: Anthropic;

  constructor(key: string, o: ApiBackendOptions = {}) {
    this.client = new Anthropic({ apiKey: key, baseURL: anthropicOrigin(o.baseURL ?? ANTHROPIC_ORIGIN), fetch: guardedFetch(o.fetch) as never, timeout: o.timeoutMs ?? 120_000, maxRetries: Math.max(0, o.maxRetries ?? 2) });
  }

  /** null when no key is configured (the router then uses the Claude Code login or the stub). */
  static fromEnv(o: ApiBackendOptions = {}): ApiBackend | null {
    const k = resolveAnthropicKey(o.env ?? process.env, o.run);
    return k.key === null ? null : new ApiBackend(k.key, o);
  }

  async complete(req: BackendRequest): Promise<BackendReply> {
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await this.client.beta.messages.create(apiParams(req) as never);
    } catch (err) {
      throw classifyApiError(err);
    }
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return {
      text,
      stopReason: msg.stop_reason,
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0 },
      model: msg.model,
    };
  }
}

/** SDK errors in our own words (no key, no request or reply body), most specific first. */
export function classifyApiError(err: unknown): ApiBackendError {
  if (err instanceof Anthropic.AuthenticationError) return new ApiBackendError("Claude did not accept the account key (HTTP 401)", false);
  if (err instanceof Anthropic.PermissionDeniedError) return new ApiBackendError("this Claude account may not use this model (HTTP 403)", false);
  if (err instanceof Anthropic.NotFoundError) return new ApiBackendError("this Claude model is not available (HTTP 404)", false);
  if (err instanceof Anthropic.BadRequestError) return new ApiBackendError("Claude refused the request shape (HTTP 400)", false);
  if (err instanceof Anthropic.RateLimitError) return new ApiBackendError("Claude rate limit reached (HTTP 429)", true);
  if (err instanceof Anthropic.InternalServerError) return new ApiBackendError(`Claude server error (HTTP ${err.status})`, true);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ApiBackendError("Claude did not answer in time", true);
  if (err instanceof Anthropic.APIConnectionError) return new ApiBackendError("Claude unreachable", true);
  if (err instanceof Anthropic.APIError) return new ApiBackendError(`Claude answered HTTP ${err.status ?? "error"}`, false);
  return new ApiBackendError(err instanceof Error ? err.message.slice(0, 160) : "Claude call failed", false);
}
