// PR #9 round 4 (Codex P2): complementary suppression must see every child, not the first 500 the response can hold.
// The company total counts every department, so if the floor only looks at the first 500, the visible ones subtracted
// from the total give back a small department that sorts after them. The same holds for the job roles of a department.
// Thousands of people are bulk-inserted through the migrator (the ingest path would take minutes); the rows are what
// ingest stores, and the run claim (migration 0505) is written when that table exists.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, newDeviceKeys, type Client } from "../helpers/harness.ts";
import { WF1, at, setup, type S205 } from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";
type Cell = { people: number } | { suppressed: true };
type Child = { scope: { id: string }; value: Cell };

let prefix = 0;

/** `size` people per group, each with a device and one successful run in October, straight into the tables. */
async function bulk(s: S205, groups: Array<{ departmentId: string; jobRoleId?: string; size: number }>): Promise<void> {
  const db = s.h.db.migrator;
  const t = s.h.a.id;
  const tag = `b${++prefix}`;
  const depts = groups.flatMap((g) => Array.from({ length: g.size }, () => g.departmentId));
  const roles = groups.flatMap((g) => Array.from({ length: g.size }, () => g.jobRoleId ?? null));
  const people = await db`insert into people (tenant_id, email, display_name, access_role, department_id, jurisdiction, source)
    select ${t}, ${tag} || '-' || i || '@x.example.com', 'Bulk ' || i, 'member', d::uuid, 'CA-ON', 'manual'
    from jsonb_array_elements_text(${depts}::jsonb) with ordinality as x(d, i) returning id, email`;
  const byIndex = new Map(people.map((p: { id: string; email: string }) => [Number(p.email.split("-")[1]!.split("@")[0]), p.id]));
  const holders = roles.flatMap((r, i) => (r === null ? [] : [{ person: byIndex.get(i + 1)!, role: r }]));
  if (holders.length > 0) {
    await db`insert into job_role_holders (tenant_id, job_role_id, person_id)
      select ${t}, (x->>'r')::uuid, (x->>'p')::uuid from jsonb_array_elements(${holders.map((h) => ({ r: h.role, p: h.person }))}::jsonb) x`;
  }
  const { jwk } = await newDeviceKeys();
  await db`insert into devices (tenant_id, person_id, name, app_version, public_key_jwk, enrolled_at)
    select ${t}, id, ${tag}, '2.0.0', ${jwk}::jsonb, now() from people where email like ${`${tag}-%`}`;
  const ended = at("2026-10-20");
  // Run and object ids: valid ULID characters, unique per bulk call.
  await db`insert into run_outcomes (tenant_id, device_id, run_id, object_id, person_id, seq, created_at_ms, workflow_id, version,
      runtime, started_at_ms, ended_at_ms, outcome, items_total, items_sent, items_failed_before_send, items_unknown,
      items_pending, batch_hash, approver_kind, overnight_policy_id, cost_cents, error_code, overnight, received_at)
    select tenant_id, id, ${`01J${prefix}`} || lpad(n::text, ${23 - String(prefix).length}, '0'),
      ${`01K${prefix}`} || lpad(n::text, ${23 - String(prefix).length}, '0'), person_id, 1, ${ended}, ${WF1}, 1, 'mac',
      ${ended - 600_000}, ${ended}, 'success', 3, 3, 0, 0, 0, ${"b".repeat(64)}, 'person', null, 0, null, false, now()
    from (select d.*, row_number() over (order by d.id) as n from devices d where d.name = ${tag}) d`;
  const [claims] = await db`select to_regclass('run_owners') is not null as present`;
  if (claims!.present) {
    await db`insert into run_owners (tenant_id, run_id, device_id, person_id)
      select r.tenant_id, r.run_id, r.device_id, r.person_id from run_outcomes r join devices d
        on d.tenant_id = r.tenant_id and d.id = r.device_id where d.name = ${tag}`;
  }
}

/**
 * The attack: the company (or department) total minus every child that can be read with numbers, each child taken
 * from the parent's report when it is listed there and read directly otherwise. Returns the people left over.
 */
async function leftOver(owner: Client, parent: string, childIds: string[], childType: string): Promise<number> {
  const r = await owner.get(`/v1/metrics/hours-saved?scope=${parent}&${Q}`);
  expect(r.status).toBe(200);
  expect(r.json.children.length).toBeLessThanOrEqual(500);
  const listed = new Map((r.json.children as Child[]).map((c) => [c.scope.id, c.value]));
  let visible = 0;
  for (const id of childIds) {
    const v = listed.has(id) ? listed.get(id)! : (await owner.get(`/v1/metrics/hours-saved?scope=${childType}:${id}&${Q}`)).json.total;
    if (!("suppressed" in v)) visible += v.people;
  }
  return (r.json.total as { people: number }).people - visible;
}

