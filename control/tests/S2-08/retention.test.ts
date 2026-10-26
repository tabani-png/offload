import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import { withTenant } from "../../src/db/tenant.ts";
import compliance from "../../src/modules/compliance/index.ts";
import { RETENTION_TABLES, runRetention } from "../../src/modules/compliance/retention.ts";
import { DAY_MS, INGEST_TABLES, publishNotice, seedIngest, signIn, type Who } from "./fixtures.ts";

// Runs against S2-05's real per-person tables (migration 0501). On the S2-08 branch alone they do not exist, and only
// the fail-closed test at the end applies: a pass with a listed table missing is an error, never a silent skip.
let h: Harness;
let who: Who;

const dayAgo = (n: number) => new Date(h.clock.now() - n * DAY_MS).toISOString().slice(0, 10);

/** Ages, in days, of the rows seeded per tenant. Retention defaults: 90 days per person, 30 days working time. */
const AGES = { runs: [120, 10], reviews: [100, 10], baselines: [100, 10], daily: [100, 91, 89, 10], workingTime: [40, 31, 29, 10] };
const PAST = {
  run_outcomes: 1,
  review_events: 1,
  baseline_sample_instances: 2,
  baseline_samples: 1,
  daily_aggregate_workflows: 2,
  daily_aggregates: 2,
  working_time_aggregates: 2,
};

const count = async (table: string, tenantId: string) =>
  Number((await h.db.migrator.unsafe(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId]))[0].n);

async function seedTenant(tenant: Harness["a"]) {
  const dev = await enrollDevice(h, await asPrincipal(h, "member", tenant));
  await seedIngest(h, tenant.id, tenant.people.member.id, dev.deviceId, h.clock.now(), AGES);
  await h.db.migrator`insert into metric_snapshots (tenant_id, month, scope_type, scope_id, inputs_digest, report, computed_at)
    values (${tenant.id}, '2024-01', 'company', null, ${"c".repeat(64)}, '{}'::jsonb, now()),
           (${tenant.id}, '2026-09', 'company', null, ${"d".repeat(64)}, '{}'::jsonb, now())`;
}

beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  if (INGEST_TABLES) {
    await seedTenant(h.a);
    await seedTenant(h.b);
  }
});
afterAll(() => h.close());

