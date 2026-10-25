import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../../../schemas/frame-note.schema.json" with { type: "json" };
import { buildNote, maskCounterpart, maskFields } from "../../src/vision/notes.ts";
import { CaptionerFatalError, loopbackOrigin, NonLoopbackError, OllamaCaptioner, VISION_MODEL_PREFERENCE, type FetchLike } from "../../src/vision/ollama.ts";
import { SYSTEM_PROMPT, userPrompt } from "../../src/vision/prompt.ts";
import { captionJsonSchema, CaptionShapeError, coerceFields, limits, validateFrameNote } from "../../src/vision/schema.ts";
import { StubCaptioner } from "../../src/vision/stub.ts";
import type { CaptionInput, FrameRef } from "../../src/vision/types.ts";

const REF: FrameRef = { frameId: "01JB0000000000000000000001", ts: Date.UTC(2026, 9, 20, 10), day: "2026-10-20", app: "com.google.Chrome", appName: "Google Chrome", host: "app.ledgerly.test", phash: "0123456789abcdef", width: 1280, height: 800, bytes: 4, maskedRegions: 0 };
const INPUT: CaptionInput = { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), ref: REF };

const GOOD = { activity: "Entering a supplier bill from an attached PDF", verb: "entering", object: "supplier bill", counterpart: "a supplier", surface: "Ledgerly New bill", step: "copying line items", inputs: ["line items"], outputs: ["bill draft"], identifiers: ["INV-20431", "northwind.pdf"], confidence: 0.8 };

function ollamaReply(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }), { status, headers: { "content-type": "application/json" } });
}

function scripted(replies: Array<Response | Error | "hang">): { fetch: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const r = replies.shift() ?? new Error("no more replies");
    if (r === "hang") return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted by signal"))));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { fetch, calls };
}

const fast = { retries: 2, backoffMs: 0, sleep: async () => {} };

describe("s11 schema", () => {
  test("C1: a full note validates against the schema file", () => {
    const n = buildNote(REF, GOOD, "stub");
    expect(validateFrameNote(n)).toEqual({ ok: true, note: n });
    expect(n.kind).toBe("frame");
    expect(n.frameId).toBe(REF.frameId);
  });

  test("C1: unknown keys, wrong kind, over-long text and out-of-range confidence are rejected", () => {
    const n = buildNote(REF, GOOD, "stub");
    expect(validateFrameNote({ ...n, extra: 1 }).ok).toBe(false);
    expect(validateFrameNote({ ...n, kind: "ocr" }).ok).toBe(false);
    expect(validateFrameNote({ ...n, activity: "x".repeat(201) }).ok).toBe(false);
    expect(validateFrameNote({ ...n, confidence: 1.2 }).ok).toBe(false);
    expect(validateFrameNote({ ...n, inputs: Array.from({ length: 9 }, (_, i) => `i${i}`) }).ok).toBe(false);
    const { activity: _a, ...noActivity } = n;
    expect(validateFrameNote(noActivity).ok).toBe(false);
  });

  test("C1: the validator reads its limits from the schema file", () => {
    expect(limits("activity").maxLength).toBe(schema.properties.activity.maxLength);
    expect(limits("identifiers").maxItems).toBe(schema.properties.identifiers.maxItems);
    const js = captionJsonSchema() as { required: string[]; properties: Record<string, unknown> };
    expect(js.required).toEqual(["activity", "verb", "object", "counterpart", "surface", "step", "inputs", "outputs", "identifiers", "confidence"]);
  });

  test("C1: coerceFields trims model output into the schema limits", () => {
    const f = coerceFields({ activity: `Reviewing ${"very ".repeat(60)}long`, verb: "x".repeat(60), inputs: Array.from({ length: 20 }, (_, i) => `input ${i}`), identifiers: ["Harbor Logistics", "D-1190", "report.pdf", "D-1190"], confidence: 85, junk: true, counterpart: "N/A" });
    expect([...f.activity].length).toBeLessThanOrEqual(200);
    expect(f.verb!.length).toBeLessThanOrEqual(40);
    expect(f.inputs).toHaveLength(8);
    expect(f.identifiers).toEqual(["D-1190", "report.pdf"]);
    expect(f.confidence).toBe(0.85);
    expect(f.counterpart).toBeUndefined();
    expect("junk" in f).toBe(false);
    expect(coerceFields({ activity: "Reading", confidence: -3 }).confidence).toBe(0);
    expect(coerceFields({ activity: "Reading" }).confidence).toBe(0.5);
    expect(() => coerceFields({ activity: "  " })).toThrow(CaptionShapeError);
    expect(() => coerceFields([1, 2])).toThrow(CaptionShapeError);
  });
});

