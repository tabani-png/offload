// ROUTER: routes -> tiers, the escalation ladder, demotion/promotion of per-item steps, budget degrade and block, the
// API backend's request shape (stubbed fetch only: no real call), and the usage endpoints.
// CLAUDE: the Claude captioner (stubbed SDK HTTP), host guard, refusal, usage; selection under auto/claude.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chooseVision } from "../../src/cli.ts";
import { createBrain } from "../../src/api/server.ts";
import { ApiBackend, apiParams, classifyApiError } from "../../src/models/api-backend.ts";
import { StubModel } from "../../src/models/model.ts";
import { BudgetError, costOf, ModelBackend, ModelRouter, PROVEN_RUNS, RoutedModel, type Backend, type BackendReply, type BackendRequest } from "../../src/models/router.ts";
import { anthropicOrigin, CaptionRefusedError, claudeCaptionSchema, ClaudeCaptioner, NonAnthropicHostError, resolveAnthropicKey } from "../../src/vision/claude.ts";
import { RoutedCaptioner } from "../../src/vision/routed.ts";
import { StubCaptioner } from "../../src/vision/stub.ts";
import type { Captioner, FrameRef } from "../../src/vision/types.ts";
import { CaptionWorker } from "../../src/vision/worker.ts";
import type { FrameSource } from "../../src/vision/frames.ts";
import { tmp } from "./setup.ts";

class FakeBackend implements Backend {
  readonly kind = "api" as const;
  readonly metered = true;
  readonly calls: BackendRequest[] = [];
  constructor(private readonly answer: (r: BackendRequest) => Partial<BackendReply>) {}
  async complete(r: BackendRequest): Promise<BackendReply> {
    this.calls.push(r);
    const a = this.answer(r);
    return { text: "ok", stopReason: "end_turn", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 }, model: r.model, ...a };
  }
}

const req = (role: "draft" | "bucket" | "workflow_design" | "step" | "refine" | "explain", extra: object = {}) => ({ role, model: "ignored", system: "fixed system text", prompt: "the prompt", ...extra });

