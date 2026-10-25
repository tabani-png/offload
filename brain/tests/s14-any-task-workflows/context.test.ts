// CONTEXT: GET/PUT /context, storage, validation; the context reaches prompts only inside the marked block and changes
// no number. DEFAULTS: status understanding block, CLI flags, model roles.
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { analyzeHome } from "../../src/analyze.ts";
import { parseArgs } from "../../src/cli.ts";
import { createBrain } from "../../src/api/server.ts";
import { contextPath, readUserContext } from "../../src/context/store.ts";
import { DEFAULT_MODELS, modelFor, StubModel, type ModelRequest } from "../../src/models/model.ts";
import { buildPlan } from "../../src/plan/build.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { draftGeneralWorkflow } from "../../src/workflows/drafter.ts";
import { freshHome, NOW, persona, reportNow, tmp } from "./setup.ts";

const TOKEN = "c".repeat(40);
function brainAt(home: string, extra: Partial<Parameters<typeof createBrain>[0]> = {}) {
  return createBrain({ home, token: TOKEN, now: () => NOW, ...extra });
}
const req = (path: string, method = "GET", body?: unknown, type = "application/json") =>
  new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1", ...(body === undefined ? {} : { "content-type": type }) }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

describe("s14 context: the one onboarding question", () => {
  test("CONTEXT: GET /context is empty with suggestions before onboarding", async () => {
    const res = await brainAt(tmp()).handle(req("/context"));
    expect(res.status).toBe(200);
    const b = (await res.json()) as { context: object; updatedAt: number | null; suggestions: { roles: string[]; industries: string[] } };
    expect(b.context).toEqual({});
    expect(b.updatedAt).toBeNull();
    expect(b.suggestions.roles).toContain("Recruiter");
    expect(b.suggestions.industries).toContain("Accounting");
  });

  test("CONTEXT: PUT stores role and industry (0600), trimmed; a later PUT can clear one field", async () => {
    const home = tmp();
    const brain = brainAt(home);
    const r1 = await brain.handle(req("/context", "PUT", { role: "  Bookkeeper ", industry: "Accounting" }));
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { context: object }).context).toEqual({ role: "Bookkeeper", industry: "Accounting" });
    expect(statSync(contextPath(home)).mode & 0o777).toBe(0o600);
    await brain.handle(req("/context", "PUT", { industry: null }));
    expect(readUserContext(home).context).toEqual({ role: "Bookkeeper" });
    await brain.handle(req("/context", "PUT", { role: "" }));
    expect(readUserContext(home).context).toBeUndefined();
  });

  test("CONTEXT: PUT refuses unknown keys, non-strings, several lines, over 80 characters and non-JSON", async () => {
    const brain = brainAt(tmp());
    for (const body of [{ name: "x" }, { role: 3 }, { role: "a\nb" }, { industry: "x".repeat(81) }]) expect((await brain.handle(req("/context", "PUT", body))).status).toBe(400);
    expect((await brain.handle(req("/context", "PUT", "{nope"))).status).toBe(400);
    expect((await brain.handle(req("/context", "PUT", { role: "x" }, "text/plain"))).status).toBe(400);
    expect((await brain.handle(req("/context", "POST", {}))).status).toBe(405);
  });

  test("CONTEXT: the stored context reaches the design and step prompts inside the marked block only", async () => {
    const { home, v2 } = await freshHome("support");
    await brainAt(home).handle(req("/context", "PUT", { role: "Support agent", industry: "E-commerce" }));
    const seen: ModelRequest[] = [];
    const model = new StubModel({ workflow_design: (r) => (seen.push(r), "{}"), step: (r) => (seen.push(r), "Hi,\n\nOn it.\n\nKim") });
    const user = readUserContext(home).context!;
    const { workflow } = await draftGeneralWorkflow({ home, analysis: v2, insightId: v2.insights[0]!.id, model, user, now: () => NOW });
    await dryRun({ home, analysis: v2, workflowId: workflow.id, model, now: () => NOW, limit: 1 });
    expect(seen.map((r) => r.role)).toEqual(["workflow_design", "workflow_design", "step"]);
    for (const r of seen) {
      const block = /<user_context note="[^"]*">\n([\s\S]*?)\n<\/user_context>/.exec(r.prompt)?.[1];
      expect(block).toBe("role: Support agent\nindustry: E-commerce");
      expect(r.system).not.toContain("Support agent");
      expect(r.prompt.split("Support agent").length).toBe(2);
    }
  });

  test("CONTEXT: with or without context every figure, score, saving, variant and probe number is the same", async () => {
    const { home } = await persona("recruiter");
    const plain = await analyzeHome(home, { now: reportNow, understanding: "v2" });
    const ctx = await analyzeHome(home, { now: reportNow, understanding: "v2", userContext: { role: "Recruiter", industry: "Recruiting" } });
    const nums = (a: typeof plain) => a.insights.map((i) => [i.id, i.stats, i.score, i.saving, i.judge.judgement, i.judge.risk, i.connectors.reachability]);
    expect(nums(ctx)).toEqual(nums(plain));
    const p1 = await buildPlan({ analysis: plain, insight: plain.insights[0]!, model: new StubModel(), models: { ...DEFAULT_MODELS } });
    const p2 = await buildPlan({ analysis: ctx, insight: ctx.insights[0]!, model: new StubModel(), models: { ...DEFAULT_MODELS }, user: { role: "Recruiter", industry: "Recruiting" } });
    expect(p2.plan).toEqual(p1.plan);
  });

  test("CONTEXT: serve uses the stored context and re-analyses when it changes", async () => {
    const { home } = await freshHome("bookkeeper");
    const brain = brainAt(home, { analyze: { understanding: "v2" } });
    const ins1 = (await (await brain.handle(req("/insights"))).json()) as { insights: Array<{ figures: unknown }> };
    await brain.handle(req("/context", "PUT", { role: "Bookkeeper" }));
    const ins2 = (await (await brain.handle(req("/insights"))).json()) as { insights: Array<{ figures: unknown }> };
    expect(ins2.insights.map((i) => i.figures)).toEqual(ins1.insights.map((i) => i.figures));
    expect(readFileSync(contextPath(home), "utf8")).toContain("Bookkeeper");
  });
});

