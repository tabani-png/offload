// DRYRUN: per-instance ours/theirs/match for every output type, values copied by code, foreign numbers flagged in
// text drafts, dry-run batches through the gate, the commit seam and sealing. TONE: the text tone source.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import { StubModel, type ModelRequest } from "../../src/models/model.ts";
import { commitToolName } from "../../src/plan/dryrun.ts";
import { actionFor, extractValues, kindForName } from "../../src/plan/outputs.ts";
import { stepPrompt } from "../../src/plan/text-step.ts";
import { buildTextTonePack, retrieveTextExamples, typedText } from "../../src/tone/text-source.ts";
import type { Span } from "../../src/types.ts";
import { dryRun, readLastDryRun } from "../../src/workflows/dryrun.ts";
import { readBatch, readWorkflow } from "../../src/workflows/store.ts";
import { draftFor, freshHome, NOW } from "./setup.ts";

describe("s14 dry run: values and outputs", () => {
  test("DRYRUN: values are found in code: ids, amounts, dates, emails, titles and the first-line name", () => {
    const v = extractValues(["Northwind Ltd\nInvoice INV-10442\nAmount due 1,240.00\nDue in 30 days\nbilling@northwind.test", "Ana Lima\nHead of Operations at Summit Legal"]);
    expect(v.id).toEqual(["INV-10442"]);
    expect(v.amount).toEqual(["1,240.00"]);
    expect(v.date).toEqual(["Due in 30 days"]);
    expect(v.email).toEqual(["billing@northwind.test"]);
    expect(v.title).toEqual(["Head of Operations"]);
    expect(v.name).toEqual(["Northwind Ltd", "Ana Lima"]);
  });

  test("DRYRUN: field names map to value kinds and outputs to plain actions", () => {
    expect(["job title", "work email", "Total", "due date", "Reference", "Supplier", "notes"].map(kindForName)).toEqual(["title", "email", "amount", "date", "id", "name", null]);
    expect(["stage change", "ticket solved", "public reply", "draft bill", "scorecard"].map(actionFor)).toEqual(["move to the next stage", "mark solved", "send the reply", "save the bill as a draft", "save the scorecard"]);
  });

  test("DRYRUN: form fields: the labels are learned from the commit screen, the values copied from the PDF, no model call", async () => {
    const { home, v2 } = await freshHome("bookkeeper");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const model = new StubModel();
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model, now: () => NOW, limit: 3 });
    expect(model.calls.filter((c) => c.role === "step")).toEqual([]);
    const i = r.general!.instances[0]!;
    expect(i.ours.fields.map((f) => f.label)).toEqual(["From", "Reference", "Total"]);
    expect(i.ours.fields[1]!.value).toMatch(/^INV-\d{5}$/);
    expect(i.ours.fields[2]!.value).toMatch(/^\d+\.\d{2}$/);
    expect(i.match).toMatchObject({ matched: 3, total: 3, value: 1, arithmetic: "3 of 3 fields match = 100%" });
    // s16: the bill in Xero's labelled form, values copied by code; what only the account knows is listed as missing.
    expect(i.commit).toMatchObject({ tool: "xero", verb: "create_bill", missing: ["tenant_id", "contact_id", "line.1.account_code"] });
    expect(i.commit!.fields).toContainEqual(["reference", i.ours.fields[1]!.value!]);
    expect(i.commit!.fields).toContainEqual(["line.1.unit_amount", i.ours.fields[2]!.value!.replace(/,/g, "")]);
    expect(i.warnings).toContain("Set up once before Xero can save this: the Xero organisation, the supplier in Xero, the expense account.");
    expect(i.theirs.excerpt).toContain("New Bill");
    expect(r.general!.tone).toBeNull();
  });

  test("DRYRUN: rows: values the screen never showed are left for the user and said so", async () => {
    const { home, v2 } = await freshHome("salesops");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 4 });
    const g = r.general!;
    expect(g.outputType).toBe("rows");
    const i = g.instances.find((x) => x.theirs.fields.length > 0)!;
    expect(i.ours.fields.find((f) => f.label === "job title")?.value).toMatch(/[A-Z]/);
    expect(i.ours.fields.find((f) => f.label === "work email")?.value).toBeNull();
    expect(i.warnings).toContain("work email: not on the screen it reads; left for you");
    expect(i.match.total).toBe(2);
    expect(i.match.matched).toBe(1);
  });

  test("DRYRUN: text outputs: the reply is drafted by the step model from masked text; actions match the notes", async () => {
    const { home, v2 } = await freshHome("support");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const model = new StubModel();
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model, now: () => NOW, limit: 3 });
    const steps = model.calls.filter((c) => c.role === "step");
    expect(steps.length).toBe(3);
    expect(steps.every((c) => c.model === "claude-sonnet-5-5")).toBe(true);
    // Masked: no digit from the screen reaches the model (ids and order numbers become <n>).
    for (const c of steps) expect(/<source untrusted="true">[\s\S]*\d[\s\S]*<\/source>/.test(c.prompt)).toBe(false);
    const i = r.general!.instances[0]!;
    expect(i.ours.text).toContain("Thanks for getting in touch");
    expect(i.ours.actions).toEqual(["send the reply", "mark solved"]);
    expect(i.theirs.actions).toEqual(["send the reply", "mark solved"]);
    // s16: a Zendesk reply carries the ticket id from the screen and the drafted body.
    expect(i.commit).toMatchObject({ tool: "zendesk", verb: "reply_ticket", missing: [] });
    expect(i.commit!.fields[0]![0]).toBe("ticket_id");
    expect(i.commit!.fields.at(-1)![0]).toBe("body");
  });

  test("DRYRUN: stage changes draft the scorecard as a note and move the stage", async () => {
    const { home, v2 } = await freshHome("recruiter");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 2 });
    const i = r.general!.instances[0]!;
    expect(i.ours.kind).toBe("stage_change");
    expect(i.ours.text).toContain("Recommendation: [missing: your decision]");
    expect(i.ours.actions).toContain("move to the next stage");
    expect(i.warnings).toContain("gap: [missing: your decision]");
  });

  test("DRYRUN: a number the step model adds that is not in the source is flagged", async () => {
    const { home, v2 } = await freshHome("support");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const model = new StubModel({ step: () => "Hi,\n\nYour refund of 99.99 is on its way.\n\nKim" });
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model, now: () => NOW, limit: 1 });
    expect(r.general!.instances[0]!.warnings).toContain("number not in the source: 99.99");
  });

  test("DRYRUN: every commit is put to the gate in dry-run mode and denied; the dry-run batch activates on approval", async () => {
    const { home, v2 } = await freshHome("bookkeeper");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 4 });
    expect(r.sideEffects).toEqual({ attempted: 4, denied: 4 });
    expect(r.gateLog.every((d) => d.decision === "deny" && d.tool === commitToolName("xero") && d.reason.startsWith("dry run"))).toBe(true);
    const b = readBatch(home, wf.id, r.batchHash, NOW)!;
    expect(b.kind).toBe("dry_run");
    expect(b.items.map((x) => x.key)).toEqual(r.general!.instances.map((x) => x.instanceId.toLowerCase()));
    expect(b.items.map((x) => x.sourceInstanceId)).toEqual(r.general!.instances.map((x) => x.instanceId));
    expect(readWorkflow(home, wf.id)!.lastDryRunHash).toBe(r.batchHash);
    const token = "d".repeat(40);
    const brain = createBrain({ home, token, now: () => NOW, analyze: { understanding: "v2" }, workflows: { model: new StubModel() } });
    const res = await brain.handle(new Request(`http://127.0.0.1/workflows/${wf.id}/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ batchHash: r.batchHash }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe("activated");
  });

  test("DRYRUN: the dry run is sealed on disk and reads back with its general section", async () => {
    const { home, v2 } = await freshHome("bookkeeper");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 2 });
    const raw = readFileSync(join(home, "workflows", wf.id, "dry-run.json.enc"), "utf8");
    expect(raw.startsWith("OBV1 ")).toBe(true);
    expect(raw).not.toContain("INV-");
    expect(existsSync(join(home, "workflows", wf.id, "dry-run.json"))).toBe(false);
    expect(readLastDryRun(home, wf.id, NOW)!.general).toEqual(r.general);
  });

  test("DRYRUN: POST /workflows/:id/dry-run returns the general section over HTTP", async () => {
    const { home, v2 } = await freshHome("salesops");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const token = "h".repeat(40);
    const brain = createBrain({ home, token, now: () => NOW, analyze: { understanding: "v2" }, workflows: { model: new StubModel() } });
    const res = await brain.handle(new Request(`http://127.0.0.1/workflows/${wf.id}/dry-run`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ limit: 2 }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { general?: { outputType: string; instances: unknown[] } };
    expect(body.general?.outputType).toBe("rows");
    expect(body.general?.instances.length).toBe(2);
  });
});

