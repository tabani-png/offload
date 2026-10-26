// s27 review round 3 (PR #35): real answers come in envelopes (data.results, items, data.rows, columns + rows,
// camelCase keys, more pages), and a direct read's learned arguments fill its path ({report}) before the query string.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readValues } from "../../src/plan/read-source.ts";
import { activeMetricsWorkflow, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const F = [
  { label: "Signups", sourceLabel: "Signups" },
  { label: "Active", sourceLabel: "Active users" },
];
const ONE: Array<Array<[string, string]>> = [[["Signups", "352"], ["Active", "2410"]]];

describe("s27 round 3: reading real answers", () => {
  test("FETCH: nested envelopes are walked to the rows: data.results, items, data.rows, a single object", () => {
    expect(readValues(JSON.stringify({ data: { results: [{ signups: 352, active_users: 2410 }] } }), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify({ items: [{ signups: 352, active_users: 2410 }], total: 1 }), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify({ data: { rows: [{ signups: "352", active_users: "2410" }] } }), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify({ result: { signups: 352, active_users: 2410 } }), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify({ a: { b: { c: { d: [{ signups: 352, active_users: 2410 }] } } } }), F).rows).toEqual(ONE);
  });

  test("FETCH: with several lists the one whose keys match the fields wins, the same way every time", () => {
    const answer = { meta: { tags: [{ name: "x" }, { name: "y" }] }, data: { results: [{ signups: 352, active_users: 2410 }] }, other: [{ signups: 1 }] };
    expect(readValues(JSON.stringify(answer), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify(answer), F)).toEqual(readValues(JSON.stringify(answer), F));
  });

  test("FETCH: camelCase keys, numbers as strings, columns + rows tables; a null is missing, never a value", () => {
    expect(readValues(JSON.stringify([{ signups: "352", activeUsers: 2410 }]), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify({ columns: ["signups", "active_users"], rows: [[352, 2410]] }), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify({ results: { columns: [{ name: "Signups" }, { name: "Active users" }], data: [["352", "2410"]] } }), F).rows).toEqual(ONE);
    expect(readValues(JSON.stringify([{ signups: null, active_users: 2410 }]), F)).toEqual({ rows: [], missing: ["Signups"] });
  });

  test("FETCH: an answer that says there are more pages is flagged, so a run never claims nothing is new from page one alone", () => {
    expect(readValues(JSON.stringify({ results: [{ signups: 352, active_users: 2410 }], next: "https://us.posthog.com/api/x?page=2" }), F).more).toBe(true);
    expect(readValues(JSON.stringify({ data: [{ signups: 352, active_users: 2410 }], has_more: true }), F).more).toBe(true);
    expect(readValues(JSON.stringify({ results: [{ signups: 352, active_users: 2410 }], next: null }), F).more).toBeUndefined();
  });

  test("FETCH: a direct read fills {report} in its path from the learned query and sends only the other arguments as the query string", async () => {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.includes("/health")) return new Response("{}", { status: 200 });
      if (url.includes("/api/reports/")) return new Response(JSON.stringify({ data: { results: [{ week: "43", signups: "352", active_users: "2410", churn: "3" }] } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    w = world({ mcp: "none", composio: "none", apiFetch: fetch });
    const spec = join(w.home, "openapi.json");
    writeFileSync(spec, JSON.stringify({ openapi: "3.0.0", paths: { "/api/reports/{report}": { get: { operationId: "reports.get" } } } }));
    writeFileSync(join(w.home, "connectors.json"), JSON.stringify({ version: 1, servers: {}, apis: { [SOURCE_TARGET]: { baseUrl: "https://us.posthog.com", health: { method: "GET", path: "/health" }, operations: {}, openapi: spec } } }));
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source).toMatchObject({ kind: "read", via: "api" });
    const u = new URL(calls.find((c) => c.includes("/api/reports/"))!);
    expect(u.pathname).toBe("/api/reports/Weekly%20metrics");
    expect(u.searchParams.has("report")).toBe(false);
    expect(u.searchParams.get("period")).toBe("last 7 days");
  });

  test("FETCH: a path argument Offload did not learn is a plain refusal of that way (no empty path segment), and the chain moves on", async () => {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    };
    w = world({ mcp: "none", composio: "none", apiFetch: fetch });
    const spec = join(w.home, "openapi.json");
    writeFileSync(spec, JSON.stringify({ openapi: "3.0.0", paths: { "/api/insights/{insight_id}": { get: { operationId: "insights.get" } } } }));
    writeFileSync(join(w.home, "connectors.json"), JSON.stringify({ version: 1, servers: {}, apis: { [SOURCE_TARGET]: { baseUrl: "https://us.posthog.com", health: { method: "GET", path: "/health" }, operations: {}, openapi: spec } } }));
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source.via).toBe("computer");
    expect(calls.some((c) => c.includes("/api/insights"))).toBe(false);
    const api = w.brain.chain.peek(SOURCE_TARGET)!.methods.find((m) => m.method === "api")!;
    expect(api.lastError).toMatch(/insight_id/);
  });
});
