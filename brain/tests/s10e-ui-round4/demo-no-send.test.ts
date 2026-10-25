// s10e work item 1, safety: a demo sign-in has no server, so nothing is ever sent through it. Activation (approving
// the dry-run batch) works on it, because activating sends nothing. Approving a live batch is a 409; every other send
// path (auto-run, the run loop, a direct sendBatch) never starts the executor and no tool call reaches the gate.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { ApproveResponse, ConnectLinkDTO, DryRunResponse, ErrorResponse, RunResponse } from "../../src/api/types.ts";
import { DEMO_SEND_REFUSED } from "../../src/connectors/link.ts";
import { sendBatch, type WorkflowContext } from "../../src/api/workflow-routes.ts";
import { approveBatch } from "../../src/workflows/runner.ts";
import { gateLogPath, readBatch } from "../../src/workflows/store.ts";
import { connectGmail } from "../s09b-brain/setup.ts";
import { writeRecipients } from "../s05-workflows/setup.ts";
import { BANNED_RE, linkWorld, type LinkWorld } from "./setup.ts";

let x: LinkWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

const ROWS = ["ana@fund.vc,Ana,Lee,Fund VC,", "bo@seed.vc,Bo,Kim,Seed VC,"];

/** Stub brain, gmail connected by the demo sign-in, the workflow activated, two recipients. */
async function demoActive(o: { env?: Record<string, string> } = {}): Promise<LinkWorld> {
  const w = await linkWorld({ linkMs: 0, ...(o.env === undefined ? {} : { env: o.env }) });
  await w.call<ConnectLinkDTO>("/connectors/gmail/link", { method: "POST" });
  expect((await w.call<ConnectLinkDTO>("/connectors/gmail/link")).body.state).toBe("connected");
  const dry = await w.call<DryRunResponse>(`/workflows/${w.outreach.id}/dry-run`, { method: "POST", body: { limit: 1 } });
  const act = await w.call<ApproveResponse>(`/workflows/${w.outreach.id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } });
  expect(act.status).toBe(200);
  expect(act.body.result).toBe("activated");
  writeRecipients(w.home, w.outreach.id, ROWS);
  return w;
}

const allowed = (home: string, id: string) => {
  const p = gateLogPath(home, id);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.includes('"decision":"allow"')) : [];
};

const ctxOf = (w: LinkWorld, executor: WorkflowContext["executor"]): WorkflowContext => ({
  home: w.home,
  env: {},
  model: w.model,
  modelLabel: "stub",
  executor,
  now: () => w.clock.now,
  analysis: async () => w.analysis,
  background: () => {},
});

describe("s10e: a demo sign-in never sends", () => {
  test("activation works on a demo sign-in; approving a live batch is a 409 with a plain message, nothing runs", async () => {
    x = await demoActive();
    const run = await x.call<RunResponse>(`/workflows/${x.outreach.id}/run`, { method: "POST" });
    expect(run.status).toBe(201);
    const r = await x.call<ErrorResponse>(`/workflows/${x.outreach.id}/approve`, { method: "POST", body: { batchHash: run.body.batch.hash } });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "conflict", message: DEMO_SEND_REFUSED });
    expect(r.body.message).not.toMatch(BANNED_RE);
    await x.brain.idle();
    expect(x.executorRuns).toHaveLength(0);
    expect(x.sends).toHaveLength(0);
    expect(readBatch(x.home, x.outreach.id, run.body.batch.hash, x.clock.now)!.state).toBe("pending");
    expect(allowed(x.home, x.outreach.id)).toEqual([]);
  });

  test("sendBatch with a valid approval token: the executor is never invoked and every item ends failed_before_send", async () => {
    x = await demoActive();
    const run = await x.call<RunResponse>(`/workflows/${x.outreach.id}/run`, { method: "POST" });
    const { token } = approveBatch(x.home, x.outreach.id, run.body.batch.hash, x.clock.now);
    expect(token).not.toBeNull();
    let invoked = 0;
    await sendBatch(ctxOf(x, { execute: async () => { invoked += 1; throw new Error("must not run"); } }), x.outreach.id, run.body.batch.hash, token, x.outreach.connectors);
    expect(invoked).toBe(0);
    const b = readBatch(x.home, x.outreach.id, run.body.batch.hash, x.clock.now)!;
    expect(b.state).toBe("failed");
    expect(Object.values(b.itemStates ?? {}).map((s) => s.state)).toEqual(["failed_before_send", "failed_before_send"]);
    expect(b.results.some((res) => res.error === DEMO_SEND_REFUSED)).toBe(true);
    expect(allowed(x.home, x.outreach.id)).toEqual([]);
    expect(x.sends).toHaveLength(0);
  });

  test("auto-run and the run loop hold the batch on a demo sign-in; nothing is sent", async () => {
    x = await demoActive();
    expect((await x.call(`/workflows/${x.outreach.id}/auto-run`, { method: "POST", body: { enabled: true } })).status).toBe(200);
    const run = await x.call<RunResponse>(`/workflows/${x.outreach.id}/run`, { method: "POST" });
    expect(run.status).toBe(201);
    expect(run.body.batch.state).toBe("pending");
    await x.brain.schedulerTick();
    await x.brain.idle();
    expect(x.executorRuns).toHaveLength(0);
    expect(x.sends).toHaveLength(0);
    expect(allowed(x.home, x.outreach.id)).toEqual([]);
  });

  test("a real connection still sends in stub mode (the guard is only for demo-only ids)", async () => {
    x = await demoActive({ env: { GMAIL_OAUTH_PATH: "/tmp/creds.json" } });
    connectGmail(x.home);
    const run = await x.call<RunResponse>(`/workflows/${x.outreach.id}/run`, { method: "POST" });
    const a = await x.call<ApproveResponse>(`/workflows/${x.outreach.id}/approve`, { method: "POST", body: { batchHash: run.body.batch.hash } });
    expect(a.status).toBe(200);
    expect(a.body.result).toBe("sending");
    await x.brain.idle();
    expect(x.executorRuns).toHaveLength(1);
    expect(x.sends.map((s) => s.to)).toEqual(["ana@fund.vc", "bo@seed.vc"]);
  });
});
