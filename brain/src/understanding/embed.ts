// s12 local embeddings. Span descriptions are embedded on the Mac only: Ollama on loopback (qwen3-embedding:0.6b or
// bge-m3, ADR 0007) or a deterministic stub for tests. Nothing here ever talks to a non-loopback host.

export interface Embedder {
  /** e.g. "stub:512" or "ollama:qwen3-embedding:0.6b". */
  readonly id: string;
  /** One vector per text, same order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const STOP = new Set("a an and the of to in on for with into from at by is are this that it its".split(" "));

/** Crude stem so "reading"/"reads"/"read" and "invoices"/"invoice" share a feature. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/**
 * Deterministic feature-hashing embedder: stemmed words (weight 1) and word bigrams (weight 0.5), signed buckets,
 * unit norm. Same text -> same vector; texts sharing words are close. Tests and offline runs only.
 */
export class StubEmbedder implements Embedder {
  readonly id: string;
  constructor(private readonly dim = 512) {
    this.id = `stub:${dim}`;
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const words = text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map(stem);
    const add = (feature: string, w: number) => {
      const h = fnv1a(feature);
      v[h % this.dim]! += (h & 0x80000000) !== 0 ? -w : w;
    };
    words.forEach((w, i) => {
      add(w, 1);
      if (i > 0) add(`${words[i - 1]} ${w}`, 0.5);
    });
    return normalize(v);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True only for http(s) URLs on the loopback interface. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    // Not a URL at all: not loopback.
    return false;
  }
}

export const OLLAMA_EMBED_MODELS = ["qwen3-embedding:0.6b", "bge-m3"] as const;

export interface OllamaEmbedderOptions {
  model?: string;
  baseUrl?: string;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

export class EmbedderError extends Error {}

/** Ollama `POST /api/embed` on 127.0.0.1:11434. Refuses any other host before a request is made. Caches by text. */
export class OllamaEmbedder implements Embedder {
  readonly id: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: NonNullable<OllamaEmbedderOptions["fetch"]>;
  private readonly cache = new Map<string, number[]>();

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.model = opts.model ?? "qwen3-embedding:0.6b";
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    if (!isLoopbackUrl(this.baseUrl)) throw new EmbedderError(`Ollama must be on loopback (127.0.0.1); refusing ${this.baseUrl}`);
    this.batchSize = Math.max(1, opts.batchSize ?? 32);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.id = `ollama:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !this.cache.has(t)))];
    for (let i = 0; i < missing.length; i += this.batchSize) {
      const batch = missing.slice(i, i + this.batchSize);
      const res = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new EmbedderError(`Ollama /api/embed returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { embeddings?: unknown };
      const vecs = body.embeddings;
      if (!Array.isArray(vecs) || vecs.length !== batch.length || !vecs.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
        throw new EmbedderError(`Ollama /api/embed returned a malformed body for ${batch.length} inputs`);
      }
      batch.forEach((t, k) => this.cache.set(t, normalize([...(vecs[k] as number[])])));
    }
    return texts.map((t) => this.cache.get(t)!);
  }
}
