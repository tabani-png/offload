import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, asDevice, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import { PERSON_COLUMNS, personColumnsInCatalog, uncovered } from "../../src/modules/compliance/selfview.ts";
import { DAY_MS, INGEST_TABLES, enableBody, publishNotice, seedIngest, signIn, sys, type Who } from "./fixtures.ts";

const SELF_VIEW = "offload/stage2/self-view.schema.json";
const AUDIT = "offload/stage2/audit-event.schema.json";

let h: Harness;
let who: Who;
let memberDevice: string;
let member2Device: string;

beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  memberDevice = (await enrollDevice(h, await asPrincipal(h, "member"))).deviceId;
  member2Device = (await enrollDevice(h, await asPrincipal(h, "member2"))).deviceId;
});
afterAll(() => h.close());

const catalog = () => h.db.migrator.begin(async (tx) => personColumnsInCatalog(tx));

describe("SELFVIEW", () => {
  test("SELFVIEW: the catalog scan finds every column holding a person id, and the registry covers each one", async () => {
    const found = await catalog();
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(uncovered(found)).toEqual([]);
    // The registry has no stale rows either: every entry names a real column, except entries for another slice's
    // tables, which this tree may not carry yet (the S2-08 branch alone has no S2-05 or S2-07 tables).
    const key = (t: { table: string; column: string }) => `${t.table}.${t.column}`;
    const tables = new Set(found.map((f) => f.table));
    const present = PERSON_COLUMNS.filter((c) => tables.has(c.table) || c.slice === undefined);
    expect(present.map(key).sort()).toEqual(found.map(key).sort());
  });

  test("SELFVIEW: the registry covers the wave-B person columns of S2-05, S2-06 and S2-07", () => {
    const by = (t: string, c: string) => PERSON_COLUMNS.find((r) => r.table === t && r.column === c);
    expect(by("run_outcomes", "person_id")?.shownIn).toBe("runs");
    expect(by("daily_aggregates", "person_id")?.shownIn).toBe("dailyAggregates");
    expect(by("daily_aggregate_workflows", "person_id")?.shownIn).toBe("dailyAggregates");
    expect(by("working_time_aggregates", "person_id")?.shownIn).toBe("workingTime");
    for (const [t, c] of [
      ["baseline_samples", "person_id"], ["baseline_sample_instances", "person_id"], ["review_events", "person_id"],
      ["workflows", "proposed_by"], ["workflows", "promoted_by"], ["workflow_versions", "created_by"],
      ["proposals_declined", "declined_by"], ["batches", "runner_person_id"], ["overnight_policies", "owner_person_id"],
      ["kill_switches", "set_by"], ["role_policies", "updated_by"],
    ] as const) {
      expect({ t, c, registered: by(t, c) !== undefined }).toEqual({ t, c, registered: true });
    }
  });

  test("SELFVIEW: every registry row says where it appears in the self-view, or why it does not", () => {
    for (const r of PERSON_COLUMNS) {
      if (r.shownIn === null) expect(r.reason?.length ?? 0).toBeGreaterThan(20);
      else expect(["person", "acks", "devices", "accessLog", "runs", "dailyAggregates", "workingTime"]).toContain(r.shownIn);
    }
  });

  test("SELFVIEW: a new table with a person_id column (or a foreign key to people) fails the scan until registered", async () => {
    await h.db.migrator.unsafe(`create table side_notes (tenant_id uuid not null, person_id uuid, note text);
      create table side_links (tenant_id uuid not null, id uuid primary key, subject uuid,
        foreign key (tenant_id, subject) references people (tenant_id, id))`);
    try {
      expect(uncovered(await catalog()).map((c) => `${c.table}.${c.column}`).sort()).toEqual(["side_links.subject", "side_notes.person_id"]);
    } finally {
      await h.db.migrator.unsafe("drop table side_notes; drop table side_links");
    }
  });

  test.each(["owner", "admin", "lead", "member", "member2", "auditor"] as const)(
    "SELFVIEW: GET /v1/me/data for %s validates against self-view.schema.json",
    async (k) => {
      const r = await who[k].get("/v1/me/data");
      expect(r.status).toBe(200);
      expect(h.deps.validator.validate(SELF_VIEW, r.json)).toEqual({ ok: true });
      expect(r.json.person.id).toBe(who[k].personId);
    },
  );

  test("SELFVIEW: it holds my rows only: my devices, my acks, my hs-1 scope, the tenant's retention", async () => {
    const n = await publishNotice(who.owner);
    await who.member.post(`/v1/me/notices/${n.id}/ack`);
    await who.member2.post(`/v1/me/notices/${n.id}/ack`);
    const me = (await who.member.get("/v1/me/data")).json;
    expect(me.devices.map((d: { id: string }) => d.id)).toEqual([memberDevice]);
    expect(me.acks.map((a: { noticeVersionId: string }) => a.noticeVersionId)).toEqual([n.id]);
    expect(me.hoursSaved.computation).toBe("hs-1");
    expect(me.hoursSaved.scope).toEqual({ type: "person", id: who.member.personId });
    expect(me.retention).toEqual({ perPersonDays: 90, workingTimeDays: 30 });
    await h.db.migrator`update tenants set retention_per_person_days = 30 where id = ${h.a.id}`;
    expect((await who.member.get("/v1/me/data")).json.retention.perPersonDays).toBe(30);
  });

  test("SELFVIEW: export equals the data view, downloads as JSON and is audited for me", async () => {
    const data = await who.member2.get("/v1/me/data");
    const exp = await who.member2.get("/v1/me/export");
    expect(exp.status).toBe(200);
    expect(exp.json).toEqual(data.json);
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    const after = (await who.member2.get("/v1/me/access-log?limit=200")).json.items;
    expect(after.some((e: { action: string; actor: { id: string } }) => e.action === "self.export" && e.actor.id === who.member2.personId)).toBe(true);
  });

  test("SELFVIEW: exports are limited to 5 a day per person (429 with Retry-After)", async () => {
    for (let i = 0; i < 5; i++) expect((await who.lead.get("/v1/me/export")).status).toBe(200);
    const sixth = await who.lead.get("/v1/me/export");
    expect(sixth.status).toBe(429);
    expect(sixth.json.error.code).toBe("rate_limited");
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    h.clock.advance(24 * 3_600_000 + 1);
    expect((await who.lead.get("/v1/me/export")).status).toBe(200);
  });

  test("SELFVIEW: a correction request is stored for me and audited (201 {id}); bad bodies are 400", async () => {
    const r = await who.member.post("/v1/me/correction-requests", { field: "jurisdiction", message: "I work in Quebec, not Ontario." });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json)).toEqual(["id"]);
    const [row] = await h.db.migrator`select person_id, field, state from correction_requests where id = ${r.json.id}`;
    expect(row).toEqual({ person_id: who.member.personId, field: "jurisdiction", state: "open" });
    const log = (await who.member.get("/v1/me/access-log?limit=200")).json.items;
    expect(log.some((e: { action: string }) => e.action === "correction.request")).toBe(true);
    expect((await who.member.post("/v1/me/correction-requests", { field: "x" })).status).toBe(400);
    expect((await who.member.post("/v1/me/correction-requests", { field: "x", message: "y", personId: who.member2.personId })).status).toBe(400);
    expect((await who.member.post("/v1/me/correction-requests", { field: "", message: "y" })).status).toBe(400);
  });

  test("SELFVIEW: devices cannot read the self-view; signed-out callers are 401", async () => {
    const dev = await enrollDevice(h, await asPrincipal(h, "member2"));
    expect((await asDevice(h, dev.token)("GET", "/v1/me/data")).status).toBe(403);
    expect((await h.request("GET", "/v1/me/data")).status).toBe(401);
  });

  test("SELFVIEW: features in the self-view follow the enablement for my jurisdiction", async () => {
    const n = await publishNotice(who.owner, { features: ["workflow_metrics", "working_time"] });
    await who.owner.post("/v1/compliance/features/working_time/enable", enableBody("working_time", n.id, { noticePeriodDays: 0 }));
    expect((await who.member.get("/v1/me/data")).json.features.working_time).toBe(true);
    await who.owner.post("/v1/compliance/features/working_time/disable");
    expect((await who.member.get("/v1/me/data")).json.features.working_time).toBe(false);
  });

  test.skipIf(!INGEST_TABLES)("SELFVIEW: my runs, daily aggregates and working time come from S2-05's tables, mine only", async () => {
    const now = h.clock.now();
    const mine = await seedIngest(h, h.a.id, who.member.personId, memberDevice, now, { runs: [2, 1], daily: [1], workingTime: [1], reviews: [1], baselines: [1] });
    const theirs = await seedIngest(h, h.a.id, who.member2.personId, member2Device, now, { runs: [1], daily: [1], workingTime: [1] });
    const r = await who.member.get("/v1/me/data");
    expect(r.status).toBe(200);
    expect(h.deps.validator.validate(SELF_VIEW, r.json)).toEqual({ ok: true });
    const ids = (t: string, xs: typeof mine) => xs.filter((x) => x.table === t).map((x) => x.objectId);
    expect(r.json.runs.map((x: { id: string }) => x.id).sort()).toEqual(ids("run_outcomes", mine).sort());
    expect(r.json.dailyAggregates.map((x: { id: string }) => x.id)).toEqual(ids("daily_aggregates", mine));
    expect(r.json.workingTime.map((x: { id: string }) => x.id)).toEqual(ids("working_time_aggregates", mine));
    const all = JSON.stringify(r.json);
    for (const t of theirs) expect(all).not.toContain(t.objectId);
    const run = r.json.runs[0];
    expect(run).toMatchObject({ kind: "run_outcome", runtime: "mac", outcome: "success", items: { total: 3, sent: 3, failedBeforeSend: 0, unknown: 0, pending: 0 }, costCents: 12, overnight: false });
    expect(run.endedAt).toBeGreaterThan(run.startedAt);
    expect(r.json.dailyAggregates[0]).toMatchObject({ kind: "daily_aggregate", day: new Date(now - DAY_MS).toISOString().slice(0, 10), activeWorkflows: 1 });
    expect(r.json.dailyAggregates[0].workflows).toEqual([{ workflowId: expect.any(String), version: 1, runs: 2, successes: 2, savedSecondsDevice: 600 }]);
    expect(r.json.workingTime[0]).toMatchObject({ kind: "working_time_aggregate", activeMinutes: 420, firstActiveQuarter: 36, lastActiveQuarter: 70 });
    // Newest run first.
    expect(r.json.runs[0].endedAt).toBeGreaterThan(r.json.runs[1].endedAt);
    // The export is the same view.
    expect((await who.member.get("/v1/me/export")).json.runs).toEqual(r.json.runs);
  });

  test("SELFVIEW: the export limit holds under concurrent requests (5 a day, not 5 per racing batch)", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => who.auditor.get("/v1/me/export")));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200).length).toBe(5);
    expect(codes.filter((c) => c === 429).length).toBe(5);
  });

  test("SELFVIEW: the app role may update a correction request's state, never its text or owner", async () => {
    const r = await who.member2.post("/v1/me/correction-requests", { field: "department", message: "I moved to Sales." });
    expect(r.status).toBe(201);
    const upd = (set: string) => sys(h, (tx) => tx.unsafe(`update correction_requests set ${set} where id = $1`, [r.json.id])).catch((e: unknown) => e);
    expect(await upd("state = 'resolved'")).not.toBeInstanceOf(Error);
    for (const set of ["message = 'edited'", "field = 'x'", `person_id = '${who.member.personId}'`]) {
      const err = await upd(set);
      expect({ set, denied: err instanceof Error && /permission denied/.test(err.message) }).toEqual({ set, denied: true });
    }
  });
});

