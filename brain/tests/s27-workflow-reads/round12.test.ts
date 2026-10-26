// s27 review round 12 (PR #35).
// 1. A configured direct read keeps its `map`: fixed arguments (ids, scope) from connectors.json are sent, read
//    through the same mapping code as sends (api.ts mapArgs). Rule: configured fixed values win on every clash; the
//    learned query (report, fields, filters) fills only the arguments the configuration does not pin.
// 2. An MCP read that answers with structuredContent reaches the parser: structuredContent alone is used (re-serialized,
//    with a note that its number formatting comes from the connector software); with both, the text wins when it reads
//    as rows, else structuredContent.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readValueParts } from "../../src/plan/read-source.ts";
import { mcpAnswer } from "../../src/workflows/read-fetch.ts";
import { activeMetricsWorkflow, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const ROW = { week: "43", signups: "352", active_users: "2410", churn: "3" };

function apiWorld(map: Record<string, string>): { calls: string[]; setup: () => Promise<{ id: string }> } {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("/health")) return new Response("{}", { status: 200 });
    if (url.includes("/api/projects/")) return new Response(JSON.stringify({ results: [ROW] }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  w = world({ mcp: "none", composio: "none", apiFetch: fetch });
  const home = w.home;
  writeFileSync(
    join(home, "connectors.json"),
    JSON.stringify({
      version: 1,
      servers: {},
      apis: {
        [SOURCE_TARGET]: {
          baseUrl: "https://us.posthog.com",
          health: { method: "GET", path: "/health" },
          operations: { "metrics.read": { operationId: "insights.get", method: "GET", path: "/api/projects/{project_id}/insights/{report}", role: "read", fields: { project_id: "id", team: "id", report: "text" }, map } },
        },
      },
    }),
  );
  return { calls, setup: () => activeMetricsWorkflow(w!) };
}

describe("s27 round 12: configured direct reads keep their map", () => {
  test("FETCH: a path argument and a query argument that come only from the configuration are sent; the learned query fills the rest", async () => {
    const t = apiWorld({ project_id: "7", team: "growth" });
    const { id } = await t.setup();
    const r = await w!.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source.via).toBe("api");
    const u = new URL(t.calls.find((c) => c.includes("/api/projects/"))!);
    expect(u.pathname).toBe("/api/projects/7/insights/Weekly%20metrics");
    expect(u.searchParams.get("team")).toBe("growth");
    expect(u.searchParams.get("period")).toBe("last 7 days");
    expect(u.searchParams.has("project_id")).toBe(false);
  });

  test("FETCH: a value the configuration pins wins over the learned one", async () => {
    const t = apiWorld({ project_id: "7", report: "Pinned report" });
    const { id } = await t.setup();
    await w!.call(`/workflows/${id}/dry-run`, "POST", { limit: 1 });
    const u = new URL(t.calls.find((c) => c.includes("/api/projects/"))!);
    expect(u.pathname).toBe("/api/projects/7/insights/Pinned%20report");
  });
});

describe("s27 round 12: MCP structuredContent (round 14: as parts of one answer)", () => {
  const fields = [
    { label: "Signups", sourceLabel: "Signups" },
    { label: "Active", sourceLabel: "Active users" },
  ];
  const read = (r: { content?: unknown; structuredContent?: unknown }) => readValueParts(mcpAnswer(r).parts, fields);
  test("FETCH: structuredContent alone reaches the parser, with a note that its number formatting comes from the connector software", () => {
    const a = mcpAnswer({ content: [], structuredContent: { results: [{ signups: 352, active_users: 2410 }] } });
    expect(a.note).toMatch(/number formatting/);
    expect(read({ content: [], structuredContent: { results: [{ signups: 352, active_users: 2410 }] } })).toEqual({ kind: "ok", rows: [[["Signups", "352"], ["Active", "2410"]]], skipped: [] });
  });
  test("FETCH: with both, text that reads as rows wins (exact), else structuredContent is used", () => {
    expect(read({ content: [{ type: "text", text: '{"results": [{"signups": 25.50, "active_users": 1}]}' }], structuredContent: { results: [{ signups: 25.5, active_users: 1 }] } })).toEqual({ kind: "ok", rows: [[["Signups", "25.50"], ["Active", "1"]]], skipped: [] });
    expect(read({ content: [{ type: "text", text: "Here are the weekly metrics you asked for." }], structuredContent: { results: [{ signups: 352, active_users: 2410 }] } })).toEqual({ kind: "ok", rows: [[["Signups", "352"], ["Active", "2410"]]], skipped: [] });
  });
  test("FETCH: text only is used as is; resource text too; nothing at all reads as nothing", () => {
    expect(mcpAnswer({ content: [{ type: "text", text: "Signups: 1\nActive users: 2" }] })).toEqual({ parts: [{ kind: "text", text: "Signups: 1\nActive users: 2" }] });
    expect(mcpAnswer({ content: [{ type: "image", data: "x" }] })).toEqual({ parts: [] });
    expect(read({ content: [{ type: "resource", resource: { uri: "x://r", text: "Signups: 1\nActive users: 2" } }] })).toEqual({ kind: "ok", rows: [[["Signups", "1"], ["Active", "2"]]], skipped: [] });
  });
});
