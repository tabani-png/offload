// S2-05 follow-up: a person changing department is a hierarchy change, not a data edit: no recompute_mismatch. Rows
// edited outside ingest still are (recompute-scope.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import metrics from "../../src/modules/metrics/index.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { populate, setup, type S205 } from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";

describe("RECOMPUTE a person changing department is no tamper", () => {
  let s: S205;
  let owner: Client;
  let sales: Awaited<ReturnType<typeof populate>>;
  const nightly = () => metrics.jobs!.find((j) => j.name === "metrics.nightly_recompute")!.run(s.h.deps);
  const alerts = async () => (await s.h.db.migrator`select scope_key from metric_alerts where tenant_id = ${s.h.a.id}`) as unknown[];

  beforeAll(async () => {
    s = await setup();
    sales = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 6 });
    await populate(s, s.h.a, { departmentId: s.h.a.departments.finance, size: 5 });
    owner = await asPrincipal(s.h, "owner");
    await nightly();
    await nightly();
  }, 60_000);
  afterAll(() => s.close());

  test("RECOMPUTE: moving a Sales person to Finance raises no mismatch; the next run is final again", async () => {
    const dept = (d: string) => `/v1/metrics/hours-saved?scope=department:${d}&${Q}`;
    expect((await owner.get(dept(s.h.a.departments.sales))).json.final).toBe(true);
    await s.h.db.migrator`update people set department_id = ${s.h.a.departments.finance} where id = ${sales[0]!.personId}`;
    await nightly();
    expect(await alerts()).toEqual([]);
    await nightly();
    expect(await alerts()).toEqual([]);
    const fin = await owner.get(dept(s.h.a.departments.finance));
    expect(fin.json.total.people).toBe(6);
    expect(fin.json.final).toBe(true);
    expect((await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`)).json.final).toBe(true);
  }, 60_000);
});
