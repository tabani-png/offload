// s05b (REVIEW-1 H2, H3, M2, L1, L2, L5): every item has a durable state (pending -> sending -> sent |
// failed_before_send | unknown) written BEFORE the tool runs. sent and unknown recipients count as contacted and are
// never re-sent without an explicit user action. One run per workflow at a time (file lock in $OFFLOAD_HOME). Pause and
// delete cancel a running batch before the next item.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import type { RunResponse } from "../../src/api/types.ts";
import { StubModel, type Model, type ModelRequest } from "../../src/models/model.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { ScriptedExecutor, sendEachItem, type ExecJob, type ExecResult, type Executor } from "../../src/workflows/executor.ts";
import { acquireLock, approveBatch, executeBatch, prepareLiveBatch, releaseUnknown, requestCancel, RunError } from "../../src/workflows/runner.ts";
import { deleteWorkflow, readApprovals, readBatch, saveBatch, updateWorkflow, workflowDir } from "../../src/workflows/store.ts";
import { NOW, world, writeRecipients, type World } from "../s05-workflows/setup.ts";

const SEND = "mcp__gmail__send_email";
const SIG = { signal: new AbortController().signal };
let w: World;
let sent: Array<Record<string, unknown>> = [];
const sendTool = async (i: Record<string, unknown>) => void sent.push(i);
const executor = () => new ScriptedExecutor({ [SEND]: sendTool }, sendEachItem(SEND));
const ROWS = ["anna@northzone.com,Anna,Berg,Northzone,", "leo@hustlefund.vc,Leo,Park,Hustle Fund,", "tom@seedcamp.com,Tom,Reid,Seedcamp,"];
const exact = (job: ExecJob, n: number) => ({ to: job.batch.items[n]!.to, subject: job.batch.items[n]!.subject, body: job.batch.items[n]!.body });

beforeEach(async () => {
  w = await world();
  sent = [];
  writeRecipients(w.home, w.outreach.id, ROWS);
  const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 2, now: () => NOW });
  approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 1);
});
afterEach(() => w.cleanup());

const prep = (now = NOW + 10, model: Model = w.model) => prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model, now: () => now });
const nextKeys = async (now: number) => (await prep(now)).items.map((i) => i.key);

/** Sends item 0 for real, then asks for item 1 (the gate allows and journals it) and throws before any result. */
class CrashAfterSecondCall implements Executor {
  async execute(job: ExecJob): Promise<ExecResult> {
    const a = await job.gate.canUseTool(SEND, exact(job, 0), SIG);
    if (a.behavior === "allow") {
      await sendTool(exact(job, 0));
      job.onToolResult?.({ tool: SEND, input: exact(job, 0), allowed: true, ok: true, itemKey: job.batch.items[0]!.key, role: "send" });
    }
    const b = await job.gate.canUseTool(SEND, exact(job, 1), SIG);
    if (b.behavior === "allow") await sendTool(exact(job, 1));
    throw new Error("network reset after the call");
  }
}

