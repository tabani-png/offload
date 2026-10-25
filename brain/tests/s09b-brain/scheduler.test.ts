// s09b: the serve run loop. On each tick (injected clock) a workflow whose cron slot is due starts ONLY when it is
// active, and then either (auto-run off) drafts a pending batch for review, which shows as needs_you "A new batch of N
// is ready for review.", or (auto-run on, connectors connected) approves that exact batch hash and sends it.
// Nothing is ever sent without an approved batch hash.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApproveResponse, DashboardResponse, DryRunResponse } from "../../src/api/types.ts";
import { startBrainServer } from "../../src/api/server.ts";
import { listBatches, readWorkflow, updateWorkflow } from "../../src/workflows/store.ts";
import { writeRecipients } from "../s05-workflows/setup.ts";
import { connectGmail, local, s09bWorld, type S09bWorld } from "./setup.ts";

let w: S09bWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const MON_0800 = local(2026, 10, 19, 8, 0);
const MON_0900 = local(2026, 10, 19, 9, 0);
const MON_0901 = local(2026, 10, 19, 9, 1);

async function activeWorld(o: { autoRun?: boolean; gmail?: boolean } = {}): Promise<S09bWorld> {
  const x = await s09bWorld({ now: MON_0800 });
  if (o.gmail === true) connectGmail(x.home);
  const dry = await x.call<DryRunResponse>(`/workflows/${x.outreach.id}/dry-run`, { method: "POST", body: { limit: 1 } });
  expect((await x.call<ApproveResponse>(`/workflows/${x.outreach.id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } })).body.result).toBe("activated");
  writeRecipients(x.home, x.outreach.id, ["ana@fund.vc,Ana,Lee,Fund VC,", "bo@seed.vc,Bo,Kim,Seed VC,", "cy@pre.vc,Cy,Ito,Pre VC,"]);
  if (o.autoRun === true) expect((await x.call(`/workflows/${x.outreach.id}/auto-run`, { method: "POST", body: { enabled: true } })).status).toBe(200);
  return x;
}

const live = (x: S09bWorld) => listBatches(x.home, x.outreach.id, x.clock.now).filter((b) => b.kind === "live");
const tick = async (x: S09bWorld, at: number) => {
  x.clock.now = at;
  const r = await x.brain.schedulerTick();
  await x.brain.idle();
  return r;
};

describe("s09b scheduler", () => {
  test("SCHED: before the slot nothing starts; at Monday 09:00 an active workflow (auto-run off) drafts a pending batch and sends nothing", async () => {
    w = await activeWorld({ gmail: true });
    expect((await tick(w, local(2026, 10, 19, 8, 59))).started).toEqual([]);
    expect(live(w)).toEqual([]);
    const r = await tick(w, MON_0900);
    expect(r.started).toEqual([{ workflowId: w.outreach.id, batchHash: live(w)[0]!.hash, items: 3, sending: false }]);
    expect(live(w).map((b) => b.state)).toEqual(["pending"]);
    expect(w.sends).toEqual([]);
    const a = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(a.state).toBe("needs_you");
    expect(a.needsYou).toEqual(["A new batch of 3 is ready for review."]);
    expect(a.pendingBatch?.hash).toBe(live(w)[0]!.hash);
  });

  test("SCHED: the same slot fires once; a later tick before the next slot does nothing", async () => {
    w = await activeWorld({ gmail: true });
    await tick(w, MON_0900);
    expect((await tick(w, MON_0901)).started).toEqual([]);
    expect((await tick(w, local(2026, 10, 19, 17, 0))).started).toEqual([]);
    expect(live(w).length).toBe(1);
    expect(readWorkflow(w.home, w.outreach.id)!.lastScheduledAt).toBe(MON_0900);
  });

  test("SCHED: a draft (ready_for_review) workflow never starts, even when due", async () => {
    w = await s09bWorld({ now: MON_0800 });
    expect((await tick(w, MON_0900)).started).toEqual([]);
    expect(live(w)).toEqual([]);
  });

  test("SCHED: a paused workflow does not start, and resuming after the slot does not catch up", async () => {
    w = await activeWorld({ gmail: true });
    await w.call(`/workflows/${w.outreach.id}/pause`, { method: "POST" });
    expect((await tick(w, MON_0900)).started).toEqual([]);
    w.clock.now = local(2026, 10, 19, 10, 0);
    await w.call(`/workflows/${w.outreach.id}/resume`, { method: "POST" });
    expect((await tick(w, local(2026, 10, 19, 10, 1))).started).toEqual([]);
    expect(live(w)).toEqual([]);
  });

  test("SCHED: a workflow activated after today's slot waits for the next slot", async () => {
    w = await activeWorld({ gmail: true });
    updateWorkflow(w.home, w.outreach.id, (x) => {
      x.activatedAt = local(2026, 10, 19, 9, 30);
      x.schedule = { type: "cron", cron: "0 9,15 * * *", timezone: "local", note: "twice a day" };
    }, MON_0800);
    expect((await tick(w, local(2026, 10, 19, 9, 45))).started).toEqual([]);
    expect((await tick(w, local(2026, 10, 19, 15, 0))).started.length).toBe(1);
  });

  test("SCHED: a manual schedule never starts", async () => {
    w = await activeWorld({ gmail: true });
    updateWorkflow(w.home, w.outreach.id, (x) => void (x.schedule = { type: "manual" }), MON_0800);
    expect((await tick(w, MON_0900)).started).toEqual([]);
  });

  test("SCHED: auto-run on and Gmail connected: the scheduler approves that batch hash and sends exactly its items once", async () => {
    w = await activeWorld({ autoRun: true, gmail: true });
    const r = await tick(w, MON_0900);
    expect(r.started.length).toBe(1);
    expect(r.started[0]!.sending).toBe(true);
    const b = live(w)[0]!;
    expect(b.hash).toBe(r.started[0]!.batchHash);
    expect(b.approvedAt).toBe(MON_0900);
    expect(b.state).toBe("sent");
    expect(w.sends.map((s) => s.to).sort()).toEqual(["ana@fund.vc", "bo@seed.vc", "cy@pre.vc"]);
    // The gate log shows each send allowed under that batch's approval.
    const gate = readFileSync(join(w.home, "workflows", w.outreach.id, "gate-log.jsonl"), "utf8");
    expect(gate).toContain('"decision":"allow"');
    const a = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(a.state).toBe("active");
    expect(a.needsYou).toEqual([]);
  });

  test("SCHED: auto-run on but Gmail not connected: the batch waits for review and nothing is sent", async () => {
    w = await activeWorld({ autoRun: true, gmail: false });
    const r = await tick(w, MON_0900);
    expect(r.started[0]!.sending).toBe(false);
    expect(live(w).map((b) => b.state)).toEqual(["pending"]);
    expect(w.sends).toEqual([]);
    const a = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(a.needsYou).toEqual(["A new batch of 3 is ready for review.", "Connect Gmail so this can send."]);
  });

  test("SCHED: a pending batch from the last slot is not replaced: the next slot drafts nothing new", async () => {
    w = await activeWorld({ gmail: true });
    updateWorkflow(w.home, w.outreach.id, (x) => void (x.schedule = { type: "cron", cron: "0 9,15 * * *", timezone: "local", note: "" }), MON_0800);
    await tick(w, MON_0900);
    const first = live(w)[0]!.hash;
    const r = await tick(w, local(2026, 10, 19, 15, 0));
    expect(r.started).toEqual([]);
    expect(r.skipped).toContainEqual({ workflowId: w.outreach.id, reason: "a batch already waits for review" });
    expect(live(w).map((b) => b.hash)).toEqual([first]);
    expect(w.sends).toEqual([]);
  });

  test("SCHED: serve runs the loop on its own: startBrainServer ticks with the injected clock", async () => {
    w = await activeWorld({ gmail: true });
    const x = w;
    x.clock.now = MON_0900;
    const srv = await startBrainServer({ home: x.home, token: "t".repeat(40), now: () => x.clock.now, workflows: { model: x.model, env: { GMAIL_OAUTH_PATH: "/tmp/creds.json" } }, schedulerIntervalMs: 20, log: () => {} });
    try {
      const deadline = Date.now() + 5_000;
      while (live(x).length === 0 && Date.now() < deadline) await Bun.sleep(20);
    } finally {
      await srv.stop();
    }
    expect(live(x).map((b) => b.state)).toEqual(["pending"]);
    expect(x.sends).toEqual([]);
  });
});
