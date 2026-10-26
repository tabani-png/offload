// s26: ONE realistic non-email repeated task through the whole individual path, on the real brain routes:
// captures -> insight -> time breakdown -> solution designer -> workflow -> dry run -> approval -> live batch ->
// execute through the connector chain (computer use on an in-memory sheet) -> result recorded -> measured saving.
// The steps share one world and run in order; each test is one step of slices/s26-automation-e2e/SPEC.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerContacted } from "../../src/workflows/runner.ts";
import { readBatch } from "../../src/workflows/store.ts";
import { itemsCsv, METRICS_TITLE, OUTREACH_WORDS, SHEET_COLUMNS, world, writeAfterDays, writeFirstDays, FRI_EVENING, type World } from "./setup.ts";

let w: World;
let insight: any;
let workflowId = "";
let dryHash = "";
let live: any;

const ROWS = [
  ["43", "352", "2410", "3"],
  ["44", "361", "2455", "2"],
  ["45", "377", "2502", "2"],
] as const;

beforeAll(() => {
  w = world();
});
afterAll(() => w.cleanup());

const wfDir = () => join(w.home, "workflows", workflowId);
const gateLog = () => readFileSync(join(wfDir(), "gate-log.jsonl"), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

describe("s26 path: spreadsheet updates (Team metrics), end to end", () => {
  test("CAPTURE: three days of observer events (focus, masked OCR, input counts) are stored, the metrics sheet visited each weekday", () => {
    const days = writeFirstDays(w.home);
    expect(days.map((d) => d.day)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    for (const d of days) {
      const visits = d.events.filter((e) => e.kind === "focus" && e.title === METRICS_TITLE).length;
      expect(visits).toBe(3);
      expect(d.events.some((e) => e.kind === "ocr")).toBe(true);
      expect(d.events.some((e) => e.kind === "input" && typeof e.keys === "number")).toBe(true);
    }
  });

  test("INSIGHT: the metrics task is an insight, with code arithmetic and evidence ids, and it is not email", async () => {
    const r = await w.call("/insights");
    expect(r.status).toBe(200);
    expect(r.body.insights.length).toBeGreaterThanOrEqual(2);
    insight = r.body.insights.find((i: any) => /Team metrics/.test(i.name));
    expect(insight).toBeDefined();
    expect(insight.kind).toBe("sheet.updates");
    expect(insight.category).toBe("sheet");
    expect(insight.saving.arithmetic).toMatch(/h\/wk/);
    expect(insight.figures.instances.value).toBeGreaterThanOrEqual(9);
    expect(insight.figures.instances.eventCount).toBeGreaterThan(10);
    const ev = await w.call(`/insights/${insight.id}/evidence`);
    expect(ev.status).toBe(200);
    expect(JSON.stringify(ev.body)).toMatch(/[0-9A-Z]{26}/);
    expect(JSON.stringify(insight)).not.toMatch(OUTREACH_WORDS);
  });

  test("TIME: the time screen has a finding for it: fix kind workflow, hours freed above zero and below the task's own time", async () => {
    const r = await w.call("/time");
    expect(r.status).toBe(200);
    const f = r.body.findings.find((x: any) => x.insightId === insight.id);
    expect(f).toBeDefined();
    expect(f.fixKind).toBe("workflow");
    expect(f.workflowInsightId).toBe(insight.id);
    expect(f.hoursFreed.value).toBeGreaterThan(0);
    expect(f.hoursFreed.value).toBeLessThan(f.observedHoursPerWeek.value);
    expect(f.arithmetic.endsWith(f.hoursFreed.display)).toBe(true);
    expect(r.body.byKind.find((k: any) => k.id === "sheet").minutes.value).toBeGreaterThan(0);
  });

  test("DESIGN: the solution designer ranks a workflow first; no option claims more than the observed time", async () => {
    const r = await w.call(`/insights/${insight.id}/solutions`);
    expect(r.status).toBe(200);
    expect(r.body.top).toBe("workflow");
    expect(r.body.options.map((o: any) => o.kind).sort()).toEqual(["leave_alone", "remove_step", "setup", "tool", "workflow"]);
    for (const o of r.body.options) expect(o.weeklyHoursSaved).toBeLessThanOrEqual(r.body.observedWeeklyHours + 1e-9);
    expect(r.body.options[0].handoff).toEqual({ to: "workflow_drafter", insightId: insight.id });
  });

  test("BUILD: choosing the workflow builds a general plan (rows), every commit gated behind an approval step, auto-run off", async () => {
    const r = await w.call(`/insights/${insight.id}/solutions/choose`, "POST", { kind: "workflow" });
    expect(r.status).toBe(201);
    const wf = r.body.workflow;
    workflowId = wf.id;
    expect(wf.kind).toBe("sheet.updates");
    expect(wf.plan.outputType).toBe("rows");
    expect(wf.autoRun).toBe(false);
    const steps = wf.steps as Array<{ id: string; type: string; sideEffect: boolean; connector: string | null }>;
    const gateAt = steps.findIndex((s) => s.type === "approval_gate");
    const commits = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.sideEffect);
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(commits.length).toBeGreaterThan(0);
    for (const { s, i } of commits) {
      expect(i).toBeGreaterThan(gateAt);
      expect(s.connector).toBe("google-sheets");
    }
    expect(existsSync(join(wfDir(), "SKILL.md"))).toBe(true);
    // Choosing again is the same workflow, not a second one.
    expect((await w.call(`/insights/${insight.id}/solutions/choose`, "POST", { kind: "workflow" })).body.workflow.id).toBe(workflowId);
  });

  test("DRYRUN: the dry run runs on last week's instances; every commit is put to the gate and denied; the app is never touched", async () => {
    const r = await w.call(`/workflows/${workflowId}/dry-run`, "POST", { limit: 3 });
    expect(r.status).toBe(200);
    dryHash = r.body.batchHash;
    expect(r.body.general.instances.length).toBe(3);
    expect(r.body.sideEffects.attempted).toBeGreaterThanOrEqual(3);
    expect(r.body.sideEffects.denied).toBe(r.body.sideEffects.attempted);
    for (const g of r.body.gateLog) expect(g.decision).toBe("deny");
    // Honest: the sheet's numbers come from somewhere Offload did not see, so nothing is filled and nothing is saved.
    for (const i of r.body.general.instances) {
      expect(i.ours.fields.every((f: any) => f.value === null)).toBe(true);
      expect(i.estimate.savedMinutes).toBe(0);
    }
    expect(r.body.totals.savedMinutes).toBe(0);
    expect(w.driver.pressed).toHaveLength(0);
    expect(w.driver.events).toHaveLength(0);
  });

  test("APPROVE: a wrong hash is refused; the exact dry-run hash activates the workflow (no token: a dry run is never sendable)", async () => {
    const bad = await w.call(`/workflows/${workflowId}/approve`, "POST", { batchHash: "0".repeat(64) });
    expect(bad.status).toBe(404);
    const r = await w.call(`/workflows/${workflowId}/approve`, "POST", { batchHash: dryHash });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("dry_run");
    expect(r.body.result).toBe("activated");
    expect(r.body.workflow.state === "active" || r.body.workflow.state === "needs_you").toBe(true);
  });

  test("LIVE: with no rows to enter the run says so plainly; with the person's items.csv the next rows become one live batch, each item carrying its exact commit", async () => {
    const empty = await w.call(`/workflows/${workflowId}/run`, "POST", {});
    expect(empty.status).toBe(409);
    expect(empty.body.message).toMatch(/items\.csv/);
    writeFileSync(join(wfDir(), "items.csv"), itemsCsv(ROWS.slice(0, 2)));
    const r = await w.call(`/workflows/${workflowId}/run`, "POST", {});
    expect(r.status).toBe(201);
    live = r.body;
    expect(live.items).toHaveLength(2);
    expect(live.batch.kind).toBe("live");
    expect(live.batch.state).toBe("pending");
    const batch = readBatch(w.home, workflowId, live.batch.hash, w.clock.now)!;
    expect(batch.items.map((i) => i.commit)).toEqual(
      ROWS.slice(0, 2).map((row) => ({ verb: "save", fields: SHEET_COLUMNS.map((c, k) => [c, row[k]!]) })),
    );
    // The review text names every value; numbers are copied by code from the person's own list.
    expect(live.items[0].body).toContain("Signups: 352");
    // Asking again returns the same pending batch, nothing new.
    expect((await w.call(`/workflows/${workflowId}/run`, "POST", {})).body.batch.hash).toBe(live.batch.hash);
    expect(w.driver.pressed).toHaveLength(0);
  });

  test("EXECUTE: approving the exact live hash runs the chain (computer use): each approved row is typed and saved once, exactly as approved", async () => {
    const r = await w.call(`/workflows/${workflowId}/approve`, "POST", { batchHash: live.batch.hash });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "live", result: "sending" });
    await w.brain.idle();
    expect(w.driver.pressed.map((p) => p.title)).toEqual(["Save", "Save"]);
    for (const [k, p] of w.driver.pressed.entries()) {
      expect(p.form.map((f) => [f.label, f.value])).toEqual(SHEET_COLUMNS.map((c, j) => [c, ROWS[k]![j]!]));
    }
    const log = gateLog().filter((l) => l.mode !== "dry_run" && /computer_/.test(l.tool));
    const commits = log.filter((l) => /__commit$/.test(l.tool));
    expect(commits.map((l) => l.decision)).toEqual(["allow", "allow"]);
    expect(log.filter((l) => /__input$/.test(l.tool)).every((l) => l.decision === "allow")).toBe(true);
  });

  test("RECORD: the batch is sent, every item recorded, the done log and the contacted ledger written; the next run skips done rows", async () => {
    const batch = readBatch(w.home, workflowId, live.batch.hash, w.clock.now)!;
    expect(batch.state).toBe("sent");
    expect(Object.values(batch.itemStates!).map((s) => s.state)).toEqual(["sent", "sent"]);
    expect(batch.results.filter((x) => x.ok).length).toBe(2);
    const done = readFileSync(join(wfDir(), "done-log.csv"), "utf8").trim().split("\n");
    expect(done[0]).toBe("date,email,subject,batch,status");
    expect(done.slice(1).map((l) => l.split(",").pop())).toEqual(["sent", "sent"]);
    expect(ledgerContacted(w.home, workflowId).size).toBe(2);
    const d = (await w.call("/dashboard")).body.automations.find((a: any) => a.workflowId === workflowId);
    expect(d.lastRunAt).not.toBeNull();
    // A third row added later: only it is offered next; the two done rows are never entered again.
    writeFileSync(join(wfDir(), "items.csv"), itemsCsv(ROWS));
    const next = await w.call(`/workflows/${workflowId}/run`, "POST", {});
    expect(next.status).toBe(201);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].body).toContain("Week: 45");
  });

  test("METRIC: the measured saving is null until a full day after activation, then the code arithmetic of hours before vs after", async () => {
    const before = (await w.call("/dashboard")).body.automations.find((a: any) => a.workflowId === workflowId);
    expect(before.estimatedHoursSavedPerWeek).toBeGreaterThan(0);
    expect(before.measured).toBeNull();
    expect(before.measuredHoursSavedPerWeek).toBeNull();
    writeAfterDays(w.home);
    w.clock.now = FRI_EVENING;
    const after = (await w.call("/dashboard")).body;
    const a = after.automations.find((x: any) => x.workflowId === workflowId);
    expect(a.measured).not.toBeNull();
    expect(a.measured.daysBefore).toBe(2);
    expect(a.measured.daysAfter).toBe(2);
    expect(a.measured.hoursPerWeekAfter).toBe(0);
    expect(a.measured.hoursPerWeekBefore).toBeGreaterThan(0);
    expect(a.measuredHoursSavedPerWeek).toBe(a.measured.hoursSavedPerWeek);
    expect(a.measured.hoursSavedPerWeek).toBeCloseTo(a.measured.hoursPerWeekBefore - a.measured.hoursPerWeekAfter, 6);
    expect(a.measured.arithmetic).toContain(`saves ${a.measured.hoursSavedPerWeek.toFixed(1)} h/wk`);
    expect(after.totals.measuredHoursSavedPerWeek).toBe(a.measuredHoursSavedPerWeek);
  });
});
