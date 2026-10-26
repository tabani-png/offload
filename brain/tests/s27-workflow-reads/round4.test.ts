// s27 review round 4 (PR #35): a read only claims what it can confirm. The screen read accepts values only when the
// learned report and period are on screen (it never navigates or changes a filter); a connector answer that names
// another report or period is refused. Rows with a missing value are SKIPPED, said plainly, and never counted done.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readValues } from "../../src/plan/read-source.ts";
import { activeMetricsWorkflow, FakeReader, MCP_READ_TOOL, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

/** Test view of the explicit outcome (round 6): fields of whichever kind it is. */
const rv = (...a: Parameters<typeof readValues>): any => readValues(...a);

describe("s27 round 4: confirm the context, keep incomplete rows visible", () => {
  test("FETCH: the screen read with everything matching (report, period, labels) is accepted", async () => {
    w = world({ mcp: "none", composio: "none" });
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source.via).toBe("computer");
  });

  test("FETCH: the screen shows the same labels for another report: refused with the reason, nothing clicked, no row", async () => {
    w = world({ mcp: "none", composio: "none" });
    const { id } = await activeMetricsWorkflow(w);
    w.driver.dash = { ...w.driver.dash, report: "Monthly metrics", week: "44" };
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/could not confirm the 'Weekly metrics' report for last 7 days on screen/);
    expect(w.driver.touches()).toBe(0);
  });

  test("FETCH: the screen shows another period (last 30 days): refused, never a filter change", async () => {
    w = world({ mcp: "none", composio: "none" });
    const { id } = await activeMetricsWorkflow(w);
    w.driver.dash = { ...w.driver.dash, period: "Last 30 days", week: "44" };
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/could not confirm/);
    expect(w.driver.touches()).toBe(0);
  });

  test("FETCH: a connector answer that names another period than the one learned is refused and the chain moves on", async () => {
    const wrong = new FakeReader(() => JSON.stringify({ report: "Weekly metrics", period: "last 30 days", week: "44", signups: "1", active_users: "2", churn: "3" }), MCP_READ_TOOL);
    w = world({ readers: { mcp: wrong } });
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source.via).toBe("composio");
    const mcp = w.brain.chain.peek(SOURCE_TARGET)!.methods.find((m) => m.method === "mcp")!;
    expect(mcp.lastError).toMatch(/last 30 days/);
  });

  test("LIVE: a row with a missing value is skipped (named), the others go ahead; it is never counted done; nothing new says so", async () => {
    const two = new FakeReader(() => JSON.stringify({ results: [{ week: "43", signups: "352", active_users: "2410", churn: "3" }, { week: "44", signups: null, active_users: "2455", churn: "2" }] }), MCP_READ_TOOL);
    w = world({ readers: { mcp: two } });
    const { id, dir, dry } = await activeMetricsWorkflow(w);
    expect(dry.read.skipped).toEqual([{ missing: ["Signups"] }]);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.source.skipped).toEqual([{ missing: ["Signups"] }]);
    expect(r.body.source.message).toMatch(/1 row .*skipped.*Signups/);
    for (const i of r.body.items) expect(i.warnings.join(" ")).toMatch(/skipped.*Signups/);
    await w.call(`/workflows/${id}/approve`, "POST", { batchHash: r.body.batch.hash });
    await w.brain.idle();
    const done = readFileSync(join(dir, "done-log.csv"), "utf8").trim().split("\n");
    expect(done.length).toBe(2);
    const again = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/nothing new/);
    expect(again.body.message).toMatch(/1 row .*skipped.*Signups/);
  });

  test("FETCH: rows with a missing or oversized value are reported as skipped next to the complete ones", () => {
    const F = [
      { label: "Signups", sourceLabel: "Signups" },
      { label: "Active", sourceLabel: "Active users" },
    ];
    const r = rv(JSON.stringify([{ signups: 352, active_users: 2410 }, { signups: null, active_users: 1 }, { signups: "x".repeat(500), active_users: 2 }]), F);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toEqual([{ missing: ["Signups"] }, { missing: ["Signups"] }]);
  });
});
