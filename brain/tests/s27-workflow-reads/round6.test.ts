// s27 review round 6 (PR #35), end to end: an empty answer and an all-incomplete answer are successful reads (no fall
// back to a stale items.csv); a context conflict nested under a matching one refuses that method and the next one reads.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeMetricsWorkflow, FakeReader, itemsCsv, MCP_READ_TOOL, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

describe("s27 round 6: outcomes end to end", () => {
  test("LIVE: an empty answer ({results: []}) is nothing new at PostHog, not a fall back to items.csv", async () => {
    let answer = JSON.stringify({ results: [{ week: "43", signups: "352", active_users: "2410", churn: "3" }] });
    const r1 = new FakeReader(() => answer, MCP_READ_TOOL);
    w = world({ readers: { mcp: r1 } });
    const { id, dir } = await activeMetricsWorkflow(w);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["99", "1", "1", "1"]]));
    answer = JSON.stringify({ results: [], next: null });
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/nothing new at PostHog/);
    expect(r.body.message).not.toMatch(/items\.csv/);
    expect(w.composioReader.calls).toBe(0);
  });

  test("LIVE: every row incomplete is a read with skipped rows (named), not a fall back to items.csv", async () => {
    let answer = JSON.stringify({ results: [{ week: "43", signups: "352", active_users: "2410", churn: "3" }] });
    const r1 = new FakeReader(() => answer, MCP_READ_TOOL);
    w = world({ readers: { mcp: r1 } });
    const { id, dir } = await activeMetricsWorkflow(w);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["99", "1", "1", "1"]]));
    answer = JSON.stringify({ results: [{ week: "44", signups: null, active_users: "2455", churn: "2" }] });
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/1 row at PostHog was skipped: Signups/);
    expect(r.body.message).not.toMatch(/items\.csv/);
    const dry = await w.call(`/workflows/${id}/dry-run`, "POST", { limit: 1 });
    expect(dry.body.read).toMatchObject({ status: "fetched", rowsTotal: 0, skipped: [{ missing: ["Signups"] }] });
  });

  test("FETCH: a report nested under a matching top level is refused for that method; Composio then reads", async () => {
    const nested = new FakeReader(() => JSON.stringify({ report: "Weekly metrics", data: { report: "Other report", week: "44", signups: "1", active_users: "2", churn: "3" } }), MCP_READ_TOOL);
    w = world({ readers: { mcp: nested } });
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source.via).toBe("composio");
    const mcp = w.brain.chain.peek(SOURCE_TARGET)!.methods.find((m) => m.method === "mcp")!;
    expect(mcp.lastError).toMatch(/Other report/);
  });
});
