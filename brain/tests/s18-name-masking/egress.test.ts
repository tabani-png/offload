// EGRESS, REVIEW: with a capturing backend behind the real router, the whole pipeline (v2 analysis with the model
// labeler, workflow design and tool choice, dry runs, tone build, the founder's live run) sends no request containing
// a fixture person name; the real Claude HTTP bodies have none either. What the user reviews and approves is the real
// text, and the gate hash is computed on it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { generatePersona, writePersona, type PersonaId } from "../../fixtures/gen-domains.ts";
import { REPORT_START, reportNow } from "../../fixtures/domains-report.ts";
import { FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { ApiBackend } from "../../src/models/api-backend.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { ModelRouter, RoutedModel, type Backend, type BackendReply, type BackendRequest } from "../../src/models/router.ts";
import { FixtureMailSource } from "../../src/tone/mail-source.ts";
import { buildTonePack } from "../../src/tone/pack.ts";
import { draftInTone } from "../../src/tone/draft.ts";
import { PromptLabeler } from "../../src/understanding/context.ts";
import { understandingLabeler } from "../../src/understanding/labeler.ts";
import { ClaudeCaptioner } from "../../src/vision/claude.ts";
import { batchHash } from "../../src/workflows/batch.ts";
import { draftGeneralWorkflow, draftWorkflow } from "../../src/workflows/drafter.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { approveBatch, prepareLiveBatch } from "../../src/workflows/runner.ts";
import { readBatch } from "../../src/workflows/store.ts";
import { readableNames } from "./names.ts";

const homes: string[] = [];
const tmp = (p = "offload-s18e-") => {
  const h = mkdtempSync(join(tmpdir(), p));
  homes.push(h);
  return h;
};
process.on("exit", () => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** The stub model behind the router, recording exactly what a backend (Claude) would receive. */
class CaptureStub implements Backend {
  readonly kind = "stub" as const;
  readonly metered = false;
  readonly calls: BackendRequest[] = [];
  private readonly stub = new StubModel();
  async complete(r: BackendRequest): Promise<BackendReply> {
    this.calls.push(r);
    const text = await this.stub.complete({ role: r.role, model: r.model, system: r.system, prompt: r.prompt, maxTokens: r.maxTokens });
    return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, model: r.model };
  }
}

const routed = (home: string) => {
  const backend = new CaptureStub();
  const model = new RoutedModel(new ModelRouter({ home, backend, monthlyBudgetUsd: null }));
  return { backend, model };
};

const leaks = (calls: readonly BackendRequest[]) => calls.flatMap((c) => readableNames(`${c.system}\n${c.prompt}`).map((n) => `${c.role}: ${n}`));

/** Every file under `dir` (plain or sealed), read as text. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

const NOW = reportNow();

describe("s18 egress: no fixture name in any model request", () => {
  for (const p of ["recruiter", "bookkeeper", "support", "salesops", "mixed"] as PersonaId[]) {
    test(`EGRESS: ${p}: v2 analysis with the model labeler, workflow design, tool choice and the dry run send no name`, async () => {
      const home = tmp(`offload-s18e-${p}-`);
      writePersona(home, generatePersona(p, { seed: 7, startDay: REPORT_START }), { encrypted: false, seed: 7 });
      const { backend, model } = routed(home);
      const labeler = new PromptLabeler((prompt) => model.complete({ role: "label", model: "claude-opus-5-5", system: "", prompt }), understandingLabeler);
      const a = await analyzeHome(home, { now: reportNow, understanding: "v2", labeler });
      const top = a.insights[0]!;
      const { workflow } = await draftGeneralWorkflow({ home, analysis: a, insightId: top.id, model, now: () => NOW });
      const d = await dryRun({ home, analysis: a, workflowId: workflow.id, model, limit: 5, now: () => NOW });
      expect(d.general?.instances.length ?? 0).toBeGreaterThan(0);
      const roles = new Set(backend.calls.map((c) => c.role));
      expect(roles.has("label")).toBe(true);
      expect(roles.has("workflow_design")).toBe(true);
      expect(leaks(backend.calls)).toEqual([]);
    }, 120_000);
  }

  test("EGRESS: the recruiter's scorecard step sends the CV text with the candidate masked and gets it back by name", async () => {
    const home = tmp("offload-s18e-rec-");
    writePersona(home, generatePersona("recruiter", { seed: 7, startDay: REPORT_START }), { encrypted: false, seed: 7 });
    const { backend, model } = routed(home);
    const a = await analyzeHome(home, { now: reportNow, understanding: "v2" });
    const { workflow } = await draftGeneralWorkflow({ home, analysis: a, insightId: a.insights[0]!.id, model, now: () => NOW });
    await dryRun({ home, analysis: a, workflowId: workflow.id, model, limit: 3, now: () => NOW });
    const steps = backend.calls.filter((c) => c.role === "step");
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.prompt).toMatch(/<person:[a-z]{4}\.\d+>/);
    expect(leaks(steps)).toEqual([]);
  }, 120_000);

  test("EGRESS: founder week: tone build, the outreach dry run and a live run send no recipient, investor or own name", async () => {
    const home = tmp("offload-s18e-founder-");
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
    const { backend, model } = routed(home);
    const analysis = await analyzeHome(home, { now: () => now });
    await buildTonePack({ home, source: new FixtureMailSource(), model, models: DEFAULT_MODELS, now: () => now });
    const { workflow } = draftWorkflow({ home, analysis, insightId: analysis.insights[0]!.id, facts: FIXTURE_FACTS, now: () => now });
    writeFileSync(join(home, "workflows", workflow.id, "recipients.csv"), "email,first_name,last_name,org,notes\nanna@northzone.com,Anna,Berg,Northzone,\nleo.park@hustlefund.vc,Leo,Park,Hustle Fund,Leo backed Ramp early\ntom@seedcamp.com,Tom,Reid,Seedcamp,\n");
    const d = await dryRun({ home, analysis, workflowId: workflow.id, model, limit: 3, now: () => now });
    approveBatch(home, workflow.id, d.batchHash, now + 1);
    const live = await prepareLiveBatch({ home, workflowId: workflow.id, model, now: () => now + 10 });
    expect(new Set(backend.calls.map((c) => c.role))).toEqual(new Set(["style_card", "draft"]));
    expect(leaks(backend.calls)).toEqual([]);
    for (const c of backend.calls) expect(c.prompt).not.toMatch(/\bReid\b|leo\.park|Hustle Fund backed|Muhammad/);
    expect(live.items.length).toBe(3);
  }, 120_000);

  test("EGRESS: the real Claude API request body (stubbed HTTPS) carries placeholders, not names", async () => {
    const seen: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      seen.push(body);
      const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]!.content;
      const text = /"firstName":"(<person:[^>"]+>)"/.exec(prompt)?.[1] ?? "";
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Hi ${text},\n\nThanks.` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const home = tmp();
    const model = new RoutedModel(new ModelRouter({ home, backend: new ApiBackend("sk-ant-test-0000", { fetch, maxRetries: 0 }), monthlyBudgetUsd: null }));
    const d = await draftInTone({ pack: { corpus: [], cards: {} }, bucket: "investor_outreach", recipient: { email: "sofia.rossi@creandum.com", firstName: "Sofia", lastName: "Rossi", org: "Creandum" }, subject: "Offload <> Creandum", facts: FIXTURE_FACTS, model, models: DEFAULT_MODELS });
    expect(seen.length).toBe(1);
    expect(readableNames(seen[0]!, ["Sofia", "Rossi", "sofia.rossi", "Muhammad"])).toEqual([]);
    expect(seen[0]).toContain("<person:");
    expect(d.body).toBe("Hi Sofia,\n\nThanks.");
  });

  test("EGRESS: the Claude captioner's text turn carries no name from the onboarding context", async () => {
    const seen: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(init?.body ?? ""));
      const note = { activity: "Reviewing a CV", verb: "review", object: "CV", counterpart: "", surface: "Preview", step: "reading", inputs: [], outputs: [], identifiers: [], confidence: 0.8 };
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify(note) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = new ClaudeCaptioner({ env: { ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000" }, fetch, maxRetries: 0 });
    await c.caption({ image: new Uint8Array([1]), ref: { frameId: "kf", ts: 1, day: "2026-10-25", width: 1, height: 1, bytes: 1, maskedRegions: 0 }, context: { role: "Recruiter working for Priya Sharma" } });
    const textTurn = seen.find((b) => b.includes("/v1/messages") || b.includes("messages"))!;
    expect(textTurn).toContain("Recruiter working for <name>");
    expect(readableNames(textTurn, ["Priya", "Sharma"])).toEqual([]);
  });
});

describe("s18 review: what the user approves is the real text", () => {
  test("REVIEW: live batch items carry the real names, no placeholder, and the batch hash is computed on that text", async () => {
    const home = tmp("offload-s18e-review-");
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
    const { backend, model } = routed(home);
    const analysis = await analyzeHome(home, { now: () => now });
    await buildTonePack({ home, source: new FixtureMailSource(), model, models: DEFAULT_MODELS, now: () => now });
    const { workflow } = draftWorkflow({ home, analysis, insightId: analysis.insights[0]!.id, facts: FIXTURE_FACTS, now: () => now });
    writeFileSync(join(home, "workflows", workflow.id, "recipients.csv"), "email,first_name,last_name,org,notes\nanna@northzone.com,Anna,Berg,Northzone,\ntom@seedcamp.com,Tom,Reid,Seedcamp,\n");
    const d = await dryRun({ home, analysis, workflowId: workflow.id, model, limit: 2, now: () => now });
    approveBatch(home, workflow.id, d.batchHash, now + 1);
    const live = await prepareLiveBatch({ home, workflowId: workflow.id, model, now: () => now + 10 });
    const bodies = live.items.map((i) => i.body);
    expect(bodies[0]!.startsWith("Hi Anna,")).toBe(true);
    expect(bodies[1]!.startsWith("Hi Tom,")).toBe(true);
    for (const b of bodies) expect(b).not.toContain("<person:");
    expect(live.hash).toBe(batchHash(workflow.id, "live", live.items));
    const stored = readBatch(home, workflow.id, live.hash, now + 10)!;
    expect(stored.items.map((i) => i.body)).toEqual(bodies);
    // The drafts were written from placeholders: the backend never saw the recipient's name.
    expect(backend.calls.filter((c) => c.role === "draft").every((c) => !/\bAnna\b|\bTom\b/.test(c.prompt))).toBe(true);
  }, 120_000);

  test("REVIEW: approving the batch approves exactly the stored real text (a changed body is a new hash)", async () => {
    const home = tmp("offload-s18e-hash-");
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
    const { model } = routed(home);
    const analysis = await analyzeHome(home, { now: () => now });
    const { workflow } = draftWorkflow({ home, analysis, insightId: analysis.insights[0]!.id, facts: FIXTURE_FACTS, now: () => now });
    writeFileSync(join(home, "workflows", workflow.id, "recipients.csv"), "email,first_name,last_name,org,notes\nanna@northzone.com,Anna,Berg,Northzone,\n");
    const d = await dryRun({ home, analysis, workflowId: workflow.id, model, limit: 1, now: () => now });
    approveBatch(home, workflow.id, d.batchHash, now + 1);
    const live = await prepareLiveBatch({ home, workflowId: workflow.id, model, now: () => now + 10 });
    const masked = live.items.map((i) => ({ ...i, body: i.body.replace("Anna", "<person:1>") }));
    expect(batchHash(workflow.id, "live", masked)).not.toBe(live.hash);
    expect(approveBatch(home, workflow.id, live.hash, now + 11).batch.items[0]!.body).toContain("Hi Anna,");
  }, 120_000);

  test("REVIEW: no file the brain writes holds a placeholder map or a placeholder", async () => {
    const home = tmp("offload-s18e-files-");
    writePersona(home, generatePersona("support", { seed: 7, startDay: REPORT_START }), { encrypted: false, seed: 7 });
    const { model } = routed(home);
    const a = await analyzeHome(home, { now: reportNow, understanding: "v2" });
    const { workflow } = await draftGeneralWorkflow({ home, analysis: a, insightId: a.insights[0]!.id, model, now: () => NOW });
    await dryRun({ home, analysis: a, workflowId: workflow.id, model, limit: 5, now: () => NOW });
    for (const f of allFiles(home)) {
      const text = readFileSync(f, "utf8");
      expect({ f, placeholder: text.includes("<person:") }).toEqual({ f, placeholder: false });
    }
  }, 120_000);
});