function span(ocr: string[], keys = 80): Span {
  const t = 1_000_000;
  return { id: `sp${ocr.length}${keys}${ocr[0]!.length}`, day: "2026-10-12", key: "k", app: "com.google.Chrome", appName: "Google Chrome", title: "Ticket", host: "acme.zendesk.com", url: "", start: t, end: t + 60_000, activeMs: 60_000, eventIds: ocr.map((_, i) => `e${i}`), ocr: ocr.map((text, i) => ({ eventId: `ev_${text.length}_${i}`, ts: t + i * 1000, text })), keys, clicks: 3 };
}

describe("s14 tone: text beyond Sent mail", () => {
  test("TONE: typed text = lines that appeared while typing, masked; reading-only spans give none", () => {
    const s = span(["Where is my order?\nCustomer: it has not arrived (order #4521)", "Where is my order?\nCustomer: it has not arrived (order #4521)\nHi Sam,\nSorry for the wait, it ships today.\nKim"]);
    expect(typedText(s)?.text).toBe("Hi Sam,\nSorry for the wait, it ships today.\nKim");
    expect(typedText(span(["a", "a\nb that is long enough to count"], 0))).toBeNull();
    expect(typedText(span(["only one snapshot of the screen"]))).toBeNull();
    expect(typedText(span(["x", "x\nCall me on 0207 946 0123 about it please"]))?.text).toBe("Call me on <n> <n> <n> about it please");
  });

  test("TONE: the measured card has the usual greeting, sign-off and length from N of the user's texts", () => {
    const texts = ["Hi Sam,\nSorry for the wait, it ships today.\nKim", "Hi Ana,\nThe refund is on its way to your card.\nKim", "Hello Bo,\nI changed the address on your order for you.\nKim"];
    const pack = buildTextTonePack("ticket_reply", texts.map((t, i) => span([`q${i}`, `q${i}\n${t}`])));
    expect(pack.measured).toMatchObject({ examples: 3, greeting: "Hi,", signOff: "Kim" });
    expect(pack.card).toContain('- greeting: "Hi,"');
    expect(pack.card).toContain('- sign-off: "Kim"');
    expect(pack.card).toContain("from 3 of your own texts");
  });

  test("TONE: retrieval returns 3-5 of the user's texts, closest first by BM25", () => {
    const texts = ["Hi,\nYour refund is on its way to the card.\nKim", "Hi,\nThe parcel ships today from the warehouse.\nKim", "Hi,\nWe changed the delivery address for you.\nKim", "Hi,\nYour discount code works again now.\nKim"];
    const pack = buildTextTonePack("ticket_reply", texts.map((t, i) => span([`q${i}`, `q${i}\n${t}`])));
    const got = retrieveTextExamples(pack, "refund card");
    expect(got.length).toBe(4);
    expect(got[0]!.text).toContain("refund");
  });

  test("TONE: the step prompt carries the card and examples as untrusted blocks; no card means a plain fallback", () => {
    const pack = buildTextTonePack("ticket_reply", [span(["q", "q\nHi,\nThe parcel ships today from the warehouse.\nKim"])]);
    const p = stepPrompt({ what: "reply", source: "Where is my order? order #4521", pack, user: { role: "Support agent" } });
    expect(p).toContain('<style_card untrusted="true">');
    expect(p).toContain("--- example 1");
    expect(p).toContain("order #<n>");
    expect(p).toContain("role: Support agent");
    expect(stepPrompt({ what: "reply", source: "x", pack: null })).toContain("no examples of their own texts yet");
  });

  test("TONE: only text steps get a tone pack: form entry has none, ticket replies say where their examples came from", async () => {
    const b = await freshHome("bookkeeper");
    const r1 = await dryRun({ home: b.home, analysis: b.v2, workflowId: (await draftFor(b.home, b.v2, b.v2.insights[0]!)).id, model: new StubModel(), now: () => NOW, limit: 1 });
    expect(r1.general!.tone).toBeNull();
    const s = await freshHome("support");
    const seen: ModelRequest[] = [];
    const r2 = await dryRun({ home: s.home, analysis: s.v2, workflowId: (await draftFor(s.home, s.v2, s.v2.insights[0]!)).id, model: new StubModel({ step: (r) => (seen.push(r), "Hi,\n\nOn it.\n\nKim") }), now: () => NOW, limit: 1 });
    expect(r2.general!.tone).toEqual({ source: "none", examples: 0 });
    expect(r2.warnings.some((w) => w.startsWith("no examples of your own texts yet"))).toBe(true);
    expect(seen[0]!.prompt).toContain("no examples of their own texts yet");
  });
});
