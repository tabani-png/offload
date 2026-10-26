// s26: every other kind of fix the designer can return ends in a sensible, honest state on the real routes.
//   setup       (held-back coding-agent watching, neutral week)  -> brief, exact approval, one hand-off, build refused
//   remove_step (s22 LinkedIn image fixture: the neutral week has none) -> the same brief path
//   tool        (the metrics task's tool option)                  -> the same brief path
//   leave_alone (inbox triage, neutral week)                      -> nothing built; the choice is remembered
// The builder (s24) is OFF by default (it cannot stop builder code reading other same-user processes' argv/env):
// a build is refused with that reason, the approval is kept, and no workspace is created.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFixture } from "../../fixtures/gen.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { rulesSolutions } from "../../src/solutions/rules.ts";
import { chooseSolution } from "../../src/solutions/service.ts";
import { buildFixture, LINKEDIN_IMAGE } from "../s22-solution-designer/fixtures.ts";
import { neutralDays, SEED, world, type World } from "./setup.ts";

const SUNDAY_NIGHT = new Date(2026, 9, 18, 22, 0, 0).getTime();
let w: World;
let insights: any;
let savedFlag: string | undefined;

beforeAll(async () => {
  savedFlag = process.env.OFFLOAD_BUILDER_ENABLED;
  delete process.env.OFFLOAD_BUILDER_ENABLED;
  w = world({ now: SUNDAY_NIGHT });
  writeFixture(w.home, neutralDays(), { encrypted: false, seed: SEED });
  insights = (await w.call("/insights")).body;
});
afterAll(() => {
  w.cleanup();
  if (savedFlag !== undefined) process.env.OFFLOAD_BUILDER_ENABLED = savedFlag;
});

/** brief -> approve exact hash -> hand-off once -> checks -> build approval -> build refused (builder off). */
async function briefPath(subjectId: string, kind: "setup" | "tool" | "remove_step", brief?: { id: string; hash: string }) {
  let b = brief;
  if (b === undefined) {
    const c = await w.call(`/insights/${subjectId}/solutions/choose`, "POST", { kind });
    expect(c.status).toBe(201);
    expect(c.body.kind).toBe(kind);
    expect(c.body.brief.status).toBe("draft");
    b = { id: c.body.brief.id, hash: c.body.brief.hash };
  }
  const dir = join(w.home, "solutions", b.id);
  expect(existsSync(join(dir, "BRIEF.md"))).toBe(true);
  // A stale hash is refused; the exact one mints a single-use token.
  expect((await w.call(`/solutions/${b.id}/approve`, "POST", { briefHash: "f".repeat(64) })).status).toBe(409);
  const ap = await w.call(`/solutions/${b.id}/approve`, "POST", { briefHash: b.hash });
  expect(ap.status).toBe(200);
  const h1 = await w.call(`/solutions/${b.id}/handoff`, "POST", { token: ap.body.token });
  expect(h1.status).toBe(200);
  expect(h1.body.builderPrompt.length).toBeGreaterThan(40);
  expect((await w.call(`/solutions/${b.id}/handoff`, "POST", { token: ap.body.token })).status).toBeGreaterThanOrEqual(400);
  // The checks are written first (frozen), then the build is approved for that exact brief and check.
  const ch = await w.call(`/solutions/${b.id}/checks`, "POST");
  expect(ch.status).toBe(201);
  const ba = await w.call(`/solutions/${b.id}/build/approve`, "POST", { briefHash: ch.body.set.briefHash, checkHash: ch.body.set.sha256 });
  expect(ba.status).toBe(200);
  const run = await w.call(`/solutions/${b.id}/build`, "POST", { token: ba.body.token });
  expect(run.status).toBe(403);
  expect(run.body.message).toMatch(/builder is off by default/);
  expect(run.body.message).toMatch(/KERN_PROCARGS2/);
  // Nothing was built: no run directory, no run record.
  const builds = join(w.home, "builds");
  expect(existsSync(builds) ? readdirSync(builds).filter((n) => n.startsWith("run_")) : []).toEqual([]);
  return b;
}

