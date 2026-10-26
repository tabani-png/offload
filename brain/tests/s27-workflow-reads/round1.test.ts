// s27 review round 1 (PR #35): a source with more rows than one batch is worked through to the end (done rows are
// dropped before any limit), and a pause during a read stops the whole chain: no further method, no screen opened.
import { afterEach, describe, expect, test } from "bun:test";
import { readBatch, updateWorkflow } from "../../src/workflows/store.ts";
import type { SourceReader } from "../../src/workflows/read-fetch.ts";
import { activeMetricsWorkflow, dashJson, FakeReader, MCP_READ_TOOL, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const ROWS = Array.from({ length: 120 }, (_, i) => ({ week: String(100 + i), signups: String(300 + i), active_users: String(2000 + i), churn: String(i % 5) }));

describe("s27 round 1", () => {
  test("LIVE: 120 rows at the source are entered over 3 runs (50, 50, 20); done rows never hide the rest", async () => {
    const many = new FakeReader(() => JSON.stringify({ results: ROWS }), MCP_READ_TOOL);
    w = world({ readers: { mcp: many } });
    const { id } = await activeMetricsWorkflow(w);
    updateWorkflow(w.home, id, (x) => {
      x.batchSize = 50;
    });
    const weeks: string[] = [];
    for (const want of [50, 50, 20]) {
      const r = await w.call(`/workflows/${id}/run`, "POST", {});
      expect(r.status).toBe(201);
      expect(r.body.items).toHaveLength(want);
      const b = readBatch(w.home, id, r.body.batch.hash, w.clock.now)!;
      weeks.push(...b.items.map((i) => i.commit!.fields[0]![1]));
      expect((await w.call(`/workflows/${id}/approve`, "POST", { batchHash: r.body.batch.hash })).status).toBe(200);
      await w.brain.idle();
      expect(readBatch(w.home, id, r.body.batch.hash, w.clock.now)!.state).toBe("sent");
    }
    expect(new Set(weeks).size).toBe(120);
    expect(weeks.sort()).toEqual(ROWS.map((r) => r.week).sort());
    const done = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(done.status).toBe(409);
    expect(done.body.message).toMatch(/nothing new at PostHog/);
  }, 60_000);

  test("FETCH: a pause during a read stops the chain: the failing connector is not followed by Composio or the screen", async () => {
    let wid = "";
    let world0: World | null = null;
    const pausing: SourceReader = {
      async read(job) {
        if (wid === "" || world0 === null) return job.call(MCP_READ_TOOL, job.args, async () => dashJson(world0!.driver.dash));
        // The person pauses the workflow while the connector is reading; then the connector fails.
        await world0.call(`/workflows/${wid}/pause`, "POST", {});
        throw new Error("the connector stopped");
      },
    };
    w = world({ readers: { mcp: pausing } });
    world0 = w;
    // Activate with a good read first (no pause yet), then arm the pause.
    const { id } = await activeMetricsWorkflow(w);
    wid = id;
    const opened = w.driver.opened.length;
    const composio = w.composioReader.calls;
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/paused/);
    expect(w.composioReader.calls).toBe(composio);
    expect(w.driver.opened.slice(opened)).not.toContain(SOURCE_TARGET);
    expect(w.driver.touches()).toBe(0);
    // The connector was not blamed for the pause: it is not marked failed.
    const mcp = w.brain.chain.peek(SOURCE_TARGET)!.methods.find((m) => m.method === "mcp")!;
    expect(mcp.lastError ?? "").not.toMatch(/connector stopped/);
  });
});
