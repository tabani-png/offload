import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "../helpers/harness.ts";
import compliance from "../../src/modules/compliance/index.ts";
import { runRetention } from "../../src/modules/compliance/retention.ts";
import { publishNotice, signIn, type Who } from "./fixtures.ts";

let h: Harness;
let who: Who;

// Stand-ins for the S2-05 tables (not merged yet): same names as its SPEC, a person_id and a day column, RLS forced.
const FIXTURE_SQL = `
create table daily_aggregates (tenant_id uuid not null, id uuid primary key default gen_random_uuid(), person_id uuid not null, day date not null);
create table working_time_aggregates (tenant_id uuid not null, id uuid primary key default gen_random_uuid(), person_id uuid not null, day date not null);
create table run_outcomes (tenant_id uuid not null, id uuid primary key default gen_random_uuid(), person_id uuid not null, ended_at_ms bigint not null);
create table metric_snapshots (tenant_id uuid not null, id uuid primary key default gen_random_uuid(), month text not null);
do $$ declare t text; begin
  foreach t in array array['daily_aggregates','working_time_aggregates','run_outcomes','metric_snapshots'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    execute format('grant select, insert, delete on %I to offload_app', t);
  end loop;
  foreach t in array array['daily_aggregates','working_time_aggregates','run_outcomes'] loop
    execute format('create policy person_visibility on %I as restrictive using (person_id = nullif(current_setting(''app.principal_person_id'', true), '''')::uuid or current_setting(''app.person_read'', true) = ''on'')', t);
  end loop;
end $$;`;

const DAY = 86_400_000;
const dayAgo = (n: number) => new Date(h.clock.now() - n * DAY).toISOString().slice(0, 10);

async function seedRows(tenantId: string, personId: string) {
  const m = h.db.migrator;
  for (const n of [100, 91, 89, 10]) await m`insert into daily_aggregates (tenant_id, person_id, day) values (${tenantId}, ${personId}, ${dayAgo(n)})`;
  for (const n of [40, 31, 29, 10]) await m`insert into working_time_aggregates (tenant_id, person_id, day) values (${tenantId}, ${personId}, ${dayAgo(n)})`;
  for (const n of [120, 10]) await m`insert into run_outcomes (tenant_id, person_id, ended_at_ms) values (${tenantId}, ${personId}, ${h.clock.now() - n * DAY})`;
  await m`insert into metric_snapshots (tenant_id, month) values (${tenantId}, '2024-01'), (${tenantId}, '2026-09')`;
}

const count = async (table: string, tenantId: string) =>
  Number((await h.db.migrator.unsafe(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId]))[0].n);

beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  await h.db.migrator.unsafe(FIXTURE_SQL);
  await seedRows(h.a.id, h.a.people.member.id);
  await seedRows(h.b.id, h.b.people.member.id);
});
afterAll(() => h.close());

describe("RETENTION", () => {
  test("RETENTION: per-person rows past 90 days and working time past 30 days are deleted; recent rows stay", async () => {
    const run = await runRetention(h.deps, h.a.id);
    expect(run.deleted).toEqual({ daily_aggregates: 2, working_time_aggregates: 2, run_outcomes: 1 });
    expect(await count("daily_aggregates", h.a.id)).toBe(2);
    expect(await count("working_time_aggregates", h.a.id)).toBe(2);
    expect(await count("run_outcomes", h.a.id)).toBe(1);
  });

  test("RETENTION: group aggregates are kept", async () => {
    expect(await count("metric_snapshots", h.a.id)).toBe(2);
  });

  test("RETENTION: each pass logs a retention_run with cut-off days and counts, and an audit event", async () => {
    const [r] = await h.db.migrator`select to_char(per_person_before, 'YYYY-MM-DD') as pp, to_char(working_time_before, 'YYYY-MM-DD') as wt,
        deleted from retention_runs where tenant_id = ${h.a.id} order by ran_at_ms desc limit 1`;
    expect(r!.pp).toBe(dayAgo(90));
    expect(r!.wt).toBe(dayAgo(30));
    expect(r!.deleted).toEqual({ daily_aggregates: 2, working_time_aggregates: 2, run_outcomes: 1 });
    const log = (await who.owner.get("/v1/audit-log?action=retention.run")).json.items;
    expect(log.length).toBe(1);
    expect(log[0].actor.type).toBe("system");
  });

  test("RETENTION: another tenant's rows are untouched by this tenant's pass", async () => {
    expect(await count("daily_aggregates", h.b.id)).toBe(4);
    expect(await count("working_time_aggregates", h.b.id)).toBe(4);
  });

  test("RETENTION: a shorter tenant retention (configured downward) deletes more", async () => {
    await h.db.migrator`update tenants set retention_per_person_days = 7, retention_working_time_days = 7 where id = ${h.a.id}`;
    const run = await runRetention(h.deps, h.a.id);
    expect(run.deleted).toEqual({ daily_aggregates: 2, working_time_aggregates: 2, run_outcomes: 1 });
    expect(await count("daily_aggregates", h.a.id)).toBe(0);
    expect(await count("metric_snapshots", h.a.id)).toBe(2);
  });

  test("RETENTION: notices, acks and the audit log are never pruned by the per-person pass", async () => {
    const n = await publishNotice(who.owner);
    await who.member.post(`/v1/me/notices/${n.id}/ack`);
    const audits = await count("audit_events", h.a.id);
    h.clock.advance(400 * DAY);
    await runRetention(h.deps, h.a.id);
    expect(await count("notice_acks", h.a.id)).toBe(1);
    expect(await count("notices", h.a.id)).toBe(1);
    expect(await count("audit_events", h.a.id)).toBe(audits + 1);
  });

  test("RETENTION: tables that do not exist yet are listed as skipped, not an error", async () => {
    const run = await runRetention(h.deps, h.a.id);
    expect(run.skipped).toContain("baseline_samples");
  });

  test("RETENTION: the module registers the nightly job; it refuses to run without a tenant", async () => {
    const job = compliance.jobs!.find((j) => j.name === "compliance.retention")!;
    expect(job.schedule).toMatch(/^\S+ \S+ \* \* \*$/);
    await expect(job.run(h.deps)).rejects.toThrow(/tenant/);
  });
});
