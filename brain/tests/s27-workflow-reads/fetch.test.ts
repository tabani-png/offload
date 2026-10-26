// s27: the read goes through the connector chain in its order (MCP -> Composio -> direct API -> computer use). A method
// that fails is marked failed and the next one reads; when only the screen is left, Offload opens the dashboard and
// reads its text without a single click or keystroke.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBatch } from "../../src/workflows/store.ts";
import { activeMetricsWorkflow, SHEET_COLUMNS, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const SCREEN = `computer_${SOURCE_TARGET.replace(/-/g, "_")}`;

describe("s27 fetch through the chain", () => {
  test("FETCH: MCP first: with both a connector on this Mac and Composio set up, the connector reads and Composio is not asked", async () => {
    w = world();
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source.via).toBe("mcp");
    expect(w.composioReader.calls).toBe(0);
  });

  test("FETCH: when the MCP read fails, that method is marked failed and Composio reads the same values", async () => {
    w = world();
    w.mcpReader.fail = "the connector stopped";
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source).toMatchObject({ kind: "read", via: "composio", name: "PostHog" });
    const b = readBatch(w.home, id, r.body.batch.hash, w.clock.now)!;
    expect(b.items[0]!.commit!.fields).toEqual(SHEET_COLUMNS.map((c, k) => [c, ["43", "352", "2410", "3"][k]!]));
    const mcp = w.brain.chain.peek(SOURCE_TARGET)!.methods.find((m) => m.method === "mcp")!;
    expect(mcp.health).toBe("failed");
    expect(mcp.lastError).toMatch(/connector stopped/);
  });

  test("FETCH: only a screen read is possible: Offload opens the dashboard, reads its text and never clicks or types there", async () => {
    w = world({ mcp: "none", composio: "none" });
    const { id, dir } = await activeMetricsWorkflow(w);
    const opened = w.driver.opened.length;
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source).toMatchObject({ kind: "read", via: "computer", name: "PostHog" });
    expect(r.body.source.message).toMatch(/screen/);
    expect(w.driver.opened.slice(opened)).toEqual([SOURCE_TARGET]);
    expect(w.driver.touches()).toBe(0);
    expect(w.driver.pressed).toHaveLength(0);
    const b = readBatch(w.home, id, r.body.batch.hash, w.clock.now)!;
    expect(b.items[0]!.commit!.fields).toEqual(SHEET_COLUMNS.map((c, k) => [c, ["43", "352", "2410", "3"][k]!]));
    const log = readFileSync(join(dir, "gate-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.mode === "read");
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((l) => l.tool === `mcp__${SCREEN}__read` && l.decision === "allow")).toBe(true);
    // Then the approved row is entered in the sheet: exactly once, exactly the values read from the screen.
    await w.call(`/workflows/${id}/approve`, "POST", { batchHash: r.body.batch.hash });
    await w.brain.idle();
    expect(w.driver.pressed.map((p) => p.title)).toEqual(["Save"]);
    expect(w.driver.pressed[0]!.form.map((f) => f.value)).toEqual(["43", "352", "2410", "3"]);
  });

  test("FETCH: values the source does not show are never invented: a dashboard missing a number reads as a plain failure, not a guess", async () => {
    w = world({ mcp: "none", composio: "none" });
    const { id, dir } = await activeMetricsWorkflow(w);
    w.driver.dash = { week: "44", signups: "", active: "2455", churn: "2" };
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Signups/);
    expect(r.body.message).toMatch(/items\.csv/);
    expect(w.driver.pressed).toHaveLength(0);
    const log = readFileSync(join(dir, "gate-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.mode === "read");
    expect(log.every((l) => l.decision === "allow" && /__read$/.test(l.tool))).toBe(true);
  });
});
