// AC-3 EMBED: deterministic stub; Ollama on loopback only, batched, cached, strict about replies. Live test opt-in.
import { describe, expect, test } from "bun:test";
import { cosine, EmbedderError, isLoopbackUrl, OllamaEmbedder, StubEmbedder } from "../../src/understanding/embed.ts";

type FakeFetch = NonNullable<ConstructorParameters<typeof OllamaEmbedder>[0]>["fetch"];

function fakeOllama(dim = 4, reply?: (input: string[]) => unknown, status = 200): { fetch: FakeFetch; calls: Array<{ url: string; body: { model: string; input: string[] } }> } {
  const calls: Array<{ url: string; body: { model: string; input: string[] } }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as { model: string; input: string[] };
      calls.push({ url, body });
      const out = reply ? reply(body.input) : { embeddings: body.input.map((t) => Array.from({ length: dim }, (_, i) => t.length + i)) };
      return { ok: status === 200, status, json: async () => out, text: async () => JSON.stringify(out) };
    },
  };
}

describe("EMBED stub", () => {
  test("deterministic and unit norm", async () => {
    const e = new StubEmbedder();
    const [a, b] = await e.embed(["Reading a supplier invoice PDF", "Reading a supplier invoice PDF"]);
    expect(a).toEqual(b!);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(cosine(a!, b!)).toBeCloseTo(1, 6);
  });
  test("related descriptions are closer than unrelated ones", async () => {
    const [a, b, c] = await new StubEmbedder().embed(["Keying a supplier bill into Xero", "Entering a supplier bill in Xero", "Scrolling the LinkedIn feed"]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!) + 0.2);
  });
});

describe("EMBED ollama", () => {
  test("loopback only: any other host is refused before a request", () => {
    const f = fakeOllama();
    for (const url of ["http://10.0.0.5:11434", "https://api.example.com", "http://127.0.0.1.evil.com:11434", "file:///tmp/x"]) {
      expect(() => new OllamaEmbedder({ baseUrl: url, fetch: f.fetch })).toThrow(EmbedderError);
    }
    expect(f.calls.length).toBe(0);
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:11434")).toBe(true);
  });

  test("POST /api/embed with the model, in batches, cached by text", async () => {
    const f = fakeOllama();
    const e = new OllamaEmbedder({ fetch: f.fetch, batchSize: 2 });
    expect(e.id).toBe("ollama:qwen3-embedding:0.6b");
    const v = await e.embed(["a", "bb", "ccc", "a"]);
    expect(v.length).toBe(4);
    expect(v[0]).toEqual(v[3]!);
    expect(f.calls.map((c) => c.url)).toEqual(["http://127.0.0.1:11434/api/embed", "http://127.0.0.1:11434/api/embed"]);
    expect(f.calls.map((c) => c.body.input)).toEqual([["a", "bb"], ["ccc"]]);
    expect(f.calls[0]!.body.model).toBe("qwen3-embedding:0.6b");
    await e.embed(["bb"]);
    expect(f.calls.length).toBe(2);
    expect(new OllamaEmbedder({ model: "bge-m3", fetch: f.fetch }).id).toBe("ollama:bge-m3");
  });

  test("malformed replies and HTTP errors throw (no silent fallback)", async () => {
    const short = fakeOllama(4, () => ({ embeddings: [[1, 2]] }));
    await expect(new OllamaEmbedder({ fetch: short.fetch }).embed(["a", "b"])).rejects.toThrow(EmbedderError);
    const nan = fakeOllama(4, () => ({ embeddings: [["x"]] }));
    await expect(new OllamaEmbedder({ fetch: nan.fetch }).embed(["a"])).rejects.toThrow(EmbedderError);
    const down = fakeOllama(4, () => ({ error: "model not found" }), 404);
    await expect(new OllamaEmbedder({ fetch: down.fetch }).embed(["a"])).rejects.toThrow(/404/);
  });

  test.skipIf(process.env.OFFLOAD_TEST_OLLAMA !== "1")("live: qwen3-embedding on 127.0.0.1 ranks related text closer", async () => {
    const [a, b, c] = await new OllamaEmbedder().embed(["Keying a supplier bill into Xero", "Entering an invoice as a bill in Xero", "Scrolling the LinkedIn feed"]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
});