describe("s11 stub", () => {
  test("C2: the stub is deterministic and offline", async () => {
    const a = new StubCaptioner();
    const b = new StubCaptioner();
    expect(await a.caption(INPUT)).toEqual(await b.caption(INPUT));
    expect(await a.health()).toEqual({ ok: true, detail: "stub" });
    expect(a.id).toBe("stub");
    const note = buildNote(REF, maskFields(await a.caption(INPUT)), a.id);
    expect(validateFrameNote(note).ok).toBe(true);
    expect(buildNote(REF, maskFields(await b.caption(INPUT)), b.id)).toEqual(note);
  });

  test("C2: note ids are deterministic ULIDs of the frame time", () => {
    const n1 = buildNote(REF, GOOD, "stub");
    const n2 = buildNote(REF, GOOD, "stub");
    expect(n1.id).toBe(n2.id);
    expect(n1.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(buildNote(REF, GOOD, "ollama:x").id).not.toBe(n1.id);
    expect(buildNote({ ...REF, ts: REF.ts + 1000 }, GOOD, "stub").id > n1.id).toBe(true);
  });
});

describe("s11 ollama", () => {
  test("C3: sends structured-output chat with the image to the local server and parses the reply", async () => {
    const s = scripted([ollamaReply(GOOD)]);
    const c = new OllamaCaptioner({ model: "qwen3-vl:2b-instruct", fetch: s.fetch, ...fast });
    expect(await c.caption(INPUT)).toEqual(coerceFields(GOOD));
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(call.init.redirect).toBe("error");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown> & { messages: Array<{ role: string; images?: string[] }>; options: Record<string, unknown> };
    expect(body.model).toBe("qwen3-vl:2b-instruct");
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options.temperature).toBe(0);
    expect(body.format).toEqual(captionJsonSchema());
    expect(body.messages[1]!.images).toEqual([Buffer.from(INPUT.image).toString("base64")]);
    expect(c.id).toBe("ollama:qwen3-vl:2b-instruct");
  });

  test("C3: retries 5xx, network errors and invalid JSON, then succeeds", async () => {
    const s = scripted([ollamaReply("oops", 500), new Error("ECONNRESET"), ollamaReply("not json {"), ollamaReply(GOOD)]);
    const c = new OllamaCaptioner({ model: "m:1", fetch: s.fetch, retries: 3, backoffMs: 0, sleep: async () => {} });
    expect((await c.caption(INPUT)).activity).toBe(GOOD.activity);
    expect(s.calls).toHaveLength(4);
  });

  test("C3: gives up after the retries with the last error", async () => {
    const s = scripted([ollamaReply("x", 503), ollamaReply("x", 503), ollamaReply("x", 503)]);
    const c = new OllamaCaptioner({ model: "m:1", fetch: s.fetch, ...fast });
    await expect(c.caption(INPUT)).rejects.toThrow("HTTP 503");
    expect(s.calls).toHaveLength(3);
  });

  test("C3: each attempt times out", async () => {
    const s = scripted(["hang", "hang"]);
    const c = new OllamaCaptioner({ model: "m:1", fetch: s.fetch, timeoutMs: 20, retries: 1, backoffMs: 0, sleep: async () => {} });
    await expect(c.caption(INPUT)).rejects.toThrow("did not answer within 20 ms");
    expect(s.calls).toHaveLength(2);
  });

  test("C3: a missing model is fatal and not retried", async () => {
    const s = scripted([ollamaReply({ error: "model not found" }, 404)]);
    const c = new OllamaCaptioner({ model: "m:1", fetch: s.fetch, ...fast });
    await expect(c.caption(INPUT)).rejects.toBeInstanceOf(CaptionerFatalError);
    expect(s.calls).toHaveLength(1);
  });

  test("C3: health reports whether the model is pulled; auto picks the best pulled qwen3-vl", async () => {
    const tags = (names: string[]) => new Response(JSON.stringify({ models: names.map((n) => ({ name: n, model: n })) }), { status: 200 });
    const missing = new OllamaCaptioner({ model: "qwen3-vl:8b-instruct", fetch: scripted([tags(["qwen3:8b"])]).fetch });
    expect(await missing.health()).toEqual({ ok: false, detail: "model qwen3-vl:8b-instruct is not pulled (ollama pull qwen3-vl:8b-instruct)" });
    const auto = new OllamaCaptioner({ fetch: scripted([tags(["qwen3:8b", "qwen3-vl:2b-instruct", "qwen3-vl:4b-instruct"])]).fetch });
    expect(auto.model).toBe("auto");
    expect((await auto.health()).ok).toBe(true);
    expect(auto.model).toBe("qwen3-vl:4b-instruct");
    expect(auto.id).toBe("ollama:qwen3-vl:4b-instruct");
    expect(VISION_MODEL_PREFERENCE[0]).toBe("qwen3-vl:8b-instruct");
    const none = new OllamaCaptioner({ fetch: scripted([tags(["qwen3:8b"])]).fetch });
    await expect(none.caption(INPUT)).rejects.toBeInstanceOf(CaptionerFatalError);
    const down = new OllamaCaptioner({ fetch: scripted([new Error("ECONNREFUSED")]).fetch });
    expect((await down.health()).detail).toContain("ollama unreachable at http://127.0.0.1:11434");
  });
});

