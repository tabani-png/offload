import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import { asPrincipal } from "../helpers/harness.ts";
import { S205_TABLES, addDevice, addPerson, at, dailyAggregate, populate, reviewEvent, runOutcome, sendObjects, setup, workingTime, type S205 } from "./helpers.ts";
import nightly from "../../src/modules/metrics/index.ts";

const PERSON_TABLES = ["run_outcomes", "review_events", "baseline_samples", "baseline_sample_instances", "daily_aggregates",
  "daily_aggregate_workflows", "working_time_aggregates"];

let s: S205;
let people: Awaited<ReturnType<typeof populate>>;

const countAs = (tenantId: string, table: string, flags: { personRead?: boolean; aggregate?: boolean; personId?: string; of?: string } = {}) =>
  withTenant(s.h.db.app, { tenantId, principalPersonId: flags.personId ?? null }, async (tx) => {
    if (flags.personRead) await tx`select set_config('app.person_read', 'on', true)`;
    if (flags.aggregate) await tx`select set_config('app.aggregate_read', 'on', true)`;
    return (await tx.unsafe(`select count(*)::int as n from ${table}${flags.of ? " where tenant_id = $1" : ""}`, flags.of ? [flags.of] : []))[0].n as number;
  });

beforeAll(async () => {
  s = await setup();
  people = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
  // Every table gets a row in tenant A: daily and working-time aggregates, snapshots (nightly job), an alert, a dirty mark.
  s.fc.workingTime.add(people[0]!.personId);
  s.fc.features.set("CA-ON", ["working_time"]);
  await sendObjects(s.h, people[0]!.dev, [dailyAggregate(), workingTime()]);
  await nightly.jobs![0]!.run(s.h.deps);
  await s.h.db.migrator`update review_events set review_seconds = review_seconds + 1`;
  await nightly.jobs![0]!.run(s.h.deps);
  // New data after the last nightly run leaves a pending metric_dirty row.
  await sendObjects(s.h, people[1]!.dev, [reviewEvent(runOutcome({ endedAt: at("2026-10-22") }).runId)]);
});
afterAll(() => s.close());

describe("RLS on every S2-05 table", () => {
  test("RLS: every new table has RLS enabled and forced with the tenant_isolation policy", async () => {
    for (const t of S205_TABLES) {
      const [r] = await s.h.db.migrator`select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
          exists (select 1 from pg_policies p where p.schemaname = ${s.h.db.schema} and p.tablename = c.relname
            and p.policyname = 'tenant_isolation') as policy
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${s.h.db.schema} and c.relname = ${t}`;
      expect({ t, ...r }).toEqual({ t, rls: true, forced: true, policy: true });
    }
  });

  test("RLS: tenant A has rows in every new table (so the zero counts below mean isolation)", async () => {
    for (const t of S205_TABLES) {
      const n = (await s.h.db.migrator.unsafe(`select count(*)::int as n from ${t} where tenant_id = $1`, [s.h.a.id]))[0].n;
      expect({ t, some: n > 0 }).toEqual({ t, some: true });
    }
  });

  test("RLS: cross-tenant reads of every new table return nothing, even with person and aggregate reads on", async () => {
    for (const t of S205_TABLES) {
      expect({ t, n: await countAs(s.h.b.id, t, { personRead: true, aggregate: true, of: s.h.a.id }) }).toEqual({ t, n: 0 });
      // B sees only B's rows (its own snapshots from the nightly job), never A's.
      expect({ t, n: await countAs(s.h.b.id, t, { personRead: true, aggregate: true }) }).toEqual({ t, n: await countAs(s.h.b.id, t, { personRead: true, aggregate: true, of: s.h.b.id }) });
    }
  });

  test("RLS: a connection with no tenant reads nothing from the new tables", async () => {
    for (const t of S205_TABLES) expect({ t, n: (await s.h.db.app.unsafe(`select count(*)::int as n from ${t}`))[0].n }).toEqual({ t, n: 0 });
  });

  test("RLS: per-person tables carry a RESTRICTIVE person_visibility policy (ADR 0101 §5)", async () => {
    for (const t of PERSON_TABLES) {
      const [p] = await s.h.db.migrator`select permissive from pg_policies
        where schemaname = ${s.h.db.schema} and tablename = ${t} and policyname = 'person_visibility'`;
      expect({ t, permissive: p?.permissive }).toEqual({ t, permissive: "RESTRICTIVE" });
    }
  });

  test("RLS: inside the tenant, another person's rows are hidden unless a person or aggregate read is on", async () => {
    const me = people[0]!.personId;
    const mine = await countAs(s.h.a.id, "run_outcomes", { personId: me });
    const all = await countAs(s.h.a.id, "run_outcomes", { aggregate: true });
    expect(mine).toBe(2);
    expect(all).toBe(10);
    expect(await countAs(s.h.a.id, "run_outcomes", { personId: s.h.a.people.owner.id })).toBe(0);
    expect(await countAs(s.h.a.id, "run_outcomes", { personRead: true })).toBe(10);
    for (const t of PERSON_TABLES) expect({ t, n: await countAs(s.h.a.id, t) }).toEqual({ t, n: 0 });
  });

  test("RLS: a device cannot write rows for another person or another tenant (WITH CHECK)", async () => {
    const me = people[0]!;
    const err = await withTenant(s.h.db.app, { tenantId: s.h.a.id, principalPersonId: me.personId }, (tx) =>
      tx`insert into daily_aggregates (tenant_id, device_id, object_id, person_id, seq, created_at_ms, day, active_workflows, received_at)
        values (${s.h.a.id}, ${me.dev.deviceId}, '01JC0000000000000000000099', ${people[1]!.personId}, 1, 0, '2026-10-01', 0, now())`,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const err2 = await withTenant(s.h.db.app, { tenantId: s.h.b.id, principalPersonId: me.personId }, (tx) =>
      tx`insert into device_seq (tenant_id, device_id, last_seq, last_sent_at_ms, updated_at) values (${s.h.a.id}, ${me.dev.deviceId}, 1, 0, now())`,
    ).catch((e) => e);
    expect(err2).toBeInstanceOf(Error);
  });

  test("RLS: offload_app cannot delete from sync and metric tables", async () => {
    for (const t of S205_TABLES) {
      const err = await withTenant(s.h.db.app, { tenantId: s.h.a.id }, (tx) => tx.unsafe(`delete from ${t}`)).catch((e) => e);
      expect({ t, denied: err instanceof Error && /permission denied/.test(String(err.message)) }).toEqual({ t, denied: true });
    }
  });

  test("RLS: tenant B's metrics endpoints show none of tenant A's runs", async () => {
    const ownerB = await asPrincipal(s.h, "owner", s.h.b);
    const r = await ownerB.get("/v1/metrics/hours-saved?scope=company");
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual({ suppressed: true, reason: "group_floor" });
    const p = await addPerson(s.h, s.h.b, { departmentId: s.h.b.departments.sales });
    const d = await addDevice(s.h, s.h.b, p);
    expect(d.tenantId).toBe(s.h.b.id);
    const [n] = await s.h.db.migrator`select count(*)::int as n from metric_snapshots where tenant_id = ${s.h.b.id}`;
    expect(n!.n).toBeGreaterThan(0);
  });
});
