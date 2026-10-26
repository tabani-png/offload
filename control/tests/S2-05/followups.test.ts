// S2-05 follow-ups (agent-control/followups-20261026.md #17):
// - a small_baseline anomaly is about one workflow version, so the people behind it are that version's runners;
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { WF2, at, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";

describe("FLOOR small_baseline is floored on the version's own runners", () => {
  let s: S205;
  let owner: Client;

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    // WF2 version 1: 5 Sales people with baselines. Version 2: one of them, no baseline (n = 0, under 3).
    const sales = await populate(s, t, { departmentId: t.departments.sales, size: 5, workflowId: WF2 });
    await populate(s, t, { departmentId: t.departments.finance, size: 5 });
    const run = runOutcome({ workflowId: WF2, version: 2, endedAt: at("2026-10-22", 10) });
    receipt(await sendObjects(s.h, sales[0]!.dev, [run, reviewEvent(run.runId, { at: at("2026-10-22", 11) })]));
    owner = await asPrincipal(s.h, "owner");
  }, 60_000);
  afterAll(() => s.close());

  test("FLOOR: a small_baseline for a version one person ran is not listed, though five ran the workflow", async () => {
    for (const scope of ["company", `department:${s.h.a.departments.sales}`]) {
      const r = await owner.get(`/v1/metrics/hours-saved?scope=${scope}&${Q}`);
      expect(r.status).toBe(200);
      const v2 = (r.json.anomalies as Array<{ code: string; detail: string }>).filter((a) => a.code === "small_baseline" && a.detail.startsWith("version 2"));
      expect(v2).toEqual([]);
    }
  });
});
