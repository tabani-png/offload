// Local vision captioner on Ollama (SPEC C3, C4). The base URL must be loopback: screenshots never leave the Mac.
// Structured output: `format` carries the JSON schema of the caption fields; the reply is coerced into the schema
// limits and validated. Retries on network errors, 5xx and unusable JSON; each attempt has its own timeout.
import { captionJsonSchema, CaptionShapeError, coerceFields } from "./schema.ts";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.ts";
import type { Captioner, CaptionerHealth, CaptionFields, CaptionInput } from "./types.ts";

/** "auto" = the best pulled model of VISION_MODEL_PREFERENCE (slices/s11-perception/BENCH.md). Swappable with
 * `serve --vision-model TAG`. */
export const DEFAULT_VISION_MODEL = "auto";
/** Best first. qwen3-vl instruct: no thinking tokens, strong on screenshots (BENCH.md). */
export const VISION_MODEL_PREFERENCE = ["qwen3-vl:8b-instruct", "qwen3-vl:4b-instruct", "qwen3-vl:2b-instruct", "qwen3-vl:8b", "qwen3-vl:4b", "qwen3-vl:2b"] as const;
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export class NonLoopbackError extends Error {}
/** A caption attempt failed in a way that a retry will not fix (4xx, model missing). */
export class CaptionerFatalError extends Error {}

/** Returns the origin to call, or throws NonLoopbackError. Only http on 127.0.0.0/8, [::1] or localhost (which is
 * pinned to 127.0.0.1 so a hosts-file entry cannot point it elsewhere). No credentials, no path tricks. */
export function loopbackOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NonLoopbackError("the Ollama URL is not a valid URL");
  }
  if (u.protocol !== "http:") throw new NonLoopbackError("the Ollama URL must be http on this Mac (loopback)");
  if (u.username !== "" || u.password !== "") throw new NonLoopbackError("the Ollama URL must not carry credentials");
  const h = u.hostname.toLowerCase();
  let host: string;
  if (h === "localhost") host = "127.0.0.1";
  else if (h === "[::1]") host = "[::1]";
  else if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h) && h.split(".").every((p) => Number(p) <= 255)) host = h;
  else throw new NonLoopbackError(`the Ollama URL must be loopback (127.0.0.1, [::1] or localhost), not ${h}`);
  return `http://${host}${u.port === "" ? "" : `:${u.port}`}`;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaOptions {
  url?: string;
  model?: string;
  /** Per attempt, ms (default 120 000: a cold model load can take a while). */
  timeoutMs?: number;
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Wait before retry n is n * backoffMs (default 1000). */
  backoffMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Max tokens to generate (default 600). */
  numPredict?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OllamaCaptioner implements Captioner {
  readonly kind = "ollama" as const;
  /** The tag asked for ("auto" or a tag). */
  readonly requested: string;
  private resolved: string | null;
  readonly origin: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly numPredict: number;
  /** Requests sent (tests). */
  requests = 0;

  constructor(opts: OllamaOptions = {}) {
    this.origin = loopbackOrigin(opts.url ?? DEFAULT_OLLAMA_URL);
    this.requested = opts.model ?? DEFAULT_VISION_MODEL;
    if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(this.requested)) throw new CaptionerFatalError("invalid model tag");
    this.resolved = this.requested === "auto" ? null : this.requested;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.retries = Math.max(0, opts.retries ?? 2);
    this.backoffMs = opts.backoffMs ?? 1000;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.numPredict = opts.numPredict ?? 600;
  }

  /** The model in use: the requested tag, or for "auto" the one health() picked ("auto" until then). */
  get model(): string {
    return this.resolved ?? this.requested;
  }

  get id(): string {
    return `ollama:${this.model}`;
  }

  private async call(path: string, init: RequestInit, outer?: AbortSignal): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), this.timeoutMs);
    const onAbort = () => ctl.abort(new Error("aborted"));
    outer?.addEventListener("abort", onAbort, { once: true });
    try {
      this.requests += 1;
      // redirect "error": a loopback server cannot bounce the image to another host.
      return await this.fetchFn(`${this.origin}${path}`, { ...init, signal: ctl.signal, redirect: "error" });
    } catch (err) {
      if (ctl.signal.aborted) throw new Error(outer?.aborted === true ? "aborted" : `ollama did not answer within ${this.timeoutMs} ms`);
      throw new Error(`ollama unreachable at ${this.origin}: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  async caption(input: CaptionInput, signal?: AbortSignal): Promise<CaptionFields> {
    if (this.resolved === null) {
      const h = await this.health();
      if (this.resolved === null) throw new CaptionerFatalError(h.detail);
    }
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      think: false,
      keep_alive: "15m",
      format: captionJsonSchema(),
      options: { temperature: 0, num_predict: this.numPredict, num_ctx: 8192 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input.ref, input.context), images: [Buffer.from(input.image).toString("base64")] },
      ],
    });
    let last: Error = new Error("no attempt");
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted === true) throw new Error("aborted");
      if (attempt > 0) await this.sleep(this.backoffMs * attempt);
      try {
        const res = await this.call("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body }, signal);
        if (res.status === 404) throw new CaptionerFatalError(`model ${this.model} is not pulled (ollama pull ${this.model})`);
        if (res.status >= 400 && res.status < 500) throw new CaptionerFatalError(`ollama refused the request (HTTP ${res.status})`);
        if (!res.ok) throw new Error(`ollama answered HTTP ${res.status}`);
        const payload = (await res.json()) as { message?: { content?: unknown } };
        const content = payload.message?.content;
        if (typeof content !== "string") throw new CaptionShapeError("ollama reply has no message content");
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new CaptionShapeError("ollama reply is not JSON");
        }
        return coerceFields(parsed);
      } catch (err) {
        if (err instanceof CaptionerFatalError) throw err;
        if (err instanceof Error && err.message === "aborted") throw err;
        last = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw last;
  }

  async health(): Promise<CaptionerHealth> {
    try {
      const res = await this.call("/api/tags", { method: "GET" });
      if (!res.ok) return { ok: false, detail: `ollama answered HTTP ${res.status}` };
      const tags = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (tags.models ?? []).flatMap((m) => [m.name, m.model]).filter((x): x is string => typeof x === "string");
      if (this.requested === "auto") {
        const pick = VISION_MODEL_PREFERENCE.find((m) => names.includes(m)) ?? null;
        if (pick !== null) this.resolved = pick;
        return pick !== null ? { ok: true, detail: "ready" } : { ok: false, detail: `no vision model pulled (ollama pull ${VISION_MODEL_PREFERENCE[0]})` };
      }
      const want = this.requested.includes(":") ? this.requested : `${this.requested}:latest`;
      return names.includes(want) ? { ok: true, detail: "ready" } : { ok: false, detail: `model ${this.requested} is not pulled (ollama pull ${this.requested})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "ollama unreachable" };
    }
  }
}
