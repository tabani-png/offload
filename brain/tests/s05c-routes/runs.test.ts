// s05c: lastRunAt (newest live batch) and nextRunAt (next due time of the cron schedule while active) on dashboard
// automations and workflow summaries.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApproveResponse, DashboardResponse, DryRunResponse, RunResponse, WorkflowsResponse } from "../../src/api/types.ts";
import { nextCronRun, parseCron } from "../../src/workflows/schedule.ts";
import { updateWorkflow } from "../../src/workflows/store.ts";
import { NOW, writeRecipients } from "../s05-workflows/setup.ts";
import { routeWorld, type RouteWorld } from "./setup.ts";

let w: RouteWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("s05c schedule: cron next run", () => {
  test("RUNS: weekdays at 09:00 from Friday 10:00 is Monday 09:00 local; from Monday 08:59 it is the same day", () => {
    expect(nextCronRun("0 9 * * 1-5", local(2026, 10, 23, 10))).toBe(local(2026, 10, 26, 9));
    expect(nextCronRun("0 9 * * 1-5", local(2026, 10, 19, 8, 59))).toBe(local(2026, 10, 19, 9));
    // Exactly at the due minute: the next one, never now.
    expect(nextCronRun("0 9 * * 1-5", local(2026, 10, 19, 9))).toBe(local(2026, 10, 20, 9));
  });

  test("RUNS: lists, ranges, steps, month and day-of-month OR day-of-week, 7 = Sunday", () => {
    expect(nextCronRun("*/15 * * * *", local(2026, 10, 19, 9, 7))).toBe(local(2026, 10, 19, 9, 15));
    expect(nextCronRun("30 8,17 * * *", local(2026, 10, 19, 9))).toBe(local(2026, 10, 19, 17, 30));
    expect(nextCronRun("0 0 1 1 *", local(2026, 10, 19))).toBe(local(2027, 1, 1));
    expect(nextCronRun("0 12 * * 7", local(2026, 10, 19))).toBe(local(2026, 10, 25, 12));
    // dom and dow both restricted: either matches (Vixie cron).
    expect(nextCronRun("0 6 1 * 3", local(2026, 10, 19))).toBe(local(2026, 10, 21, 6));
  });

  test("RUNS: malformed cron expressions parse to null and have no next run", () => {
    for (const e of ["", "0 9 * *", "60 * * * *", "0 24 * * *", "0 9 * * 8", "a b c d e", "0 9 31-1 * *", "*/0 * * * *"]) {
      expect(parseCron(e)).toBeNull();
      expect(nextCronRun(e, NOW)).toBeNull();
    }
    // A date that never comes (Feb 30) gives up instead of looping.
    expect(nextCronRun("0 0 30 2 *", NOW)).toBeNull();
  });
});

describe("s05c dashboard: lastRunAt / nextRunAt", () => {
  test("RUNS: null before activation; nextRunAt once active; lastRunAt = the live batch's createdAt; null again when paused", async () => {
    w = await routeWorld();
    const id = w.outreach.id;
    const auto = async () => (await w!.call<DashboardResponse>("/dashboard")).body.automations.find((a) => a.id === id)!;
    const summary = async () => (await w!.call<WorkflowsResponse>("/workflows")).body.workflows.find((x) => x.id === id)!;
    expect(await auto()).toMatchObject({ lastRunAt: null, nextRunAt: null });
    expect(await summary()).toMatchObject({ lastRunAt: null, nextRunAt: null });

    const dry = await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 2 } });
    expect(dry.status).toBe(200);
    expect((await w.call<ApproveResponse>(`/workflows/${id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } })).body.result).toBe("activated");
    const due = nextCronRun("0 9 * * 1-5", NOW);
    expect(due).not.toBeNull();
    const d = new Date(due!);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 0]);
    expect(d.getDay()).toBeGreaterThanOrEqual(1);
    expect(d.getDay()).toBeLessThanOrEqual(5);
    expect(due!).toBeGreaterThan(NOW);
    expect(await auto()).toMatchObject({ lastRunAt: null, nextRunAt: due });

    writeRecipients(w.home, id, ["ana@fund.vc,Ana,Lee,Fund VC,"]);
    const run = await w.call<RunResponse>(`/workflows/${id}/run`, { method: "POST" });
    expect(run.status).toBe(201);
    // The pending batch makes it needs_you; the schedule still says when the next batch is due.
    expect(await auto()).toMatchObject({ state: "needs_you", lastRunAt: run.body.batch.createdAt, nextRunAt: due });
    expect(await summary()).toMatchObject({ lastRunAt: run.body.batch.createdAt, nextRunAt: due });

    expect((await w.call(`/workflows/${id}/pause`, { method: "POST" })).status).toBe(200);
    expect(await auto()).toMatchObject({ state: "paused", lastRunAt: run.body.batch.createdAt, nextRunAt: null });
  });

  test("RUNS: a manual schedule has no nextRunAt even when active", async () => {
    w = await routeWorld();
    updateWorkflow(w.home, w.outreach.id, (x) => {
      x.status = "active";
      x.activatedAt = NOW;
      x.schedule = { type: "manual" };
    }, NOW);
    expect((await w.call<DashboardResponse>("/dashboard")).body.automations[0]).toMatchObject({ nextRunAt: null, lastRunAt: null });
  });
});
