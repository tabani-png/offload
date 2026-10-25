// TOOLS: the best tool per capability (an outreach platform for 100 a day, not just the app the user used), connected
// first when good enough, the model can only reorder and reword, the user's pick, and the dry run says which tool.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { createBrain } from "../../src/api/server.ts";
import { StubModel } from "../../src/models/model.ts";
import { capabilityFamily, chainReadsOnly, chooseTool, optionsFor, READS_ONLY_WORDS, recommendTools, refineTools, type StepToolsDTO } from "../../src/plan/tools.ts";
import { writeFileSync } from "node:fs";
import { tmp } from "./setup.ts";
import { draftWorkflow } from "../../src/workflows/drafter.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { readWorkflow } from "../../src/workflows/store.ts";
import { draftFor, freshHome, NOW } from "./setup.ts";

const commit = (target: string, role = "send") => ({ type: "commit", capability: { target, capability: "ui.commit", via: "computer_use", role } });

describe("s14 tools: the best tool for each capability", () => {
  test("TOOLS: capability families come from the step, the output type and the volume", () => {
    expect(capabilityFamily(commit("gmail"), "email", 100)).toBe("email.send_bulk");
    expect(capabilityFamily(commit("gmail"), "email", 8)).toBe("email.send");
    expect(capabilityFamily(commit("web-acme-zendesk-com"), "ticket_reply", 50)).toBe("ticket.reply");
    expect(capabilityFamily(commit("google-sheets"), "rows", 50)).toBe("sheet.update");
    expect(capabilityFamily(commit("web-go-xero-com"), "form_fields", 30)).toBe("accounting.bill");
    expect(capabilityFamily(commit("web-app-greenhouse-io"), "stage_change", 40)).toBe("ats.stage");
    expect(capabilityFamily({ type: "read", capability: { target: "linkedin", capability: "screen.read", via: "catalog", role: "read" } }, "rows", 50)).toBe("enrich.person");
    expect(capabilityFamily({ type: "read", capability: { target: "app-preview", capability: "file.read", via: "local_file", role: "read" } }, "form_fields", 30)).toBe("doc.read");
    expect(capabilityFamily({ type: "transform", capability: null }, "rows", 50)).toBeNull();
  });

  test("TOOLS: 100 sends a day: an outreach platform first; Gmail is offered but not the default even when connected", () => {
    // From the s13 capability catalog (send-outreach-sequence), the tool used today kept in.
    const { options, chosen } = optionsFor("email.send_bulk", "Gmail", new Set(["gmail"]), 100, { current: "gmail" });
    expect(options.map((o) => o.id)).toEqual(["instantly", "smartlead", "gmail"]);
    expect(options.find((o) => o.id === "gmail")!.connected).toBe(true);
    expect(chosen).toBe("instantly");
    // s16: adding an approved lead is allowed; starting the campaign stays the person's (said in the suggestion).
    expect(options[0]!.commitsAllowed).toBe(true);
    expect(options[0]!.needsYou).toBeNull();
    // A few a day: the connected Gmail is good enough and is the default.
    expect(optionsFor("email.send", "Gmail", new Set(["gmail"]), 8, { current: "gmail" }).chosen).toBe("gmail");
  });

  test("TOOLS: a connected tool that is good enough is the default; the on-screen app is always the last option", () => {
    const crm = optionsFor("crm.log", "Sheets", new Set(["google-sheets"]), 100);
    expect(crm.options.map((o) => o.id)).toEqual(["hubspot", "attio", "googlesheets"]);
    expect(crm.chosen).toBe("googlesheets");
    const t = optionsFor("ticket.reply", "Zendesk", new Set(), 50);
    expect(t.options.map((o) => o.id)).toEqual(["zendesk", "intercom", "screen:zendesk"]);
    expect(t.options.at(-1)!.name).toBe("Zendesk on screen");
  });

  test("TOOLS: the founder's outreach template suggests an outreach platform for sending and keeps sending through Gmail today", async () => {
    const home = mkdtempSync(join(tmpdir(), "offload-s14-tools-"));
    try {
      writeFixture(home, generateFixture({ seed: 42, startDay: "2026-10-12" }), { encrypted: false, seed: 42 });
      const a = await analyzeHome(home, { now: () => NOW });
      const { workflow } = draftWorkflow({ home, analysis: a, insightId: a.insights[0]!.id, now: () => NOW });
      const send = workflow.tools!.find((t) => t.stepId === "send")!;
      expect(send.capability).toBe("email.send_bulk");
      expect(send.chosen).toBe("instantly");
      expect(send.runsWith).toBe("gmail");
      expect(send.catalogCapability).toBe("send-outreach-sequence");
      expect(send.suggestion).toBe("Use Instantly for sending: Made for bulk cold email: sending accounts, warm-up, follow-ups and reply detection. Offload adds each approved lead; you start the campaign in Instantly. Connect its MCP server.");
      expect(workflow.tools!.find((t) => t.stepId === "log")!.capability).toBe("crm.log");
      // The template's send step itself is unchanged (the email demo).
      expect(workflow.steps.find((s) => s.id === "send")!.tool).toBe("mcp__gmail__send_email");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("TOOLS: general plans get options for their tool steps; the stub design model keeps the rules order", async () => {
    const { home, v2 } = await freshHome("salesops");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const fams = wf.tools!.map((t) => t.capability).sort();
    expect(fams).toEqual(["enrich.person", "sheet.update"]);
    const enrich = wf.tools!.find((t) => t.capability === "enrich.person")!;
    expect(enrich.options.map((o) => o.id)).toEqual(["apollo", "hubspot", "screen:linkedin"]);
  });

  test("TOOLS: the model may reorder and reword with ids it was given; a new id or a digit is ignored", async () => {
    const base = recommendTools({ plan: { outputType: "rows", variant: { id: "a", label: "", summary: "", steps: [{ id: "read_2", type: "read", title: "", detail: "", capability: { need: "read lead profile from LinkedIn", target: "linkedin", targetName: "LinkedIn", capability: "screen.read", role: "read", via: "catalog" }, gated: false, when: null, writesText: false, sourceSteps: [] }] } }, perDay: 50, connected: new Set() });
    const reorder = { steps: [{ stepId: "read_2", options: [{ id: "hubspot", why: "Uses what the CRM already has." }, { id: "apollo" }] }] };
    const r1 = await refineTools(base, { model: new StubModel({ workflow_design: () => JSON.stringify(reorder) }), models: { draft: "claude-opus-5-5", cheap: "claude-sonnet-5-5" }, context: "" });
    expect(r1[0]!.options.map((o) => [o.id, o.why])).toEqual([["hubspot", "Uses what the CRM already has."], ["apollo", base[0]!.options[0]!.why]]);
    expect(r1[0]!.chosen).toBe("apollo");
    for (const bad of [{ steps: [{ stepId: "read_2", options: [{ id: "zoominfo" }] }] }, { steps: [{ stepId: "read_2", options: [{ id: "hubspot", why: "Has 3 sources" }] }] }]) {
      const r = await refineTools(base, { model: new StubModel({ workflow_design: () => JSON.stringify(bad) }), models: { draft: "claude-opus-5-5", cheap: "claude-sonnet-5-5" }, context: "" });
      expect(r).toEqual(base);
    }
  });

  test("TOOLS: POST /workflows/:id/tools records the pick, resets the dry run, and the dry run names the tool", async () => {
    const { home, v2 } = await freshHome("support");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const reply = wf.tools!.find((t) => t.capability === "ticket.reply")!;
    const token = "x".repeat(40);
    const brain = createBrain({ home, token, now: () => NOW, analyze: { understanding: "v2" }, workflows: { model: new StubModel() } });
    const post = (body: unknown) => brain.handle(new Request(`http://127.0.0.1/workflows/${wf.id}/tools`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify(body) }));
    expect((await post({ stepId: reply.stepId, toolId: "nope" })).status).toBe(400);
    expect((await post({ stepId: reply.stepId })).status).toBe(400);
    const screen = reply.options.find((o) => o.via === "computer")!;
    const res = await post({ stepId: reply.stepId, toolId: screen.id });
    expect(res.status).toBe(200);
    const stored = readWorkflow(home, wf.id)!.tools!.find((t) => t.stepId === reply.stepId)!;
    expect(stored).toMatchObject({ chosen: screen.id, chosenBy: "user", runsWith: screen.id });
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 1 });
    expect(r.general!.instances[0]!.ours.summary.endsWith("(with Zendesk on screen)")).toBe(true);
    expect(r.tools!.find((t) => t.stepId === reply.stepId)).toMatchObject({ tool: screen.id, name: "Zendesk on screen" });
  });

  test("TOOLS: picks for template steps keep runsWith (the runner still sends through Gmail)", () => {
    const tools: StepToolsDTO[] = recommendTools({ legacy: { kind: "email.outreach", steps: [{ id: "send", type: "send", title: "Send from Gmail", connector: "gmail" }] }, perDay: 100, connected: new Set(["gmail"]) });
    const next = chooseTool(tools, "send", "smartlead", true)!;
    expect(next[0]).toMatchObject({ chosen: "smartlead", chosenBy: "user", runsWith: "gmail" });
    expect(chooseTool(tools, "missing", "gmail", true)).toBeNull();
  });

  test("TOOLS: a Composio account that asks on every call shows as reads only with a plain needs-you line", () => {
    const home = tmp();
    writeFileSync(join(home, "connector-chain.json"), JSON.stringify({ version: 1, targets: {}, decisions: { gmail: { targetId: "gmail", decidedAt: 0, expiresAt: 0, methods: [{ method: "composio", health: "ok", code: "reads_only", reason: "x", reads: [], writes: [], tools: {}, latencyMs: 0, checkedAt: 0, lastError: null, failedAt: null }] } } }));
    const ro = chainReadsOnly(home);
    expect(ro.get("gmail")).toBe(READS_ONLY_WORDS);
    const r = optionsFor("email.send", "Gmail", new Set(["gmail"]), 5, { current: "gmail", readsOnly: ro });
    expect(r.options[0]!.needsYou).toBe(READS_ONLY_WORDS);
    // No other connected option can send either: Gmail stays the pick and the review shows why it cannot send yet.
    expect(r.chosen).toBe("gmail");
    expect(chainReadsOnly(tmp()).size).toBe(0);
  });
});
