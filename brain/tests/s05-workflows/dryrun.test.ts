// s05 AC-4: dry run on last week's real instances, every side effect denied by the gate and logged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DryRunResponse } from "../../src/api/types.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { listBatches, readGateLog, readWorkflow } from "../../src/workflows/store.ts";
import { NOW, world, type World } from "./setup.ts";

let w: World;
let r: DryRunResponse;
beforeAll(async () => {
  w = await world();
  r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
});
afterAll(() => w.cleanup());

describe("s05 dry run", () => {
  test("drafts the 5 newest observed outreach instances, recipient and subject from OCR", () => {
    expect(r.instances).toHaveLength(5);
    const starts = r.instances.map((i) => i.start);
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    for (const i of r.instances) {
      expect(i.recipient.email).toMatch(/^[a-z.]+@[a-z0-9.]+$/);
      expect(i.subject).toMatch(/^Acme seed round: /);
      expect(i.draft?.startsWith(`Hi ${i.recipient.firstName},`)).toBe(true);
      expect(i.observed.excerpt).toContain("founder of Acme");
      expect(i.observed.eventIds.length).toBeGreaterThan(0);
    }
  });

  test("time per instance is code arithmetic: observed minutes minus the review seconds", () => {
    for (const i of r.instances) {
      expect(i.estimate.reviewSeconds).toBe(20);
      expect(i.estimate.savedMinutes).toBeCloseTo(i.estimate.observedMinutes - 20 / 60, 1);
      expect(i.estimate.observedMinutes).toBeGreaterThan(1);
    }
    expect(r.totals.arithmetic).toMatch(/^you spent [\d.]+ min on these 5 → review 5 × 20 s = 1\.7 min → saves [\d.]+ min$/);
  });

  test("every side effect is attempted through the gate and denied, and the log is on disk", () => {
    expect(r.sideEffects).toEqual({ attempted: 10, denied: 10 });
    expect(r.gateLog.every((d) => d.decision === "deny" && d.reason.includes("dry run"))).toBe(true);
    const log = readGateLog(w.home, w.outreach.id);
    expect(log.filter((d) => d.mode === "dry_run" && d.decision === "deny")).toHaveLength(10);
  });

  test("drafts use the drafting model with the style card, retrieved examples and facts; numbers all come from facts", () => {
    const drafts = w.model.calls.filter((c) => c.role === "draft");
    expect(drafts).toHaveLength(5);
    expect(drafts.every((c) => c.model === "claude-opus-5-5")).toBe(true);
    expect(drafts[0]!.prompt).toContain("# Style card: investor outreach");
    expect(drafts[0]!.prompt).toContain("--- example 3");
    expect(drafts[0]!.prompt).toContain("traction: $40k MRR");
    expect(drafts[0]!.system).toContain("## The big picture");
    expect(r.instances.every((i) => i.warnings.length === 0)).toBe(true);
    expect(r.instances.every((i) => i.examplesUsed.length >= 3)).toBe(true);
  });

  test("the dry-run batch is stored and its hash recorded on the workflow", () => {
    const b = listBatches(w.home, w.outreach.id);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: "dry_run", state: "pending", hash: r.batchHash });
    expect(readWorkflow(w.home, w.outreach.id)?.lastDryRunHash).toBe(r.batchHash);
    expect(existsSync(join(w.home, "workflows", w.outreach.id, "dry-run.json"))).toBe(true);
  });

  test("a draft with a number not in the facts is flagged; no tone pack is a warning", async () => {
    const v = await world({ tone: false });
    try {
      const { StubModel } = await import("../../src/models/model.ts");
      const liar = new StubModel({ draft: () => "Hi X,\n\nWe have 900 customers.\n\nMuhammad" });
      const res = await dryRun({ home: v.home, analysis: v.analysis, workflowId: v.outreach.id, model: liar, limit: 2, now: () => NOW });
      expect(res.instances).toHaveLength(2);
      expect(res.instances[0]!.warnings).toContain("number not in the facts: 900");
      expect(res.warnings.join(" ")).toContain("no tone pack");
    } finally {
      v.cleanup();
    }
  });
});