describe("FLOOR complementary suppression over more than 500 departments", () => {
  let s: S205;
  let owner: Client;
  const ids: string[] = [];
  let tiny: string;

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    const db = s.h.db.migrator;
    // Finance and Sales (seeded) plus d000..d497: 500 departments of 5 people that sort before "zzz", a department of 1.
    const names = Array.from({ length: 498 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const made = await db`insert into departments (tenant_id, name) select ${t.id}, n from jsonb_array_elements_text(${names}::jsonb) n returning id`;
    tiny = (await db`insert into departments (tenant_id, name) values (${t.id}, 'zzz') returning id`)[0]!.id as string;
    ids.push(t.departments.finance, t.departments.sales, ...made.map((r: { id: string }) => r.id), tiny);
    await bulk(s, [...ids.slice(0, 500).map((d) => ({ departmentId: d, size: 5 })), { departmentId: tiny, size: 1 }]);
    owner = await asPrincipal(s.h, "owner");
  }, 120_000);
  afterAll(() => s.close());

  test("FLOOR: the company total minus every readable department never gives back the 1-person department after the first 500", async () => {
    const left = await leftOver(owner, "company", ids, "department");
    expect(left === 0 || left >= 5).toBe(true);
  }, 120_000);

  test("FLOOR: the 501st department is suppressed when read directly, and so is the department hidden for it", async () => {
    expect((await owner.get(`/v1/metrics/hours-saved?scope=department:${tiny}&${Q}`)).json.total).toEqual({ suppressed: true, reason: "group_floor" });
    const r = await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`);
    const hidden = (r.json.children as Child[]).filter((c) => "suppressed" in c.value);
    expect(hidden.length).toBeGreaterThanOrEqual(1);
    for (const c of hidden) {
      expect((await owner.get(`/v1/metrics/hours-saved?scope=department:${c.scope.id}&${Q}`)).json.total).toEqual({ suppressed: true, reason: "group_floor" });
    }
  }, 120_000);

  test("FLOOR: adoption of the department hidden for the 501st is suppressed too", async () => {
    const r = await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`);
    const hidden = (r.json.children as Child[]).filter((c) => "suppressed" in c.value && c.scope.id !== tiny);
    expect(hidden.length).toBeGreaterThanOrEqual(1);
    const a = await owner.get(`/v1/metrics/adoption?scope=department:${hidden[0]!.scope.id}&${Q}`);
    expect(a.json.value).toEqual({ suppressed: true, reason: "group_floor" });
  }, 120_000);
});

describe("FLOOR complementary suppression over more than 500 job roles of one department", () => {
  let s: S205;
  let owner: Client;
  let big: string;
  const roles: string[] = [];

  beforeAll(async () => {
    s = await setup();
    const t = s.h.a;
    const db = s.h.db.migrator;
    big = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Big') returning id`)[0]!.id as string;
    const names = [...Array.from({ length: 500 }, (_, i) => `r${String(i).padStart(3, "0")}`), "zzz"];
    const made = await db`insert into job_roles (tenant_id, name, department_id)
      select ${t.id}, n, ${big} from jsonb_array_elements_text(${names}::jsonb) with ordinality as x(n, i) order by i returning id, name`;
    const byName = new Map<string, string>(made.map((r: { id: string; name: string }) => [r.name, r.id]));
    roles.push(...names.map((n) => byName.get(n)!));
    await bulk(s, roles.map((r, i) => ({ departmentId: big, jobRoleId: r, size: i < 500 ? 5 : 1 })));
    owner = await asPrincipal(s.h, "owner");
  }, 120_000);
  afterAll(() => s.close());

  test("FLOOR: the department total minus every readable job role never gives back the 1-person role after the first 500", async () => {
    const left = await leftOver(owner, `department:${big}`, roles, "job_role");
    expect(left === 0 || left >= 5).toBe(true);
  }, 120_000);

  test("FLOOR: the job role hidden for the 501st role is suppressed when read directly", async () => {
    const r = await owner.get(`/v1/metrics/hours-saved?scope=department:${big}&${Q}`);
    expect((r.json.total as { people: number }).people).toBe(2501);
    const hidden = (r.json.children as Child[]).filter((c) => "suppressed" in c.value);
    expect(hidden.length).toBeGreaterThanOrEqual(1);
    for (const c of hidden) {
      expect((await owner.get(`/v1/metrics/hours-saved?scope=job_role:${c.scope.id}&${Q}`)).json.total).toEqual({ suppressed: true, reason: "group_floor" });
    }
  }, 120_000);
});