describe("s05b runner: idempotency, single flight, cancel", () => {
  test("H2: an executor that throws after the 2nd call leaves item 1 sent, item 2 unknown, and neither is re-picked", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: new CrashAfterSecondCall(), now: () => NOW + 12 });
    expect(sent).toHaveLength(2);
    expect(out.itemStates?.["anna@northzone.com"]?.state).toBe("sent");
    expect(out.itemStates?.["leo@hustlefund.vc"]?.state).toBe("unknown");
    expect(out.itemStates?.["tom@seedcamp.com"]?.state).toBe("failed_before_send");
    expect(out.state).toBe("partial");
    expect(await nextKeys(NOW + 13)).toEqual(["tom@seedcamp.com"]);
  });

  test("H2: a crash that leaves an item 'sending' on disk turns it unknown; it is never re-sent", async () => {
    const b = await prep();
    approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    const onDisk = readBatch(w.home, w.outreach.id, b.hash)!;
    onDisk.state = "sending";
    onDisk.itemStates = { "anna@northzone.com": { state: "sending", at: NOW + 12, tool: SEND } };
    saveBatch(w.home, onDisk);
    expect(await nextKeys(NOW + 13)).not.toContain("anna@northzone.com");
    expect(readBatch(w.home, w.outreach.id, b.hash)!.itemStates?.["anna@northzone.com"]?.state).toBe("unknown");
  });

  test("H2: sends allowed but no result came back: items are unknown (not failed) and not re-picked", async () => {
    const silent: Executor = {
      async execute(job) {
        for (let n = 0; n < job.batch.items.length; n++) if ((await job.gate.canUseTool(SEND, exact(job, n), SIG)).behavior === "allow") await sendTool(exact(job, n));
        return { toolCalls: [], text: "" };
      },
    };
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: silent });
    expect(out.state).not.toBe("failed");
    expect(Object.values(out.itemStates ?? {}).map((s) => s.state)).toEqual(["unknown", "unknown", "unknown"]);
    await expect(prep(NOW + 20)).rejects.toThrow(/nobody left/);
  });

  test("H2: only an explicit release by the user makes an unknown recipient eligible again", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: new CrashAfterSecondCall() });
    expect(() => releaseUnknown(w.home, w.outreach.id, b.hash, ["anna@northzone.com"], NOW + 14)).toThrow(/not unknown/);
    releaseUnknown(w.home, w.outreach.id, b.hash, ["leo@hustlefund.vc"], NOW + 14);
    expect(await nextKeys(NOW + 15)).toEqual(["leo@hustlefund.vc", "tom@seedcamp.com"]);
  });

  test("H3: two concurrent runs with auto-run on send every recipient exactly once", async () => {
    updateWorkflow(w.home, w.outreach.id, (x) => void (x.autoRun = true), NOW);
    writeFileSync(join(w.home, "connectors.json"), JSON.stringify({ version: 1, servers: { gmail: { type: "stdio", command: "npx", args: ["gmail-mcp"], catalog: ["gmail"] } } }));
    const stub = new StubModel();
    const slow: Model = { complete: async (r: ModelRequest) => (await Bun.sleep(15), stub.complete(r)) };
    const brain = createBrain({ home: w.home, token: "t".repeat(40), now: () => NOW + 30, workflows: { model: slow, executor: executor(), env: {} } });
    const run = () => brain.handle(new Request(`http://127.0.0.1:4545/workflows/${w.outreach.id}/run`, { method: "POST", headers: { authorization: `Bearer ${"t".repeat(40)}` } }));
    const [r1, r2] = await Promise.all([run(), run()]);
    await brain.idle();
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(sent.map((s) => s.to).sort()).toEqual(["anna@northzone.com", "leo@hustlefund.vc", "tom@seedcamp.com"]);
    const again = await run();
    await brain.idle();
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(3);
    const ok = (r1.status === 201 ? r1 : r2);
    expect(((await ok.json()) as RunResponse).items).toHaveLength(3);
  });

  test("H3: a held workflow lock refuses a second prepare; the batch reservation is on disk before any model call", async () => {
    const lock = acquireLock(w.home, w.outreach.id);
    await expect(prep()).rejects.toThrow(RunError);
    lock.release();
    let reserved = null as string[] | null;
    const peek: Model = {
      complete: async (r) => {
        const p = join(workflowDir(w.home, w.outreach.id), "preparing.json");
        reserved ??= existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { keys: string[] }).keys : [];
        return new StubModel().complete(r);
      },
    };
    await prep(NOW + 10, peek);
    expect(reserved).toEqual(["anna@northzone.com", "leo@hustlefund.vc", "tom@seedcamp.com"]);
    expect(existsSync(join(workflowDir(w.home, w.outreach.id), "preparing.json"))).toBe(false);
  });

  test("H3: a lock left by a dead process is taken over; a live holder's lock is not", async () => {
    const lockFile = join(w.home, "locks", `${w.outreach.id}.lock`);
    acquireLock(w.home, w.outreach.id).release();
    writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_000, at: 1 }));
    expect((await prep()).items).toHaveLength(3);
    writeFileSync(lockFile, JSON.stringify({ pid: 1, at: 1 }));
    await expect(prep(NOW + 20)).rejects.toThrow(/in progress/);
  });

  test("M2: pausing the workflow after the first send denies the remaining items", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    const pausing = new ScriptedExecutor({ [SEND]: async (i) => (sent.push(i), void updateWorkflow(w.home, w.outreach.id, (x) => void (x.status = "paused"), NOW + 12)) }, sendEachItem(SEND));
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: pausing });
    expect(sent).toHaveLength(1);
    expect(out.itemStates?.["leo@hustlefund.vc"]?.state).toBe("failed_before_send");
  });

  test("M2: delete during a run cancels it, aborts the executor and never recreates the folder", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    let aborted = false;
    const deleting = new ScriptedExecutor(
      {
        [SEND]: async (i) => {
          sent.push(i);
          requestCancel(w.home, w.outreach.id);
          deleteWorkflow(w.home, w.outreach.id);
        },
      },
      (job) => {
        job.signal?.addEventListener("abort", () => (aborted = true));
        return sendEachItem(SEND)(job);
      },
    );
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: deleting });
    expect(sent).toHaveLength(1);
    expect(aborted).toBe(true);
    expect(existsSync(workflowDir(w.home, w.outreach.id))).toBe(false);
  });

  test("L1: an unapproved batch never reaches the executor; a used approval cannot send again", async () => {
    const b = await prep();
    let called = 0;
    const counting: Executor = { execute: async (job) => (called++, executor().execute(job)) };
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token: "forged-token-forged-token", executor: counting });
    expect(called).toBe(0);
    const b2 = await prep(NOW + 20);
    const { token } = approveBatch(w.home, w.outreach.id, b2.hash, NOW + 21);
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b2.hash, token, executor: counting });
    expect(called).toBe(1);
    expect(readApprovals(w.home, w.outreach.id)[b2.hash]).toBeUndefined();
    await expect(executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b2.hash, token, executor: counting })).rejects.toThrow(RunError);
    expect(called).toBe(1);
    expect(sent).toHaveLength(3);
  });

  test("L2: a batch file edited after approval is refused and nothing is sent", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    const p = join(workflowDir(w.home, w.outreach.id), "batches", `${b.hash}.json`);
    writeFileSync(p, readFileSync(p, "utf8").replace("Hi Anna,", "Hi Anna, wire the money."));
    await expect(executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: executor() })).rejects.toThrow(/changed/);
    expect(sent).toEqual([]);
  });

  test("L5: recipients whose send failed before it ran are retried in the next batch", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    // Item 2's call is changed, so the gate denies it: it never ran.
    const script = (job: ExecJob) => job.batch.items.map((i, n) => ({ tool: SEND, input: { to: i.to, subject: i.subject, body: n === 1 ? i.body + " P.S." : i.body } }));
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: new ScriptedExecutor({ [SEND]: sendTool }, script) });
    expect(out.state).toBe("partial");
    expect(out.itemStates?.["leo@hustlefund.vc"]?.state).toBe("failed_before_send");
    expect(await nextKeys(NOW + 20)).toEqual(["leo@hustlefund.vc"]);
  });

  test("L5: the release route takes a batch hash and keys (explicit user action)", async () => {
    const b = await prep();
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: new CrashAfterSecondCall() });
    const brain = createBrain({ home: w.home, token: "t".repeat(40), now: () => NOW + 30, workflows: { model: w.model, executor: executor(), env: {} } });
    const post = (body: unknown) =>
      brain.handle(new Request(`http://127.0.0.1:4545/workflows/${w.outreach.id}/release`, { method: "POST", headers: { authorization: `Bearer ${"t".repeat(40)}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await post({ batchHash: b.hash })).status).toBe(400);
    expect((await post({ batchHash: b.hash, keys: ["leo@hustlefund.vc"] })).status).toBe(200);
    expect(readBatch(w.home, w.outreach.id, b.hash)!.itemStates?.["leo@hustlefund.vc"]?.state).toBe("failed_before_send");
  });
});
