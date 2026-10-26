// LEFTOVER (review wave B, PR #7 item 2): a draft that still holds a name Offload could not fill in (a placeholder the
// model invented or echoed, or <name>) is never sent by auto-run: it waits for review, with the warning on the item and
// a needs-you line that says why.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DashboardResponse } from "../../src/api/types.ts";
import { ModelRouter, RoutedModel, type BackendRequest } from "../../src/models/router.ts";
import { unrestoredPlaceholders } from "../../src/privacy/names.ts";
import { autoSendable, enableAutoRun, partitionForAuto, reviewSentence } from "../../src/workflows/autorun.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { ScriptedExecutor, sendEachItem } from "../../src/workflows/executor.ts";
import { approveBatch, executeBatch, prepareLiveBatch, splitBatch } from "../../src/workflows/runner.ts";
import { readWorkflow } from "../../src/workflows/store.ts";
import { NOW, world, writeRecipients, type World } from "../s05-workflows/setup.ts";
import { activeWorld, live, MON_0900, tick } from "../s10b-review2/setup.ts";
import { EchoNotesBackend, UNFILLED } from "./echo.ts";

describe("s18 live run: a leftover placeholder", () => {
  let w: World;
  const sent: Array<Record<string, unknown>> = [];
  const executor = () => new ScriptedExecutor({ mcp__gmail__send_email: async (i) => void sent.push(i) }, sendEachItem("mcp__gmail__send_email"));
  beforeEach(async () => {
    w = await world();
    sent.length = 0;
  });
  afterEach(() => w.cleanup());

  const routed = (extra?: (r: BackendRequest) => string) => new RoutedModel(new ModelRouter({ home: w.home, backend: new EchoNotesBackend(extra), monthlyBudgetUsd: null }));

  test("LEFTOVER: auto-run never sends a draft that still holds an unfilled name; it waits for review with the warning", async () => {
    writeRecipients(w.home, w.outreach.id, ["anna@northzone.com,Anna,Berg,Northzone,", "leo@hustlefund.vc,Leo,Park,Hustle Fund,"]);
    // The model invents a placeholder for Leo's draft only.
    const model = routed((r) => (r.prompt.includes("hustlefund.vc") ? "\nP.S. say hi to <person:9>" : ""));
    const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model, limit: 1, now: () => NOW });
    approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 1);
    enableAutoRun(w.home, w.outreach.id, NOW + 2);
    const live = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model, now: () => NOW + 10 });
    const leo = live.items.find((i) => i.to === "leo@hustlefund.vc")!;
    expect(unrestoredPlaceholders(leo.body)).toEqual(["<person:9>"]);
    expect(leo.warnings).toContain(UNFILLED);
    const wf = readWorkflow(w.home, w.outreach.id)!;
    const p = partitionForAuto(w.home, wf, live);
    expect(p.eligible.map((i) => i.to)).toEqual(["anna@northzone.com"]);
    expect(p.unfilledItems.map((i) => i.to)).toEqual(["leo@hustlefund.vc"]);
    expect(autoSendable(w.home, wf, live)).toBe(false);
    // The auto path (no token) sends nothing from this batch.
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: live.hash, token: null, executor: executor(), now: () => NOW + 11 });
    expect(sent).toEqual([]);
    expect(out.state).toBe("pending");
    // Split as auto-run does: Anna goes, Leo waits with a reason the review screen shows.
    const split = splitBatch(w.home, live, new Set(p.eligible.map((i) => i.key)), { newRecipients: 0, changedRecipients: 0, changedFiles: [], unfilledNames: p.unfilledItems.length }, NOW + 12);
    expect(split.held!.items.map((i) => i.to)).toEqual(["leo@hustlefund.vc"]);
    expect(split.held!.items[0]!.warnings).toContain(UNFILLED);
    expect(reviewSentence(split.held!)).toBe("1 draft has a name Offload could not fill in: check it before you approve.");
    expect(autoSendable(w.home, wf, split.kept!)).toBe(true);
  }, 120_000);

  test("LEFTOVER: a literal <name> left in a draft is an unfilled name too", () => {
    expect(unrestoredPlaceholders("Hi <name>, thanks")).toEqual(["<name>"]);
    expect(unrestoredPlaceholders("Hi Anna, thanks")).toEqual([]);
  });
});

describe("s18 scheduler: the auto-run loop holds an unfilled name", () => {
  test("LEFTOVER: the scheduler's auto-run sends the other drafts and holds the one with an unfilled name for review", async () => {
    const x = await activeWorld({ autoRun: true });
    try {
      // The model leaves a placeholder in Bo's draft only.
      const complete = x.model.complete.bind(x.model);
      x.model.complete = async (r) => {
        const text = await complete(r);
        return r.role === "draft" && r.prompt.includes("bo@seed.vc") ? `${text}\nP.S. <person:4> says hi` : text;
      };
      await tick(x, MON_0900);
      expect(x.sends.map((s) => s.to).sort()).toEqual(["ana@fund.vc", "cy@pre.vc"]);
      const pending = live(x).filter((b) => b.state === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.items.map((i) => i.key)).toEqual(["bo@seed.vc"]);
      expect(pending[0]!.items[0]!.warnings).toContain(UNFILLED);
      expect(pending[0]!.review).toMatchObject({ unfilledNames: 1 });
      const needs = (await x.call<DashboardResponse>("/dashboard")).body.automations[0]!.needsYou;
      expect(needs).toContain("1 draft has a name Offload could not fill in: check it before you approve.");
    } finally {
      x.cleanup();
    }
  }, 120_000);
});