describe("ACCESSLOG", () => {
  test("ACCESSLOG: an admin's person.read appears in the subject's access log, not in anyone else's", async () => {
    const before = h.clock.now();
    expect((await who.admin.get(`/v1/people/${who.member.personId}`)).status).toBe(200);
    const mine = (await who.member.get(`/v1/me/access-log?from=${before}&limit=200`)).json.items;
    const read = mine.filter((e: { action: string }) => e.action === "person.read");
    expect(read.length).toBe(1);
    expect(read[0].actor).toEqual({ type: "person", id: who.admin.personId, accessRole: "admin" });
    const theirs = (await who.member2.get(`/v1/me/access-log?from=${before}&limit=200`)).json.items;
    expect(theirs.filter((e: { action: string }) => e.action === "person.read")).toEqual([]);
  });

  test("ACCESSLOG: every entry is a schema-valid audit event about me", async () => {
    await who.owner.get(`/v1/people/${who.member.personId}`);
    const r = await who.member.get("/v1/me/access-log?limit=200");
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBeGreaterThan(0);
    for (const e of r.json.items) {
      expect(h.deps.validator.validate(AUDIT, e)).toEqual({ ok: true });
      const aboutMe = e.subjectPersonId === who.member.personId || (e.detail.ids ?? []).includes(who.member.personId);
      expect(aboutMe).toBe(true);
    }
  });

  test("ACCESSLOG: a people list read that included me shows up too (one person.list event, my id in it)", async () => {
    const before = h.clock.now();
    expect((await who.admin.get("/v1/people?limit=200")).status).toBe(200);
    const mine = (await who.member2.get(`/v1/me/access-log?from=${before}&limit=200`)).json.items;
    const lists = mine.filter((e: { action: string }) => e.action === "person.list");
    expect(lists.length).toBe(1);
    expect(lists[0].actor.id).toBe(who.admin.personId);
    // A lead's list covers their departments only: member2 (finance) is not in the sales lead's list.
    h.clock.advance(1);
    const t = h.clock.now();
    expect((await who.lead.get("/v1/people?limit=200")).status).toBe(200);
    const after = (await who.member2.get(`/v1/me/access-log?from=${t}&limit=200`)).json.items;
    expect(after.filter((e: { action: string }) => e.action === "person.list")).toEqual([]);
  });

  test("ACCESSLOG: the self-view's accessLog shows the same 'who looked' entries", async () => {
    await who.auditor.get(`/v1/people/${who.member2.personId}`);
    const data = (await who.member2.get("/v1/me/data")).json;
    const log = (await who.member2.get("/v1/me/access-log?limit=200")).json.items;
    const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();
    expect(ids(data.accessLog)).toEqual(ids(log));
    expect(data.accessLog.some((e: { actor: { id: string } }) => e.actor.id === who.auditor.personId)).toBe(true);
  });

  test("ACCESSLOG: pages with a cursor; filters by action and time; bad params are 400", async () => {
    for (let i = 0; i < 3; i++) await who.admin.get(`/v1/people/${who.lead.personId}`);
    const p1 = await who.lead.get("/v1/me/access-log?limit=2&action=person.read");
    expect(p1.json.items.length).toBe(2);
    expect(p1.json.page.nextCursor).not.toBeNull();
    const p2 = await who.lead.get(`/v1/me/access-log?limit=2&action=person.read&cursor=${p1.json.page.nextCursor}`);
    expect(p2.json.items.length).toBeGreaterThanOrEqual(1);
    expect(p2.json.items[0].id).not.toBe(p1.json.items[1].id);
    expect((await who.lead.get("/v1/me/access-log?to=0")).json.items).toEqual([]);
    expect((await who.lead.get("/v1/me/access-log?action=BAD")).status).toBe(400);
    expect((await who.lead.get("/v1/me/access-log?subjectPersonId=x")).status).toBe(400);
    expect((await who.lead.get("/v1/me/access-log?limit=0")).status).toBe(400);
  });

  test("ACCESSLOG: a list read that included me shows only my id, never the other people read in the same call", async () => {
    const before = h.clock.now();
    expect((await who.admin.get("/v1/people?limit=200")).status).toBe(200);
    const n = await publishNotice(who.owner);
    await who.member.post(`/v1/me/notices/${n.id}/ack`);
    await who.member2.post(`/v1/me/notices/${n.id}/ack`);
    expect((await who.admin.get(`/v1/compliance/notices/${n.id}/acks`)).status).toBe(200);
    const mine = (await who.member2.get(`/v1/me/access-log?from=${before}&limit=200`)).json.items;
    const lists = mine.filter((e: { action: string }) => e.action === "person.list" || e.action === "notice.acks_read");
    expect(lists.map((e: { action: string }) => e.action).sort()).toEqual(["notice.acks_read", "person.list"]);
    for (const e of lists) expect(e.detail.ids).toEqual([who.member2.personId]);
    const view = (await who.member2.get("/v1/me/data")).json.accessLog.filter((e: { detail: { ids?: string[] } }) => Array.isArray(e.detail.ids));
    expect(view.length).toBeGreaterThanOrEqual(2);
    for (const e of view) expect(e.detail.ids).toEqual([who.member2.personId]);
    // The stored event still names everyone read (the auditors' log is unchanged).
    const full = (await who.auditor.get(`/v1/audit-log?action=person.list&limit=200`)).json.items;
    expect(full.some((e: { detail: { ids: string[] } }) => e.detail.ids.length > 1)).toBe(true);
  });

  test("ACCESSLOG: any event whose detail.ids names me is in my log, whatever its action", async () => {
    const before = h.clock.now();
    await sys(h, (tx) =>
      h.deps.ports.audit.write(tx, {
        actor: { type: "person", id: who.admin.personId, accessRole: "admin" },
        action: "workflow.list",
        resource: { type: "workflow", id: null },
        detail: { ids: [who.member.personId, who.member2.personId] },
      }),
    );
    for (const p of [who.member, who.member2]) {
      const e = (await p.get(`/v1/me/access-log?from=${before}&action=workflow.list`)).json.items;
      expect(e.length).toBe(1);
      expect(e[0].detail.ids).toEqual([p.personId]);
    }
    expect((await who.lead.get(`/v1/me/access-log?from=${before}&action=workflow.list`)).json.items).toEqual([]);
  });

  test("ACCESSLOG: another tenant's reads never show up", async () => {
    const b = await signIn(h, h.b);
    await b.admin.get(`/v1/people/${h.b.people.member.id}`);
    const mine = (await who.member.get("/v1/me/access-log?limit=200")).json.items;
    expect(mine.every((e: { actor: { id: string | null } }) => e.actor.id !== b.admin.personId)).toBe(true);
  });
});