describe("s14 defaults", () => {
  test("DEFAULTS: GET /status says which task finder ran (v1, or v2 with the embedder and notes read)", async () => {
    const { home } = await freshHome("support");
    const s1 = (await (await brainAt(home).handle(req("/status"))).json()) as { understanding: object };
    expect(s1.understanding).toEqual({ version: "v1", embedder: null, framesRead: 0 });
    const s2 = (await (await brainAt(home, { analyze: { understanding: "v2" } }).handle(req("/status"))).json()) as { understanding: { version: string; embedder: string; framesRead: number } };
    expect(s2.understanding.version).toBe("v2");
    expect(s2.understanding.embedder).toMatch(/^stub/);
    expect(s2.understanding.framesRead).toBeGreaterThan(100);
  });

  test("DEFAULTS: the app's serve flags parse; draft and dry-run take the understanding flags too", () => {
    const a = parseArgs(["serve", "--home", "/h", "--understanding", "v2", "--embedder", "ollama", "--embed-model", "qwen3-embedding:0.6b", "--captioner", "ollama"]);
    expect([a.understanding, a.embedder, a.captioner]).toEqual(["v2", "ollama", "ollama"]);
    expect(parseArgs(["draft", "--home", "/h", "--insight", "1", "--understanding", "v2"]).understanding).toBe("v2");
    expect(parseArgs(["dry-run", "--home", "/h", "--workflow", "wf_abcd", "--understanding", "v2"]).understanding).toBe("v2");
    expect(() => parseArgs(["purge", "--home", "/h", "--understanding", "v2"])).toThrow();
  });

  test("DEFAULTS: design uses the best model, text steps the cheap one; the stub is deterministic for both", async () => {
    expect(modelFor("workflow_design", DEFAULT_MODELS)).toBe("claude-opus-5-5");
    expect(modelFor("step", DEFAULT_MODELS)).toBe("claude-sonnet-5-5");
    const m = new StubModel();
    const p = '<source untrusted="true">\nRefund request\nCustomer: I want my money back\n</source>\n\nWrite the reply now.';
    const a = await m.complete({ role: "step", model: "x", system: "", prompt: p });
    expect(await m.complete({ role: "step", model: "x", system: "", prompt: p })).toBe(a);
    expect(a).toContain('"Refund request"');
    expect(await m.complete({ role: "workflow_design", model: "x", system: "", prompt: "<baseline>\n{\"variants\":[]}\n</baseline>" })).toBe('{"variants":[]}');
  });
});