describe("s14 router: routes and the ladder", () => {
  test("ROUTER: each route starts on its tier: design/explain Opus with high effort and adaptive thinking, drafts Sonnet, classify/refine Haiku", async () => {
    const b = new FakeBackend(() => ({}));
    const r = new ModelRouter({ home: tmp(), backend: b, monthlyBudgetUsd: null });
    for (const role of ["workflow_design", "explain", "draft", "step", "bucket", "refine"] as const) await r.complete(req(role));
    expect(b.calls.map((c) => [c.route, c.model, c.effort, c.adaptiveThinking])).toEqual([
      ["design", "claude-opus-5-5", "high", true],
      ["explain", "claude-opus-5-5", "high", true],
      ["draft", "claude-sonnet-5-5", "medium", false],
      ["item_step", "claude-sonnet-5-5", "medium", false],
      ["classify", "claude-haiku-5-5", "low", false],
      ["refine", "claude-haiku-5-5", "low", false],
    ]);
    expect(r.modelFor("caption")).toBe("claude-haiku-5-5");
    // s13 seam: computer-use steps are execution.
    expect(r.pickModel("computer.step", { targetId: "web-x", turn: 0 })).toBe("claude-sonnet-5-5");
  });

  test("ROUTER: Haiku -> Sonnet -> Opus on refusal, a cut-off reply or a failed check, with the reasons kept", async () => {
    const b = new FakeBackend((c) => (c.model === "claude-haiku-5-5" ? { stopReason: "refusal" } : c.model === "claude-sonnet-5-5" ? { text: "bad" } : { text: "good" }));
    const r = new ModelRouter({ home: tmp(), backend: b, monthlyBudgetUsd: null });
    const out = await r.complete(req("refine", { validate: (t: string) => (t === "good" ? null : "not good") }));
    expect(out).toBe("good");
    const d = r.recentDecisions().at(-1)!;
    expect(d.tiers).toEqual(["haiku", "sonnet", "opus"]);
    expect(d.escalations).toEqual(["haiku declined", "sonnet: not good"]);
    expect(d.model).toBe("claude-opus-5-5");
    const cut = new ModelRouter({ home: tmp(), backend: new FakeBackend((c) => (c.model === "claude-haiku-5-5" ? { stopReason: "max_tokens" } : {})), monthlyBudgetUsd: null });
    await cut.complete(req("bucket"));
    expect(cut.recentDecisions()[0]!.escalations).toEqual(["haiku reply was cut off"]);
  });

  test("ROUTER: when every tier declines, a RefusalError is thrown and the decision is still recorded", async () => {
    const r = new ModelRouter({ home: tmp(), backend: new FakeBackend(() => ({ stopReason: "refusal" })), monthlyBudgetUsd: null });
    await expect(r.complete(req("bucket"))).rejects.toThrow("every model declined");
    expect(r.recentDecisions()[0]!.tiers).toEqual(["haiku", "sonnet", "opus"]);
  });

  test(`ROUTER: a per-item step moves to Haiku after ${PROVEN_RUNS} clean runs; an edit, a failed check or a refusal promotes it back`, async () => {
    const b = new FakeBackend(() => ({}));
    const r = new ModelRouter({ home: tmp(), backend: b, monthlyBudgetUsd: null });
    const key = "wf_x/draft_1";
    for (let i = 0; i < PROVEN_RUNS; i++) await r.complete(req("step", { stepKey: key }));
    expect(b.calls.slice(0, PROVEN_RUNS).every((c) => c.model === "claude-sonnet-5-5")).toBe(true);
    await r.complete(req("step", { stepKey: key }));
    expect(b.calls.at(-1)!.model).toBe("claude-haiku-5-5");
    r.recordUserEdit(key);
    await r.complete(req("step", { stepKey: key }));
    expect(b.calls.at(-1)!.model).toBe("claude-sonnet-5-5");
    for (let i = 0; i < PROVEN_RUNS; i++) await r.complete(req("step", { stepKey: key }));
    expect(r.startTier("item_step", key)).toBe("haiku");
    const failing = new ModelRouter({ home: (r as unknown as { o: { home: string } }).o.home, backend: new FakeBackend((c) => (c.model === "claude-haiku-5-5" ? { text: "" } : {})), monthlyBudgetUsd: null });
    await failing.complete(req("step", { stepKey: key, validate: (t: string) => (t === "" ? "empty draft" : null) }));
    expect(failing.startTier("item_step", key)).toBe("sonnet");
  });

  test("ROUTER: cost per route at the model's price; captions go local at 80% of the budget; paid routes stop at the cap", async () => {
    const home = tmp();
    // 1000 in + 100 out on Opus = 0.004 + 0.002 = $0.006 per call.
    expect(costOf("claude-opus-5-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 })).toBe(0.006);
    const r = new ModelRouter({ home, backend: new FakeBackend(() => ({})), monthlyBudgetUsd: 0.03 });
    for (let i = 0; i < 3; i++) await r.complete(req("workflow_design"));
    expect(r.spentUsd()).toBe(0.018);
    expect(r.captionOnClaude()).toBe(true);
    await r.complete(req("workflow_design"));
    expect(r.spentUsd()).toBe(0.024);
    expect(r.captionOnClaude()).toBe(false);
    expect(r.blocked()).toBe(false);
    await r.complete(req("workflow_design"));
    expect(r.blocked()).toBe(true);
    await expect(r.complete(req("draft"))).rejects.toBeInstanceOf(BudgetError);
    const s = r.summary();
    expect(s).toMatchObject({ backend: "api", budgetUsd: 0.03, captionsLocal: true, blocked: true });
    expect(s.needsYou).toContain("budget is spent");
    expect(s.routes.design).toMatchObject({ calls: 5, costUsd: 0.03, tier: "opus", model: "claude-opus-5-5" });
    const ledger = readFileSync(join(home, "model-usage.json"), "utf8");
    expect(ledger).not.toContain("the prompt");
    expect(ledger).not.toContain("fixed system text");
  });

  test("ROUTER: the budget comes from models.json or OFFLOAD_MONTHLY_BUDGET_USD; the stub and the Claude Code login are never blocked", async () => {
    const home = tmp();
    expect(new ModelRouter({ home, backend: new FakeBackend(() => ({})), env: { OFFLOAD_MONTHLY_BUDGET_USD: "12.5" } }).budget()).toBe(12.5);
    const stub = new ModelRouter({ home, backend: new ModelBackend("stub", new StubModel()), monthlyBudgetUsd: 0 });
    expect(await stub.complete(req("bucket", { prompt: "<bucket_hint>other</bucket_hint>" }))).toBe("other");
    const cc = new ModelRouter({ home: tmp(), backend: new ModelBackend("claude-code", new StubModel()), monthlyBudgetUsd: null });
    expect(cc.summary().needsYou).toContain("Add a Claude key");
  });

  test("ROUTER: GET /status carries the router summary and GET /models/usage the ledger, prices and recent decisions", async () => {
    const home = tmp();
    const model = new RoutedModel(new ModelRouter({ home, backend: new ModelBackend("stub", new StubModel()), monthlyBudgetUsd: 5 }));
    await model.complete(req("bucket", { prompt: "<bucket_hint>other</bucket_hint>" }));
    const token = "r".repeat(40);
    const brain = createBrain({ home, token, workflows: { model, modelLabel: "stub" } });
    const get = async (p: string) => (await brain.handle(new Request(`http://127.0.0.1${p}`, { headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" } }))).json();
    const st = (await get("/status")) as { models: { backend: string; budgetUsd: number; routes: { classify: { calls: number } } } };
    expect(st.models).toMatchObject({ backend: "stub", budgetUsd: 5 });
    expect(st.models.routes.classify.calls).toBe(1);
    const u = (await get("/models/usage")) as { decisions: Array<{ route: string }>; prices: Record<string, unknown>; provenRuns: number };
    expect(u.decisions[0]!.route).toBe("classify");
    expect(Object.keys(u.prices)).toContain("claude-haiku-5-5");
    expect(u.provenRuns).toBe(PROVEN_RUNS);
  });
});

/** A fetch that answers like the Messages API; records every request. */
function fakeAnthropic(answer: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body === undefined || init.body === null ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    seen.push({ url, body, headers: new Headers(init?.headers) });
    const a = answer(body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  return { fetch: f, seen };
}

const message = (text: string, stop = "end_turn", model = "claude-haiku-5-5") => ({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
const NOTE = JSON.stringify({ activity: "Entering a supplier bill", verb: "enter", object: "bill", counterpart: "", surface: "Xero new bill", step: "copying the amount", inputs: ["amount"], outputs: ["draft bill"], identifiers: ["INV-10442"], confidence: 0.9 });
const REF: FrameRef = { frameId: "kf_1", ts: 1, day: "2026-10-25", app: "com.google.Chrome", appName: "Google Chrome", host: "go.xero.com", width: 1280, height: 800, bytes: 4, maskedRegions: 2 };
const ENV = { ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000" };

describe("s14 router: the Claude API backend (stubbed HTTP)", () => {
  test("ROUTER: Opus/Sonnet requests carry fallbacks \"default\" with its beta; the system prompt is cached; Haiku gets no fallback", () => {
    const base = { route: "design" as const, role: "workflow_design" as const, system: "S", prompt: "P", maxTokens: 100, effort: "high" as const, adaptiveThinking: true };
    const opus = apiParams({ ...base, model: "claude-opus-5-5" });
    expect(opus).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    expect(opus.system[0]).toEqual({ type: "text", text: "S", cache_control: { type: "ephemeral" } });
    const haiku = apiParams({ ...base, model: "claude-haiku-5-5", effort: "low", adaptiveThinking: false });
    expect("fallbacks" in haiku).toBe(false);
    expect("thinking" in haiku).toBe(false);
  });

  test("ROUTER: the backend reads stop_reason and usage from the reply and only ever calls api.anthropic.com", async () => {
    const api = fakeAnthropic(() => ({ json: message("hello", "refusal", "claude-opus-5-5") }));
    const b = new ApiBackend("sk-ant-test", { fetch: api.fetch, maxRetries: 0 });
    const r = await b.complete({ model: "claude-opus-5-5", route: "design", role: "workflow_design", system: "S", prompt: "P", maxTokens: 10, effort: "high", adaptiveThinking: true });
    expect(r).toMatchObject({ text: "hello", stopReason: "refusal", usage: { inputTokens: 1500, outputTokens: 120 } });
    expect(new URL(api.seen[0]!.url).host).toBe("api.anthropic.com");
    expect(api.seen[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(() => new ApiBackend("k", { baseURL: "https://evil.example.com" })).toThrow(NonAnthropicHostError);
  });

  test("ROUTER: typed SDK errors become plain, key-free reasons; 401 is not retried, 429 is", async () => {
    const api = fakeAnthropic(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-test" } } }));
    const b = new ApiBackend("sk-ant-test", { fetch: api.fetch, maxRetries: 0 });
    const err = (await b.complete({ model: "claude-sonnet-5-5", route: "draft", role: "draft", system: "S", prompt: "P", maxTokens: 10, effort: "medium", adaptiveThinking: false }).then(() => null, (e: unknown) => e)) as Error & { retryable: boolean };
    expect(err.message).toBe("Claude did not accept the account key (HTTP 401)");
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("sk-ant");
    expect(classifyApiError(new Error("x")).retryable).toBe(false);
  });
});

describe("s14 Claude captioner (stubbed HTTP)", () => {
  test("CLAUDE: only https://api.anthropic.com; the key from the env or a Keychain reference, never in errors", () => {
    expect(anthropicOrigin()).toBe("https://api.anthropic.com");
    for (const bad of ["http://api.anthropic.com", "https://api.anthropic.com.evil.test", "https://127.0.0.1", "https://u:p@api.anthropic.com", "https://api.anthropic.com:8443"]) expect(() => anthropicOrigin(bad)).toThrow(NonAnthropicHostError);
    expect(resolveAnthropicKey(ENV)).toEqual({ source: "env", key: ENV.ANTHROPIC_API_KEY });
    const calls: string[][] = [];
    const kc = resolveAnthropicKey({ OFFLOAD_ANTHROPIC_KEYCHAIN: "offload/claude" }, (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: "sk-kc\n" }));
    expect(kc).toEqual({ source: "keychain", key: "sk-kc" });
    expect(calls[0]).toEqual(["/usr/bin/security", "find-generic-password", "-s", "offload", "-a", "claude", "-w"]);
    expect(resolveAnthropicKey({ OFFLOAD_ANTHROPIC_KEYCHAIN: "bad;rm/x" }, () => ({ status: 0, stdout: "x" })).key).toBeNull();
    expect(resolveAnthropicKey({}).source).toBe("none");
  });

  test("CLAUDE: one request per frame: the masked JPEG as a base64 image block and structured output against the note schema", async () => {
    const api = fakeAnthropic(() => ({ json: message(NOTE) }));
    const c = new ClaudeCaptioner({ env: ENV, fetch: api.fetch, maxRetries: 0 });
    const f = await c.caption({ image: new Uint8Array([1, 2, 3, 4]), ref: REF });
    expect(f).toMatchObject({ activity: "Entering a supplier bill", verb: "enter", identifiers: ["INV-10442"], confidence: 0.9 });
    const body = api.seen[0]!.body as { model: string; messages: Array<{ content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }> }>; output_config: { format: { type: string; schema: Record<string, unknown> } } };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.messages[0]!.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from([1, 2, 3, 4]).toString("base64") } });
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema).toEqual(claudeCaptionSchema());
    expect(claudeCaptionSchema()).toMatchObject({ additionalProperties: false, required: ["activity", "verb", "object", "counterpart", "surface", "step", "inputs", "outputs", "identifiers", "confidence"] });
    expect(new URL(api.seen[0]!.url).host).toBe("api.anthropic.com");
    expect(c.usage()).toMatchObject({ frames: 1, inputTokens: 1500, outputTokens: 120, lastFrame: { inputTokens: 1500, outputTokens: 120 } });
  });

  test("CLAUDE: stop_reason is checked first: a refusal is skipped at once (no paid retry), a cut-off note is an error", async () => {
    const refuse = fakeAnthropic(() => ({ json: message("", "refusal") }));
    const c = new ClaudeCaptioner({ env: ENV, fetch: refuse.fetch, maxRetries: 0 });
    await expect(c.caption({ image: new Uint8Array([1]), ref: REF })).rejects.toBeInstanceOf(CaptionRefusedError);
    expect(c.usage()).toMatchObject({ frames: 1, refusals: 1 });
    const cut = new ClaudeCaptioner({ env: ENV, fetch: fakeAnthropic(() => ({ json: message('{"activity":"Ent', "max_tokens") })).fetch, maxRetries: 0 });
    await expect(cut.caption({ image: new Uint8Array([1]), ref: REF })).rejects.toThrow("cut off");
    // The worker gives up on a refused frame after one attempt.
    const home = tmp();
    const source: FrameSource = { days: () => ["2026-10-25"], list: () => ({ frames: [REF] }), read: () => new Uint8Array([9]) } as unknown as FrameSource;
    const w = new CaptionWorker({ home, source, captioner: new ClaudeCaptioner({ env: ENV, fetch: refuse.fetch, maxRetries: 0 }), now: () => new Date(2026, 9, 25, 12).getTime(), log: () => {} });
    await w.runOnce();
    expect(w.status()).toMatchObject({ failed: 1, captioner: "claude" });
    // One caption call per refused frame (the worker's health check is a free model lookup, not a caption).
    expect(refuse.seen.filter((x) => x.url.includes("/v1/messages")).length).toBe(2);
  });

  test("CLAUDE: usage is counted per frame and priced by the router; GET /status shows it", async () => {
    const home = tmp();
    const router = new ModelRouter({ home, backend: new FakeBackend(() => ({})), monthlyBudgetUsd: null });
    const c = new ClaudeCaptioner({ env: ENV, fetch: fakeAnthropic(() => ({ json: message(NOTE) })).fetch, maxRetries: 0, router });
    await c.caption({ image: new Uint8Array([1]), ref: REF });
    await c.caption({ image: new Uint8Array([2]), ref: REF });
    // 1500 in + 120 out on Haiku = 0.00015 + 0.00006 = $0.00021 a frame.
    expect(c.usage()).toMatchObject({ frames: 2, inputTokens: 3000, outputTokens: 240, costUsd: 0.00042 });
    expect(router.summary().routes.caption).toMatchObject({ calls: 2, costUsd: 0.00042, model: "claude-haiku-5-5" });
  });

  test("CLAUDE: under the budget cap and without a key, screens fall back to the local model", async () => {
    const local = new StubCaptioner();
    const api = fakeAnthropic(() => ({ json: message(NOTE) }));
    let allowed = true;
    const r = new RoutedCaptioner(new ClaudeCaptioner({ env: ENV, fetch: api.fetch, maxRetries: 0 }), local, () => allowed);
    await r.caption({ image: new Uint8Array([1]), ref: REF });
    expect([r.active(), api.seen.length, local.calls]).toEqual(["claude", 1, 0]);
    allowed = false;
    await r.caption({ image: new Uint8Array([1]), ref: REF });
    expect([r.active(), api.seen.length, local.calls]).toEqual(["stub", 1, 1]);
    const nokey = new RoutedCaptioner(new ClaudeCaptioner({ env: {} }), local, () => true);
    await nokey.caption({ image: new Uint8Array([1]), ref: REF });
    expect(nokey.active()).toBe("stub");
    expect(local.calls).toBe(2);
  });

  test("CLAUDE: --captioner auto picks Claude with a key, else a healthy local model, else off with a needs-you line", async () => {
    const base = { home: tmp(), captioner: "auto" as const, visionModel: "auto", ollamaUrl: "http://127.0.0.1:11434", claudeVisionModel: "" };
    const healthy = { health: async () => ({ ok: true, detail: "ready" }), model: "qwen3-vl:2b-instruct" } as unknown as Captioner;
    const down = { health: async () => ({ ok: false, detail: "ollama unreachable" }), model: "auto" } as unknown as Captioner;
    const a = await chooseVision(base, { env: ENV, ollama: down as never });
    expect(a.label).toBe("auto: claude (local model as fallback)");
    const b = await chooseVision(base, { env: {}, ollama: healthy as never });
    expect(b.label).toBe("auto: ollama qwen3-vl:2b-instruct");
    const c = await chooseVision(base, { env: {}, ollama: down as never });
    expect(c.worker).toBeUndefined();
    expect(c.needsYou).toContain("add a Claude key");
    expect((await chooseVision({ ...base, captioner: "off" }, { env: ENV })).worker).toBeUndefined();
  });
});
