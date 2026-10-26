// PR #9 Codex review of 9c2c93b: below the company the nightly check must never correct the evidence. A department or
// job-role snapshot that no longer matches (its stored report, or its rows changed outside ingest) gets an alert, keeps
// the stored report and stays non-final until new data through ingest replaces it, as the company's does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import metrics from "../../src/modules/metrics/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { populate, setup, type S205 } from "./helpers.ts";

let s: S205;
let owner: Client;
let finance: Awaited<ReturnType<typeof populate>>;
const nightly = () => metrics.jobs!.find((j) => j.name === "metrics.nightly_recompute")!.run(s.h.deps);
const Q = "from=2026-10-01&to=2026-11-01";
const snap = async (key: string) =>
  (await s.h.db.migrator`select final, report from metric_snapshots where tenant_id = ${s.h.a.id} and month = '2026-10'
    and scope_key = ${key}`)[0] as { final: boolean; report: { total: { seconds: number } } };
const alerts = async (key: string) =>
  (await s.h.db.migrator`select code from metric_alerts where tenant_id = ${s.h.a.id} and scope_key = ${key}`).length;

beforeAll(async () => {
  s = await setup();
  // Sales 5 and Finance 5: both visible.
  await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
  finance = await populate(s, s.h.a, { departmentId: s.h.a.departments.finance, size: 5 });
  owner = await asPrincipal(s.h, "owner");
  await nightly();
  await nightly();
});
afterAll(() => s.close());

describe("RECOMPUTE below the company: a mismatch is an alert, never a silent correction", () => {
  test("RECOMPUTE: setup: Sales and Finance are visible and final", async () => {
    for (const d of [s.h.a.departments.sales, s.h.a.departments.finance]) {
      const r = await owner.get(`/v1/metrics/hours-saved?scope=department:${d}&${Q}`);
      expect(r.json.total.people).toBe(5);
      expect(r.json.final).toBe(true);
    }
  });

  test("RECOMPUTE: a stored department report that no longer matches stays stored, alerted and non-final, night after night", async () => {
    const key = `department:${s.h.a.departments.sales}`;
    await s.h.db.migrator`update metric_snapshots set report = jsonb_set(report, '{total,seconds}', to_jsonb((report->'total'->>'seconds')::int + 1))
      where tenant_id = ${s.h.a.id} and month = '2026-10' and scope_key = ${key}`;
    const tampered = (await snap(key)).report.total.seconds;
    await nightly();
    expect(await alerts(key)).toBe(1);
    expect((await snap(key)).final).toBe(false);
    expect((await snap(key)).report.total.seconds).toBe(tampered);
    await nightly();
    expect((await snap(key)).final).toBe(false);
    expect((await snap(key)).report.total.seconds).toBe(tampered);
    expect((await owner.get(`/v1/metrics/hours-saved?scope=${key}&${Q}`)).json.final).toBe(false);
  });

  test("RECOMPUTE: a department's rows changed outside ingest are an alert for that department, and it stays non-final", async () => {
    const key = `department:${s.h.a.departments.finance}`;
    await s.h.db.migrator`update review_events set review_seconds = review_seconds + 7 where person_id = ${finance[0]!.personId}`;
    await nightly();
    expect(await alerts(key)).toBe(1);
    expect((await snap(key)).final).toBe(false);
    await nightly();
    expect((await snap(key)).final).toBe(false);
    expect((await owner.get(`/v1/metrics/hours-saved?scope=${key}&${Q}`)).json.final).toBe(false);
  });
});
