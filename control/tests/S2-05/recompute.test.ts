import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import metrics from "../../src/modules/metrics/index.ts";
import { at, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

let s: S205;
let owner: Client;
let people: Awaited<ReturnType<typeof populate>>;
const OCT = "/v1/metrics/hours-saved?scope=company&from=2026-10-01&to=2026-11-01";
const nightly = () => metrics.jobs!.find((j) => j.name === "metrics.nightly_recompute")!.run(s.h.deps);

const snapshots = async () =>
  (await s.h.db.migrator`select month, scope_key, final, stale, inputs_digest, report from metric_snapshots
    where tenant_id = ${s.h.a.id} order by month, scope_key`) as Array<{ month: string; scope_key: string; final: boolean; stale: boolean; inputs_digest: string; report: Record<string, unknown> }>;
const alerts = async () => (await s.h.db.migrator`select month, scope_key, code from metric_alerts where tenant_id = ${s.h.a.id} order by at`) as unknown[];

beforeAll(async () => {
  s = await setup();
  people = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, jobRoleId: s.h.a.jobRoles.sdr, size: 5 });
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("RECOMPUTE nightly equality check (ADR 0109 §11)", () => {
  test("RECOMPUTE: the module declares the nightly job", () => {
    const job = metrics.jobs!.find((j) => j.name === "metrics.nightly_recompute");
    expect(job?.schedule).toBe("30 2 * * *");
  });

  test("RECOMPUTE: the first run stores one snapshot per group scope for the last two months, not yet final", async () => {
    await nightly();
    const snaps = await snapshots();
    const scopes = ["company:", `department:${s.h.a.departments.finance}`, `department:${s.h.a.departments.sales}`,
      `job_role:${s.h.a.jobRoles.ap}`, `job_role:${s.h.a.jobRoles.sdr}`].sort();
    expect(snaps.map((x) => `${x.month} ${x.scope_key}`)).toEqual([...scopes.map((k) => `2026-09 ${k}`), ...scopes.map((k) => `2026-10 ${k}`)]);
    expect(snaps.every((x) => !x.final && !x.stale)).toBe(true);
    expect((await owner.get(OCT)).json.final).toBe(false);
  });

  test("RECOMPUTE: identical inputs on the next run make the month final, and the report says so", async () => {
    await nightly();
    expect((await snapshots()).every((x) => x.final)).toBe(true);
    const r = await owner.get(OCT);
    expect(r.json.final).toBe(true);
    expect(await alerts()).toEqual([]);
  });

  test("RECOMPUTE: the snapshot is the endpoint's report (same inputsDigest, same numbers)", async () => {
    const snap = (await snapshots()).find((x) => x.month === "2026-10" && x.scope_key === "company:")!;
    const r = await owner.get(OCT);
    expect(snap.inputs_digest).toBe(r.json.inputsDigest);
    expect({ ...snap.report, final: true }).toEqual(r.json);
  });

  test("RECOMPUTE: a period that is not one whole month is never final", async () => {
    expect((await owner.get("/v1/metrics/hours-saved?scope=company&from=2026-10-01&to=2026-10-31")).json.final).toBe(false);
  });

  test("RECOMPUTE: a row altered outside ingest is a mismatch alert, and the month loses its final badge", async () => {
    await s.h.db.migrator`update review_events set review_seconds = review_seconds + 7 where person_id = ${people[0]!.personId}`;
    await nightly();
    const a = await alerts();
    expect(a).toContainEqual({ month: "2026-10", scope_key: "company:", code: "recompute_mismatch" });
    expect(a).not.toContainEqual(expect.objectContaining({ month: "2026-09" }));
    expect((await snapshots()).find((x) => x.month === "2026-10" && x.scope_key === "company:")!.final).toBe(false);
    expect((await owner.get(OCT)).json.final).toBe(false);
    // Rerunning does not duplicate the alert for the same disagreement.
    const n = a.length;
    await nightly();
    expect((await alerts()).length).toBe(n);
  });

  test("RECOMPUTE: new data through ingest marks snapshots stale; the next run refreshes them without an alert", async () => {
    const before = (await alerts()).length;
    const run = runOutcome({ endedAt: at("2026-10-24") });
    receipt(await sendObjects(s.h, people[1]!.dev, [run, reviewEvent(run.runId)]));
    expect((await snapshots()).every((x) => x.stale)).toBe(true);
    await nightly();
    expect((await alerts()).length).toBe(before);
    expect((await snapshots()).every((x) => !x.stale && !x.final)).toBe(true);
    await nightly();
    expect((await owner.get(OCT)).json.final).toBe(true);
  });

  test("RECOMPUTE: the job walks every tenant, each in its own tenant context", async () => {
    const [n] = await s.h.db.migrator`select count(distinct tenant_id)::int as n from metric_snapshots`;
    expect(n!.n).toBe(2);
    const ownerB = await asPrincipal(s.h, "owner", s.h.b);
    expect((await ownerB.get(OCT)).json.total).toEqual({ suppressed: true, reason: "group_floor" });
  });
});