describe("RETENTION", () => {
  test("RETENTION: the job prunes exactly S2-05's seven per-person tables, children before their parents", () => {
    expect(RETENTION_TABLES.map((t) => t.table)).toEqual(Object.keys(PAST));
    expect(RETENTION_TABLES.find((t) => t.table === "working_time_aggregates")!.kind).toBe("working_time");
    expect(RETENTION_TABLES.filter((t) => t.kind === "working_time").length).toBe(1);
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: per-person rows past 90 days and working time past 30 days are deleted from the real tables; recent rows stay", async () => {
    const run = await runRetention(h.deps, h.a.id);
    expect(run.deleted).toEqual(PAST);
    expect(await count("run_outcomes", h.a.id)).toBe(1);
    expect(await count("review_events", h.a.id)).toBe(1);
    expect(await count("baseline_samples", h.a.id)).toBe(1);
    expect(await count("baseline_sample_instances", h.a.id)).toBe(2);
    expect(await count("daily_aggregates", h.a.id)).toBe(2);
    expect(await count("daily_aggregate_workflows", h.a.id)).toBe(2);
    expect(await count("working_time_aggregates", h.a.id)).toBe(2);
    const [oldest] = await h.db.migrator`select to_char(min(day), 'YYYY-MM-DD') as d from daily_aggregates where tenant_id = ${h.a.id}`;
    expect(oldest!.d).toBe(dayAgo(89));
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: group aggregates (metric snapshots) are kept", async () => {
    expect(await count("metric_snapshots", h.a.id)).toBe(2);
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: each pass logs a retention_run with cut-off days and counts, and an audit event", async () => {
    const [r] = await h.db.migrator`select to_char(per_person_before, 'YYYY-MM-DD') as pp, to_char(working_time_before, 'YYYY-MM-DD') as wt,
        deleted, skipped from retention_runs where tenant_id = ${h.a.id} order by ran_at_ms desc limit 1`;
    expect(r!.pp).toBe(dayAgo(90));
    expect(r!.wt).toBe(dayAgo(30));
    expect(r!.deleted).toEqual(PAST);
    expect(r!.skipped).toEqual([]);
    const log = (await who.owner.get("/v1/audit-log?action=retention.run")).json.items;
    expect(log.length).toBe(1);
    expect(log[0].actor.type).toBe("system");
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: another tenant's rows are untouched by this tenant's pass", async () => {
    expect(await count("daily_aggregates", h.b.id)).toBe(4);
    expect(await count("working_time_aggregates", h.b.id)).toBe(4);
    expect(await count("run_outcomes", h.b.id)).toBe(2);
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: the app role itself still cannot delete S2-05 rows; only the retention pass can", async () => {
    for (const t of Object.keys(PAST)) {
      const err = await withTenant(h.db.app, { tenantId: h.b.id, accessRole: "system" }, async (tx) => {
        await tx`select set_config('app.person_read', 'on', true)`;
        return tx.unsafe(`delete from ${t}`);
      }).catch((e: unknown) => e);
      expect({ t, denied: err instanceof Error && /permission denied/.test(err.message) }).toEqual({ t, denied: true });
    }
    expect(await count("run_outcomes", h.b.id)).toBe(2);
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: the nightly job walks every tenant itself (Job.run(deps) carries no tenant)", async () => {
    const job = compliance.jobs!.find((j) => j.name === "compliance.retention")!;
    expect(job.schedule).toMatch(/^\S+ \S+ \* \* \*$/);
    await job.run(h.deps);
    expect(await count("daily_aggregates", h.b.id)).toBe(2);
    expect(await count("working_time_aggregates", h.b.id)).toBe(2);
    expect(await count("run_outcomes", h.b.id)).toBe(1);
    expect(await count("retention_runs", h.b.id)).toBe(1);
    expect(await count("retention_runs", h.a.id)).toBe(2);
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: a shorter tenant retention (configured downward) deletes more", async () => {
    await h.db.migrator`update tenants set retention_per_person_days = 7, retention_working_time_days = 7 where id = ${h.a.id}`;
    const run = await runRetention(h.deps, h.a.id);
    expect(run.deleted).toEqual(PAST);
    expect(await count("daily_aggregates", h.a.id)).toBe(0);
    expect(await count("run_outcomes", h.a.id)).toBe(0);
    expect(await count("metric_snapshots", h.a.id)).toBe(2);
  });

  test.skipIf(!INGEST_TABLES)("RETENTION: notices, acks and the audit log are never pruned by the per-person pass", async () => {
    const n = await publishNotice(who.owner);
    await who.member.post(`/v1/me/notices/${n.id}/ack`);
    const audits = await count("audit_events", h.a.id);
    h.clock.advance(400 * DAY_MS);
    await runRetention(h.deps, h.a.id);
    expect(await count("notice_acks", h.a.id)).toBe(1);
    expect(await count("notices", h.a.id)).toBe(1);
    expect(await count("audit_events", h.a.id)).toBe(audits + 1);
  });

  // Last: it drops a table from this file's schema.
  test("RETENTION: a listed table that is missing fails the pass for every tenant, deletes nothing and logs no run", async () => {
    await h.db.migrator.unsafe("drop table if exists working_time_aggregates");
    const runsBefore = await count("retention_runs", h.b.id);
    const rowsBefore = INGEST_TABLES ? await count("daily_aggregates", h.b.id) : 0;
    h.clock.advance(400 * DAY_MS);
    await expect(runRetention(h.deps, h.b.id)).rejects.toThrow(/working_time_aggregates/);
    const job = compliance.jobs!.find((j) => j.name === "compliance.retention")!;
    const err = (await job.run(h.deps).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(h.a.id);
    expect(err.message).toContain(h.b.id);
    expect(await count("retention_runs", h.b.id)).toBe(runsBefore);
    if (INGEST_TABLES) expect(await count("daily_aggregates", h.b.id)).toBe(rowsBefore);
  });
});