describe("s26 other fix kinds: honest end states", () => {
  test("SETUP: watching a coding agent is held back and its best fix is a setup change; the brief path ends with the build refused while the builder is off", async () => {
    const held = (insights.heldBack as any[]).find((h) => /Claude Code/.test(h.name));
    expect(held).toBeDefined();
    expect(held.solutions.top).toBe("setup");
    const set = (await w.call(`/insights/${held.id}/solutions`)).body;
    expect(set.options.find((o: any) => o.kind === "workflow").weeklyHoursSaved).toBe(0);
    await briefPath(held.id, "setup");
  });

  test("SETUP: a brief is text for a builder: the dashboard lists no automation and claims no saving for it", async () => {
    const d = (await w.call("/dashboard")).body;
    expect(d.automations).toEqual([]);
    expect(d.totals.measuredHoursSavedPerWeek).toBeNull();
    expect(d.totals.estimatedHoursSavedPerWeek).toBe(0);
  });

  test("REMOVE: making the image for a LinkedIn post by hand -> remove the step; the same brief path, build refused while the builder is off", async () => {
    const f = buildFixture(LINKEDIN_IMAGE);
    const set = rulesSolutions({ subject: f.subject, task: f.task, windowDays: f.windowDays, stepOf: f.stepOf });
    expect(set.top).toBe("remove_step");
    const r = await chooseSolution({ home: w.home, analysis: { insights: [], tasks: [], heldBack: [] } as any, set, kind: "remove_step", model: new StubModel(), models: DEFAULT_MODELS, now: () => SUNDAY_NIGHT });
    expect(r.kind).toBe("remove_step");
    if (r.kind === "workflow") throw new Error("unreachable");
    expect(r.brief.status).toBe("draft");
    await briefPath("", "remove_step", { id: r.brief.id, hash: r.brief.hash });
  });

  test("TOOL: the metrics task's custom-tool option is a brief too; build refused while the builder is off", async () => {
    const metrics = (insights.insights as any[]).find((i) => /Team metrics/.test(i.name));
    const tool = (await w.call(`/insights/${metrics.id}/solutions`)).body.options.find((o: any) => o.kind === "tool");
    expect(tool.weeklyHoursSaved).toBeGreaterThan(0);
    await briefPath(metrics.id, "tool");
  });

  test("LEAVE: inbox triage is best left alone; choosing it builds nothing, is remembered, and the task is not suggested again", async () => {
    const triage = (insights.insights as any[]).find((i) => i.kind === "email.triage");
    expect(triage).toBeDefined();
    expect(triage.solutions.top).toBe("leave_alone");
    expect(triage.solutions.leftAlone).toBe(false);
    const before = existsSync(join(w.home, "solutions")) ? readdirSync(join(w.home, "solutions")).length : 0;
    const r = await w.call(`/insights/${triage.id}/solutions/choose`, "POST", { kind: "leave_alone" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "leave_alone", leftAlone: { taskId: triage.taskId, insightId: triage.id, at: SUNDAY_NIGHT } });
    // Nothing built: no brief, no workflow. The choice is one 0600 file.
    expect(existsSync(join(w.home, "solutions")) ? readdirSync(join(w.home, "solutions")).length : 0).toBe(before);
    expect(existsSync(join(w.home, "workflows")) ? readdirSync(join(w.home, "workflows")).length : 0).toBe(0);
    expect(statSync(join(w.home, "left-alone.json")).mode & 0o777).toBe(0o600);
    // Remembered across a restart: flagged on the insight, gone from the dashboard's suggestions.
    w.rebrain();
    const again = (await w.call("/insights")).body.insights.find((i: any) => i.id === triage.id);
    expect(again.solutions.leftAlone).toBe(true);
    expect((await w.call("/dashboard")).body.suggestions.map((x: any) => x.insightId)).not.toContain(triage.id);
    const t = (await w.call("/time")).body;
    const f = t.findings.find((x: any) => x.insightId === triage.id);
    expect(f.fixKind).toBe("leave_alone");
    expect(f.workflowInsightId).toBeNull();
  });

  test("LEAVE: choosing another kind of fix later takes the task back (the left-alone mark is cleared)", async () => {
    const triage = (insights.insights as any[]).find((i) => i.kind === "email.triage");
    const r = await w.call(`/insights/${triage.id}/solutions/choose`, "POST", { kind: "workflow" });
    expect(r.status).toBe(201);
    const again = (await w.call("/insights")).body.insights.find((i: any) => i.id === triage.id);
    expect(again.solutions.leftAlone).toBe(false);
    // Only a known insight can be marked: unknown ids are 404.
    expect((await w.call(`/insights/ins_doesnotexist/solutions/choose`, "POST", { kind: "leave_alone" })).status).toBe(404);
  });
});
