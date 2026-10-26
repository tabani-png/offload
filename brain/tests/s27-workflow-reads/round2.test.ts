// s27 review round 2 (PR #35): a pause during a DRY RUN's read stops it like a live run's (no further method, no
// screen opened); a direct connection whose read operations come only from its OpenAPI file reads through them,
// resolved by the same code the probe uses.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceReader } from "../../src/workflows/read-fetch.ts";
import { activeMetricsWorkflow, dashJson, MCP_READ_TOOL, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

describe("s27 round 2", () => {
  test("FETCH: a pause during a dry run's read stops the dry run: no Composio, no screen, the connector not blamed", async () => {
    let wid = "";
    let world0: World | null = null;
    let armed = false;
    const pausing: SourceReader = {
      async read(job) {
        if (!armed || world0 === null) return job.call(MCP_READ_TOOL, job.args, async () => dashJson(world0!.driver.dash));
        await world0.call(`/workflows/${wid}/pause`, "POST", {});
        throw new Error("the connector stopped");
      },
    };
    w = world({ readers: { mcp: pausing } });
    world0 = w;
    const { id } = await activeMetricsWorkflow(w);
    wid = id;
    armed = true;
    const opened = w.driver.opened.length;
    const composio = w.composioReader.calls;
    const r = await w.call(`/workflows/${id}/dry-run`, "POST", { limit: 1 });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/paused/);
    expect(w.composioReader.calls).toBe(composio);
    expect(w.driver.opened.slice(opened)).not.toContain(SOURCE_TARGET);
    expect(w.driver.touches()).toBe(0);
    const mcp = w.brain.chain.peek(SOURCE_TARGET)!.methods.find((m) => m.method === "mcp")!;
    expect(mcp.lastError ?? "").not.toMatch(/connector stopped/);
  });

  test("FETCH: a direct connection whose read comes only from its OpenAPI file reads through it (with the learned query), end to end", async () => {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes("/health")) return new Response("{}", { status: 200 });
      if (url.includes("/api/insights/weekly")) return new Response(JSON.stringify({ week: "43", signups: "352", active_users: "2410", churn: "3" }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    w = world({ mcp: "none", composio: "none", apiFetch: fetch });
    const spec = join(w.home, "posthog-openapi.json");
    writeFileSync(spec, JSON.stringify({ openapi: "3.0.0", paths: { "/api/insights/weekly": { get: { operationId: "insights.weekly" } }, "/api/insights": { post: { operationId: "insights.create" } } } }));
    writeFileSync(join(w.home, "connectors.json"), JSON.stringify({ version: 1, servers: {}, apis: { [SOURCE_TARGET]: { baseUrl: "https://us.posthog.com", health: { method: "GET", path: "/health" }, operations: {}, openapi: spec } } }));
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source).toMatchObject({ kind: "read", via: "api" });
    const read = calls.find((u) => u.includes("/api/insights/weekly"))!;
    expect(read).toBeDefined();
    const q = new URL(read).searchParams;
    expect(q.get("report")).toBe("Weekly metrics");
    expect(q.get("period")).toBe("last 7 days");
    expect(w.driver.opened).not.toContain(SOURCE_TARGET);
  });
});