describe("CHAIN", () => {
  test("CHAIN: compliance actions join the tenant's hash chain and verify ok", async () => {
    const n = await publishNotice(who.owner, { features: ["workflow_metrics", "per_person_views"] });
    await who.member.post(`/v1/me/notices/${n.id}/ack`);
    await who.owner.post("/v1/compliance/features/per_person_views/enable", enableBody("per_person_views", n.id));
    const actions = (await who.owner.get("/v1/audit-log?limit=200")).json.items.map((e: { action: string }) => e.action);
    for (const a of ["notice.create", "notice.publish", "notice.ack", "feature.enable"]) expect(actions).toContain(a);
    expect((await who.auditor.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
  });

  test("CHAIN: tampering with a compliance event is detected at that event", async () => {
    const [e] = await h.db.migrator`select id from audit_events where tenant_id = ${h.a.id} and action = 'feature.enable' limit 1`;
    await h.db.migrator`update audit_events set detail = '{"jurisdictions":["GB"]}'::jsonb where tenant_id = ${h.a.id} and id = ${e!.id}`;
    expect((await who.owner.get("/v1/audit-log/verify")).json).toEqual({ ok: false, brokenAt: e!.id, reason: "link" });
  });

  test("CHAIN: the app role cannot rewrite or delete audit events", async () => {
    const tx = (q: string) => h.db.app.begin(async (t) => {
      await t`select set_config('app.tenant_id', ${h.a.id}, true)`;
      return t.unsafe(q);
    });
    await expect(tx("update audit_events set action = 'x.y'")).rejects.toThrow();
    await expect(tx("delete from audit_events")).rejects.toThrow();
  });
});
