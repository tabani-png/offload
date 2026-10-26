// s27: the s26 metrics task, extended: the recordings show the person reading the numbers on a PostHog dashboard and
// then typing them into the sheet. Offload finds the dashboard as the read step, reads the values itself through the
// connector chain (a fake MCP connector here), shows them in the dry run, builds the live batch from them, commits
// them through computer use after approval, and never repeats a done row. The steps share one world and run in order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { batchHash } from "../../src/workflows/batch.ts";
import { readBatch, readWorkflow } from "../../src/workflows/store.ts";
import { FRI_EVENING, MCP_READ_TOOL, metricsInsight, READ_SECONDS, SHEET_COLUMNS, SOURCE_TARGET, world, writeAfterDays, writeFirstDays, type World } from "./setup.ts";

let w: World;
let insight: any;
let workflowId = "";
let live: any;

const VALUES = ["43", "352", "2410", "3"];
const FIELDS = SHEET_COLUMNS.map((c, k) => [c, VALUES[k]!] as [string, string]);

beforeAll(() => {
  w = world();
});
afterAll(() => w.cleanup());

const wfDir = () => join(w.home, "workflows", workflowId);
const gateLog = () => readFileSync(join(wfDir(), "gate-log.jsonl"), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

describe("s27 path: the metrics task reads its own numbers", () => {
  test("SOURCE: from the recordings (dashboard, then sheet) the read source is found and stored on the workflow, with its fields and reading time", async () => {
    writeFirstDays(w.home);
    insight = await metricsInsight(w);
    expect(insight).toBeDefined();
    const r = await w.call(`/insights/${insight.id}/solutions/choose`, "POST", { kind: "workflow" });
    expect(r.status).toBe(201);
    workflowId = r.body.workflow.id;
    const read = r.body.workflow.read;
    expect(read).toBeDefined();
    expect(read.target).toBe(SOURCE_TARGET);
    expect(read.targetName).toBe("PostHog");
    expect(read.host).toBe("us.posthog.com");
    expect(read.fields.map((f: any) => f.label)).toEqual([...SHEET_COLUMNS]);
    expect(read.fields.map((f: any) => f.sourceLabel)).toEqual(["Week", "Signups", "Active users", "Churn"]);
    expect(read.instances).toBeGreaterThanOrEqual(9);
    expect(read.seenBefore).toBe(read.instances);
    expect(read.withValues).toBe(read.instances);
    expect(read.readSecondsPerInstance).toBeGreaterThan(READ_SECONDS - 15);
    expect(read.readSecondsPerInstance).toBeLessThan(READ_SECONDS + 15);
    expect(read.readHoursPerWeek).toBeGreaterThan(0);
    expect(read.arithmetic).toMatch(/h\/wk/);
    expect(read.evidence.spanIds.length).toBe(read.seenBefore);
    // Evidence resolves to real stored events.
    const day = readFileSync(join(w.home, "days", "2026-10-12.jsonl"), "utf8");
    for (const id of read.evidence.eventIds.slice(0, 3)) expect(day.includes(id) || readFileSync(join(w.home, "days", "2026-10-13.jsonl"), "utf8").includes(id) || readFileSync(join(w.home, "days", "2026-10-14.jsonl"), "utf8").includes(id)).toBe(true);
    // Only labels are kept: no value the person typed is stored with the workflow.
    const stored = readFileSync(join(wfDir(), "workflow.json"), "utf8");
    expect(read.fields.map((f: any) => f.label + f.sourceLabel).join(" ")).not.toMatch(/\d/);
    expect(stored).not.toMatch(/Signups \d/);
    // The detail route carries it too.
    expect((await w.call(`/workflows/${workflowId}`)).body.read.target).toBe(SOURCE_TARGET);
  });

  test("STEP: both plan variants start with a read step (role read, never gated) before the commit; the legacy steps and SKILL.md show it", async () => {
    const wf = readWorkflow(w.home, workflowId)!;
    for (const v of wf.plan!.variants) {
      const i = v.steps.findIndex((s) => s.id === "read_source");
      const c = v.steps.findIndex((s) => s.type === "commit");
      expect(i).toBe(0);
      expect(c).toBeGreaterThan(i);
      const s = v.steps[i]!;
      expect(s.type).toBe("read");
      expect(s.gated).toBe(false);
      expect(s.capability!.role).toBe("read");
      expect(s.capability!.target).toBe(SOURCE_TARGET);
      expect(s.title).toContain("PostHog");
    }
    const legacy = wf.steps.findIndex((s) => s.id === "read_source");
    expect(legacy).toBeGreaterThanOrEqual(0);
    expect(wf.steps[legacy]!.sideEffect).toBe(false);
    expect(legacy).toBeLessThan(wf.steps.findIndex((s) => s.type === "approval_gate"));
    expect(readFileSync(join(wfDir(), "SKILL.md"), "utf8")).toContain("PostHog");
  });

  test("DRYRUN: the dry run fetches the values read-only and shows them; past instances are filled from the dashboard; reading time is saved", async () => {
    const r = await w.call(`/workflows/${workflowId}/dry-run`, "POST", { limit: 3 });
    expect(r.status).toBe(200);
    expect(r.body.read.status).toBe("fetched");
    expect(r.body.read.via).toBe("mcp");
    expect(r.body.read.name).toBe("PostHog");
    expect(r.body.read.rows).toEqual([FIELDS]);
    expect(w.mcpReader.ran).toBe(1);
    expect(w.composioReader.calls).toBe(0);
    // Read through the read-only gate: allowed, logged, mode read.
    const reads = gateLog().filter((l) => l.mode === "read");
    expect(reads.map((l) => [l.tool, l.decision])).toEqual([[MCP_READ_TOOL, "allow"]]);
    for (const i of r.body.general.instances) {
      expect(i.ours.fields.length).toBe(4);
      expect(i.ours.fields.every((f: any) => f.value !== null)).toBe(true);
      expect(i.match.value).toBe(1);
      expect(i.estimate.readCounted).toBe(true);
      expect(i.estimate.readMinutes).toBeGreaterThan(0);
      expect(i.estimate.savedMinutes).toBeCloseTo(i.estimate.observedMinutes + i.estimate.readMinutes - i.estimate.reviewSeconds / 60, 0);
    }
    expect(r.body.totals.savedMinutes).toBeGreaterThan(0);
    expect(r.body.totals.arithmetic).toMatch(/reading PostHog/);
    // Nothing on screen was touched by the dry run.
    expect(w.driver.touches()).toBe(0);
    const a = await w.call(`/workflows/${workflowId}/approve`, "POST", { batchHash: r.body.batchHash });
    expect(a.status).toBe(200);
    expect(a.body.result).toBe("activated");
  });

  test("LIVE: the run reads the dashboard and the fetched values become the item, exact commit included; no items.csv is needed and the response names the source", async () => {
    const r = await w.call(`/workflows/${workflowId}/run`, "POST", {});
    expect(r.status).toBe(201);
    live = r.body;
    expect(live.source).toMatchObject({ kind: "read", name: "PostHog", via: "mcp" });
    expect(live.source.message).toMatch(/PostHog/);
    expect(live.items).toHaveLength(1);
    expect(live.items[0].body).toContain("Signups: 352");
    expect(live.items[0].body).toContain("PostHog");
    const batch = readBatch(w.home, workflowId, live.batch.hash, w.clock.now)!;
    expect(batch.items.map((i) => i.commit)).toEqual([{ verb: "save", fields: FIELDS }]);
    // The approval hash covers the exact fetched values: one changed value is another batch.
    const changed = batch.items.map((i) => ({ ...i, commit: { verb: "save", fields: FIELDS.map(([l, v]) => [l, l === "Signups" ? "353" : v] as [string, string]) } }));
    expect(batchHash(workflowId, "live", changed)).not.toBe(batch.hash);
    expect(batchHash(workflowId, "live", batch.items)).toBe(batch.hash);
    expect(existsSync(join(wfDir(), "items.csv"))).toBe(false);
    // Asking again returns the same pending batch (no second read).
    expect((await w.call(`/workflows/${workflowId}/run`, "POST", {})).body.batch.hash).toBe(live.batch.hash);
    expect(w.mcpReader.ran).toBe(2);
    expect(w.driver.pressed).toHaveLength(0);
  });

  test("EXECUTE: approving the live hash commits exactly the fetched values once; recorded; the next run does not repeat it, new numbers make a new row", async () => {
    const r = await w.call(`/workflows/${workflowId}/approve`, "POST", { batchHash: live.batch.hash });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "live", result: "sending" });
    await w.brain.idle();
    expect(w.driver.pressed.map((p) => p.title)).toEqual(["Save"]);
    expect(w.driver.pressed[0]!.form.map((f) => [f.label, f.value])).toEqual(FIELDS);
    const batch = readBatch(w.home, workflowId, live.batch.hash, w.clock.now)!;
    expect(batch.state).toBe("sent");
    const done = readFileSync(join(wfDir(), "done-log.csv"), "utf8").trim().split("\n");
    expect(done.slice(1).map((l) => l.split(",").pop())).toEqual(["sent"]);
    // Same numbers on the dashboard: nothing new, nothing entered twice.
    const again = await w.call(`/workflows/${workflowId}/run`, "POST", {});
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/nothing new at PostHog/);
    // The dashboard moves on: only the new row is offered.
    w.driver.dash = { week: "44", signups: "361", active: "2455", churn: "2" };
    const next = await w.call(`/workflows/${workflowId}/run`, "POST", {});
    expect(next.status).toBe(201);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].body).toContain("Week: 44");
    // Every read went through the read gate; none was ever anything but a read.
    const reads = gateLog().filter((l) => l.mode === "read");
    expect(reads.length).toBe(4);
    expect(reads.every((l) => l.decision === "allow" && l.tool === MCP_READ_TOOL)).toBe(true);
  });

  test("METRIC: with the read automated, the estimate adds the reading time (with its arithmetic) and the measured saving counts it", async () => {
    const wf = readWorkflow(w.home, workflowId)!;
    const before = (await w.call("/dashboard")).body.automations.find((a: any) => a.workflowId === workflowId);
    expect(before.estimatedHoursSavedPerWeek).toBeCloseTo(wf.estimate.weeklyHoursSaved + wf.read!.readHoursPerWeek, 1);
    expect(before.estimatedHoursSavedPerWeek).toBeGreaterThan(wf.estimate.weeklyHoursSaved);
    expect(before.arithmetic).toMatch(/reading PostHog/);
    writeAfterDays(w.home);
    w.clock.now = FRI_EVENING;
    const a = (await w.call("/dashboard")).body.automations.find((x: any) => x.workflowId === workflowId);
    expect(a.measured).not.toBeNull();
    expect(a.measured.readingHoursPerWeekBefore).toBeGreaterThan(0);
    expect(a.measured.readingHoursPerWeekAfter).toBe(0);
    expect(a.measured.hoursPerWeekAfter).toBe(0);
    expect(a.measured.hoursSavedPerWeek).toBeCloseTo(a.measured.hoursPerWeekBefore - a.measured.hoursPerWeekAfter, 6);
    expect(a.measured.arithmetic).toMatch(/reading PostHog/);
  });
});
