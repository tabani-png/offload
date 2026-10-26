// s27: items.csv stays only as the fallback, and the run says plainly which one it used. No source seen in the
// recordings: the person's list, with a plain message. A source that cannot be read: the list, with a warning on every
// item; and then reading time is not counted as saved.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkflow } from "../../src/workflows/store.ts";
import { activeMetricsWorkflow, itemsCsv, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

describe("s27 fallback to the person's list", () => {
  test("LIVE: no source in the recordings (plain neutral week): no read step, the run uses items.csv and says why in plain words", async () => {
    w = world();
    const { id, dir, dry } = await activeMetricsWorkflow(w, { dashboard: false });
    const wf = readWorkflow(w.home, id)!;
    expect(wf.read).toBeUndefined();
    expect(wf.steps.some((s) => s.id === "read_source")).toBe(false);
    expect(dry.read).toMatchObject({ status: "none" });
    expect(dry.read.message).toMatch(/has not seen where/);
    const empty = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(empty.status).toBe(409);
    expect(empty.body.message).toMatch(/items\.csv/);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source).toMatchObject({ kind: "list", name: "items.csv", via: null });
    expect(r.body.source.message).toMatch(/has not seen where these values come from/);
    expect(r.body.source.message).not.toMatch(/\b(mcp|token|gate|api key)\b/i);
    expect(w.mcpReader.calls + w.composioReader.calls).toBe(0);
  });

  test("LIVE: a source that cannot be read through any way falls back to items.csv; every item says so; without a list the run stops with both reasons", async () => {
    w = world({ readers: { computer: { read: async () => Promise.reject(new Error("the window did not open")) } } });
    w.mcpReader.fail = "the connector stopped";
    w.composioReader.fail = "Composio did not answer";
    const { id, dir } = await activeMetricsWorkflow(w);
    const none = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(none.status).toBe(409);
    expect(none.body.message).toMatch(/could not read PostHog/i);
    expect(none.body.message).toMatch(/items\.csv/);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    expect(r.body.source).toMatchObject({ kind: "list", name: "items.csv", via: null });
    expect(r.body.source.message).toMatch(/could not read PostHog/i);
    for (const i of r.body.items) expect(i.warnings.join(" ")).toMatch(/PostHog/);
  });

  test("DRYRUN: when the read is not automated the reading time is not counted as saved", async () => {
    w = world({ mcp: "none", composio: "none", readers: { computer: { read: async () => Promise.reject(new Error("no screen access")) } } });
    const { dry } = await activeMetricsWorkflow(w);
    expect(dry.read.status).toBe("not_read");
    for (const i of dry.general.instances) {
      expect(i.estimate.readCounted).toBe(false);
      expect(i.estimate.readMinutes).toBeGreaterThan(0);
      expect(i.estimate.savedMinutes).toBeCloseTo(Math.max(0, i.estimate.observedMinutes - i.estimate.reviewSeconds / 60), 0);
    }
    expect(dry.totals.arithmetic).toMatch(/reading PostHog stays with you/);
  });

  test("METRIC: when the read is not automated the dashboard estimate adds nothing for reading", async () => {
    w = world({ mcp: "none", composio: "none", readers: { computer: { read: async () => Promise.reject(new Error("no screen access")) } } });
    const { id } = await activeMetricsWorkflow(w);
    const wf = readWorkflow(w.home, id)!;
    const a = (await w.call("/dashboard")).body.automations.find((x: any) => x.workflowId === id);
    expect(a.estimatedHoursSavedPerWeek).toBe(wf.estimate.weeklyHoursSaved);
    expect(a.arithmetic).not.toMatch(/reading/);
  });
});
