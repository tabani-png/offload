// s05 AC-5 end to end: dry run approved -> active -> live batch -> gate decides what is sent -> CRM log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectorStatus, summaryOf } from "../../src/workflows/service.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { ScriptedExecutor, sendEachItem } from "../../src/workflows/executor.ts";
import { enableAutoRun } from "../../src/workflows/autorun.ts";
import { approveBatch, executeBatch, prepareLiveBatch, RunError } from "../../src/workflows/runner.ts";
import { readBatch, readWorkflow, updateWorkflow } from "../../src/workflows/store.ts";
import { NOW, world, writeRecipients, type World } from "./setup.ts";

const SEND = "mcp__gmail__send_email";
let w: World;
let sent: Array<Record<string, unknown>> = [];
const executor = () => new ScriptedExecutor({ [SEND]: async (i) => void sent.push(i) }, sendEachItem(SEND));

beforeEach(async () => {
  w = await world();
  sent = [];
  writeRecipients(w.home, w.outreach.id, ["anna@northzone.com,Anna,Berg,Northzone,", "leo@hustlefund.vc,Leo,Park,Hustle Fund,", "tom@seedcamp.com,Tom,Reid,Seedcamp,"]);
});
afterEach(() => w.cleanup());

async function activate(): Promise<void> {
  const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 2, now: () => NOW });
  approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 1);
}

describe("s05 runner", () => {
  test("no live batch before the dry run is approved", async () => {
    await expect(prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model })).rejects.toThrow(RunError);
  });

  test("approving the dry-run batch activates the workflow; it is never executable", async () => {
    const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 2, now: () => NOW });
    const r = approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 5);
    expect(r.token).toBeNull();
    expect(readWorkflow(w.home, w.outreach.id)).toMatchObject({ status: "active", activatedAt: NOW + 5 });
    await expect(executeBatch({ home: w.home, workflowId: w.outreach.id, hash: d.batchHash, token: null, executor: executor(), now: () => NOW + 6 })).rejects.toThrow(/never executed/);
    expect(() => approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 6)).toThrow(/not pending/);
  });

  test("a live batch drafts the next recipients and puts the workflow in needs_you", async () => {
    await activate();
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 10 });
    expect(b.items.map((i) => i.to)).toEqual(["anna@northzone.com", "leo@hustlefund.vc", "tom@seedcamp.com"]);
    expect(b.items[0]!.subject).toBe("Offload seed round: Northzone");
    expect(b.items[0]!.body.startsWith("Hi Anna,")).toBe(true);
    const s = summaryOf(w.home, readWorkflow(w.home, w.outreach.id)!, connectorStatus(w.home, {}));
    expect(s.state).toBe("needs_you");
    expect(s.needsYou.join(" ")).toContain("is ready for review."); // s09b wording
    expect(s.needsYou.join(" ")).toContain("Connect Gmail so this can send.");
    // Asking again returns the same pending batch.
    expect((await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model })).hash).toBe(b.hash);
  });

  test("runner: executing a batch without its approval token sends nothing", async () => {
    await activate();
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model });
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token: null, executor: executor() });
    expect(sent).toEqual([]);
    expect(out.state).toBe("failed");
  });

  test("approved batch: every item sent once, CRM log written, the next batch skips them", async () => {
    await activate();
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model });
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 20);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: executor(), now: () => NOW + 21 });
    expect(out.state).toBe("sent");
    expect(sent.map((s) => s.to)).toEqual(["anna@northzone.com", "leo@hustlefund.vc", "tom@seedcamp.com"]);
    const log = readFileSync(join(w.home, "workflows", w.outreach.id, "crm-log.csv"), "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
    expect(log[1]).toContain("anna@northzone.com");
    expect(log[1]!.endsWith(",sent")).toBe(true);
    writeRecipients(w.home, w.outreach.id, ["anna@northzone.com,Anna,,Northzone,", "nina@balderton.com,Nina,,Balderton,"]);
    const next = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 30 });
    expect(next.items.map((i) => i.to)).toEqual(["nina@balderton.com"]);
  });

  test("runner: the token of batch A does not send batch B", async () => {
    await activate();
    const a = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 10 });
    const { token } = approveBatch(w.home, w.outreach.id, a.hash, NOW + 11);
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: a.hash, token, executor: executor() });
    writeRecipients(w.home, w.outreach.id, ["nina@balderton.com,Nina,,Balderton,"]);
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 12 });
    sent = [];
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: executor() });
    expect(sent).toEqual([]);
    expect(readBatch(w.home, w.outreach.id, b.hash)?.state).toBe("failed");
  });

  test("auto-run on: a live batch runs without a token; paused workflows refuse to run", async () => {
    await activate();
    // s10b N1: auto-run is turned on through enableAutoRun, which pins the recipients it may send to.
    enableAutoRun(w.home, w.outreach.id, NOW);
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model });
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token: null, executor: executor() });
    expect(sent).toHaveLength(3);
    updateWorkflow(w.home, w.outreach.id, (x) => void (x.status = "paused"), NOW);
    await expect(prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model })).rejects.toThrow(/paused/);
  });
});