describe("s11 privacy", () => {
  test("C4: non-loopback Ollama URLs are refused before any request", () => {
    let fetched = 0;
    const fetch: FetchLike = async () => {
      fetched += 1;
      return new Response("{}");
    };
    for (const url of ["http://10.0.0.5:11434", "http://192.168.1.2:11434", "https://127.0.0.1:11434", "http://example.com", "http://127.0.0.1.evil.com", "http://user:pw@127.0.0.1:11434", "http://[::2]:11434", "http://0.0.0.0:11434", "http://ollama.local:11434", "file:///tmp/x", "not a url"]) {
      expect(() => new OllamaCaptioner({ url, fetch })).toThrow(NonLoopbackError);
    }
    expect(fetched).toBe(0);
  });

  test("C4: loopback forms are accepted and localhost is pinned to 127.0.0.1", () => {
    expect(loopbackOrigin("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(loopbackOrigin("http://localhost:11434/")).toBe("http://127.0.0.1:11434");
    expect(loopbackOrigin("http://[::1]:11434")).toBe("http://[::1]:11434");
    expect(loopbackOrigin("http://127.1.2.3:8080/api")).toBe("http://127.1.2.3:8080");
  });

  test("C4: vision code never imports the Claude model or the Agent SDK; only vision/claude.ts uses the Anthropic SDK", () => {
    // s14 scope change (ADR 0007 rev, ADR 0008): images may go to the user's own Anthropic account through
    // vision/claude.ts only (host-guarded to api.anthropic.com, masked by the engine first). Nothing else in vision does.
    const dir = join(import.meta.dir, "../../src/vision");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/models\/model|claude-agent-sdk/);
      if (f !== "claude.ts") expect(src).not.toMatch(/@anthropic-ai/);
    }
    // And the Claude model module does not import vision.
    expect(readFileSync(join(import.meta.dir, "../../src/models/model.ts"), "utf8")).not.toMatch(/vision\//);
  });
});

describe("s11 prompt", () => {
  test("C5: the prompt is domain-agnostic and asks for every schema field", () => {
    for (const word of ["email", "Gmail", "invoice", "CRM", "Xero", "Greenhouse", "outreach", "investor"]) expect(SYSTEM_PROMPT.toLowerCase()).not.toContain(word.toLowerCase());
    for (const f of ["activity", "verb", "object", "counterpart", "surface", "step", "inputs", "outputs", "identifiers", "confidence"]) expect(SYSTEM_PROMPT).toContain(`- ${f}:`);
    expect(SYSTEM_PROMPT).toContain("Never a person's name");
    expect(SYSTEM_PROMPT).toContain("Black rectangles are redacted");
  });

  test("C5: the user turn carries the app, host and optional role/industry as hints", () => {
    const p = userPrompt(REF, { role: "bookkeeper", industry: "bakeries\n\u0007" });
    expect(p).toContain("Frontmost app: Google Chrome.");
    expect(p).toContain("Web site: app.ledgerly.test.");
    expect(p).toContain("bookkeeper, bakeries");
    expect(p).not.toContain("\u0007");
    expect(userPrompt({ ...REF, app: undefined, appName: undefined, host: undefined })).toBe("Write the JSON note for this screenshot.");
  });

  test("C5: a counterpart that is a bare person name becomes <name>; organisations and roles stay", () => {
    for (const n of ["Elena", "Jordan Mehta", "Dana J. Whitfield", "Maria Lopez"]) expect(maskCounterpart(n)).toBe("<name>");
    for (const o of ["Harbor Logistics", "Acme Bakery Ltd", "a customer", "HubSpot", "Brightline Foods", "the finance team"]) expect(maskCounterpart(o)).toBe(o);
    expect(maskFields({ activity: "Writing an email", counterpart: "Elena", confidence: 0.9 }).counterpart).toBe("<name>");
  });

  test("C5: note text is masked with maskText before storage", () => {
    const m = maskFields({ activity: "Replying to dana@corvid-studio.com about order 99214 on 21/10/2026", verb: "replying", counterpart: "dana@corvid-studio.com", inputs: ["https://help.example.com/t/58213"], identifiers: ["INV-20431", "dana@corvid-studio.com"], confidence: 0.7 });
    const all = JSON.stringify(m);
    expect(all).not.toContain("dana@corvid-studio.com");
    expect(all).not.toContain("99214");
    expect(all).not.toContain("help.example.com/t");
    expect(m.activity).toContain("<email>");
    expect(m.counterpart).toBe("<email>");
    expect(validateFrameNote(buildNote(REF, m, "stub")).ok).toBe(true);
  });
});
