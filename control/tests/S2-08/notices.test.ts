import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import type { Principal } from "../../src/app.ts";
import { HttpError } from "../../src/schema/http.ts";
import { ulid } from "../../src/schema/encoding.ts";
import compliance from "../../src/modules/compliance/index.ts";
import { allowsAt } from "../../src/modules/compliance/consent.ts";
import { noticeBody, publishNotice, signIn, sys, type Who } from "./fixtures.ts";

let h: Harness;
let who: Who;
let deviceId: string;

beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  deviceId = (await enrollDevice(h, await asPrincipal(h, "member2"))).deviceId;
});
afterAll(() => h.close());

const NOTICE_SCHEMA = "offload/stage2/notice.schema.json";
const ACK_SCHEMA = "offload/stage2/notice-ack.schema.json";

function devicePrincipal(personId: string): Principal {
  return { kind: "device", tenantId: h.a.id, personId, deviceId, accessRole: "member", departmentScope: [], jurisdiction: "CA-ON" };
}

function syncAck(personId: string, obj: Record<string, unknown>) {
  const handler = compliance.syncHandlers!.notice_ack!;
  return sys(h, (tx) => handler(tx, obj, { principal: devicePrincipal(personId), deps: h.deps }));
}

function ackObject(notice: { id: string; features: string[]; publishedAt: number }, over: Record<string, unknown> = {}) {
  const now = h.clock.now();
  return {
    id: ulid(now),
    kind: "notice_ack",
    createdAt: now,
    noticeVersionId: notice.id,
    acknowledgedAt: now,
    jurisdiction: "CA-ON",
    features: notice.features,
    channel: "mac_app",
    ...over,
  };
}

describe("NOTICE", () => {
  test("NOTICE: an admin creates a draft from a template (201, schema-valid, unpublished, audited)", async () => {
    const r = await who.admin.post("/v1/compliance/notices", noticeBody());
    expect(r.status).toBe(201);
    expect(h.deps.validator.validate(NOTICE_SCHEMA, r.json)).toEqual({ ok: true });
    expect(r.json).toMatchObject({ publishedAt: null, replacedAt: null, acks: 0, template: "ontario-esa-policy" });
    expect(r.json.version).toBeGreaterThanOrEqual(1);
    expect((await who.owner.get("/v1/audit-log?action=notice.create")).json.items.length).toBe(1);
  });

  test("NOTICE: members, leads and auditors cannot create or publish notices", async () => {
    const draft = await who.admin.post("/v1/compliance/notices", noticeBody());
    for (const k of ["lead", "member", "auditor"] as const) {
      expect((await who[k].post("/v1/compliance/notices", noticeBody())).status).toBe(403);
      expect((await who[k].post(`/v1/compliance/notices/${draft.json.id}/publish`)).status).toBe(403);
    }
  });

  test("NOTICE: an unknown template, a duplicate feature or an unknown field is 400", async () => {
    expect((await who.admin.post("/v1/compliance/notices", noticeBody({ template: "made-up" }))).status).toBe(400);
    expect((await who.admin.post("/v1/compliance/notices", noticeBody({ features: ["working_time", "working_time"] }))).status).toBe(400);
    expect((await who.admin.post("/v1/compliance/notices", { ...noticeBody(), version: 9 })).status).toBe(400);
    expect((await who.admin.post("/v1/compliance/notices", noticeBody({ template: "custom" }))).status).toBe(201);
  });

  test("NOTICE: publish stamps publishedAt once; a second publish is 409; versions increase", async () => {
    const a = await who.admin.post("/v1/compliance/notices", noticeBody());
    const b = await who.admin.post("/v1/compliance/notices", noticeBody());
    expect(b.json.version).toBe(a.json.version + 1);
    const pub = await who.admin.post(`/v1/compliance/notices/${a.json.id}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.json.publishedAt).toBe(h.clock.now());
    expect((await who.admin.post(`/v1/compliance/notices/${a.json.id}/publish`)).status).toBe(409);
    expect((await who.admin.post(`/v1/compliance/notices/${crypto.randomUUID()}/publish`)).status).toBe(404);
  });

  test("NOTICE: everyone lists notices; only owner and admin see drafts", async () => {
    await who.admin.post("/v1/compliance/notices", noticeBody({ title: "Draft only" }));
    const admin = await who.admin.get("/v1/compliance/notices?limit=200");
    const member = await who.member.get("/v1/compliance/notices?limit=200");
    expect(admin.json.items.some((n: { publishedAt: number | null }) => n.publishedAt === null)).toBe(true);
    expect(member.status).toBe(200);
    expect(member.json.items.every((n: { publishedAt: number | null }) => n.publishedAt !== null)).toBe(true);
    for (const n of admin.json.items) expect(h.deps.validator.validate(NOTICE_SCHEMA, n)).toEqual({ ok: true });
  });

  test("NOTICE: an employee acknowledges on the web (201, notice-ack, audited for them); repeating returns the same ack", async () => {
    const n = await publishNotice(who.owner, { features: ["workflow_metrics", "per_person_views"] });
    const r = await who.member.post(`/v1/me/notices/${n.id}/ack`);
    expect(r.status).toBe(201);
    expect(h.deps.validator.validate(ACK_SCHEMA, r.json)).toEqual({ ok: true });
    expect(r.json).toMatchObject({ channel: "web", jurisdiction: "CA-ON", noticeVersionId: n.id, features: ["workflow_metrics", "per_person_views"] });
    const again = await who.member.post(`/v1/me/notices/${n.id}/ack`);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(r.json.id);
    expect((await who.member.get("/v1/me/data")).json.person.noticeAckVersionId).toBe(n.id);
    const log = await who.member.get("/v1/me/access-log?limit=200");
    expect(log.json.items.some((e: { action: string }) => e.action === "notice.ack")).toBe(true);
    expect((await who.owner.get("/v1/compliance/notices?limit=200")).json.items.find((x: { id: string }) => x.id === n.id).acks).toBe(1);
  });

  test("NOTICE: a draft or unknown notice cannot be acknowledged (404)", async () => {
    const d = await who.admin.post("/v1/compliance/notices", noticeBody());
    expect((await who.member.post(`/v1/me/notices/${d.json.id}/ack`)).status).toBe(404);
    expect((await who.member.post(`/v1/me/notices/${crypto.randomUUID()}/ack`)).status).toBe(404);
  });

  test("NOTICE: a notice for another jurisdiction cannot be acknowledged (409)", async () => {
    const ny = await publishNotice(who.owner, { template: "ny-notice-and-ack", jurisdictions: ["US-NY"] });
    expect((await who.member.post(`/v1/me/notices/${ny.id}/ack`)).status).toBe(409);
  });

  test("NOTICE: an ack via sync (notice_ack handler) is recorded with channel mac_app and the device", async () => {
    const n = await publishNotice(who.owner, { features: ["workflow_metrics"] });
    const obj = ackObject(n);
    await syncAck(h.a.people.member2.id, obj);
    const [row] = await h.db.migrator`select channel, device_id, acknowledged_at_ms from notice_acks
      where person_id = ${h.a.people.member2.id} and notice_id = ${n.id}`;
    expect(row).toEqual({ channel: "mac_app", device_id: deviceId, acknowledged_at_ms: String(obj.acknowledgedAt) });
    // The same object again (outbox retry) is a no-op, not an error.
    await syncAck(h.a.people.member2.id, obj);
    const acks = (await who.member2.get("/v1/me/data")).json.acks.filter((a: { noticeVersionId: string }) => a.noticeVersionId === n.id);
    expect(acks.length).toBe(1);
    expect(acks[0].id).toBe(obj.id);
  });

  test("NOTICE: a sync ack must match the notice: features, channel, time and the person's jurisdiction", async () => {
    const n = await publishNotice(who.owner, { features: ["workflow_metrics", "working_time"] });
    const p = h.a.people.member2.id;
    const reject = async (over: Record<string, unknown>, status: number) => {
      const e = await syncAck(p, ackObject(n, over)).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(HttpError);
      expect(Number((e as HttpError).status)).toBe(status);
    };
    await reject({ features: ["workflow_metrics"] }, 400);
    await reject({ channel: "web" }, 400);
    await reject({ acknowledgedAt: n.publishedAt - 1 }, 400);
    await reject({ acknowledgedAt: h.clock.now() + 60 * 60_000 }, 400);
    await reject({ jurisdiction: "GB" }, 409);
    await reject({ noticeVersionId: crypto.randomUUID() }, 404);
    await reject({ extra: 1 }, 400);
  });

  test("NOTICE: a new version that adds a feature requires a fresh ack; a wording-only version does not", async () => {
    const p = h.a.people.lead.id;
    const lead = who.lead;
    const ok = () => sys(h, (tx) => allowsAt(tx, p, "run_outcome", h.clock.now()));
    const v1 = await publishNotice(who.owner, { features: ["workflow_metrics"] });
    expect(await ok()).toBe(false);
    await lead.post(`/v1/me/notices/${v1.id}/ack`);
    expect(await ok()).toBe(true);
    const v2 = await publishNotice(who.owner, { features: ["workflow_metrics", "per_person_views"] });
    expect(await ok()).toBe(false);
    await lead.post(`/v1/me/notices/${v2.id}/ack`);
    expect(await ok()).toBe(true);
    await publishNotice(who.owner, { features: ["workflow_metrics", "per_person_views"], markdown: "Clearer wording, same scope." });
    expect(await ok()).toBe(true);
  });

  test("NOTICE: publishing replaces the older version it covers; history is kept and listed", async () => {
    const old = await publishNotice(who.owner, { jurisdictions: ["GB"], title: "GB v1" });
    const nu = await publishNotice(who.owner, { jurisdictions: ["GB"], title: "GB v2" });
    const all = (await who.owner.get("/v1/compliance/notices?limit=200")).json.items;
    const o = all.find((x: { id: string }) => x.id === old.id);
    expect(o.replacedAt).toBe(h.clock.now());
    expect(o.title).toBe("GB v1");
    expect(all.find((x: { id: string }) => x.id === nu.id).replacedAt).toBeNull();
    // A replaced version can no longer be newly acknowledged.
    await h.db.migrator`update people set jurisdiction = 'GB' where id = ${h.a.people.auditor.id}`;
    expect((await who.auditor.post(`/v1/me/notices/${old.id}/ack`)).status).toBe(409);
    expect((await who.auditor.post(`/v1/me/notices/${nu.id}/ack`)).status).toBe(201);
  });

  test("NOTICE: history is immutable: the app role cannot edit, delete or re-stamp a notice or an ack", async () => {
    const n = await publishNotice(who.owner);
    await who.member.post(`/v1/me/notices/${n.id}/ack`);
    await expect(sys(h, (tx) => tx`update notices set markdown = 'rewritten' where id = ${n.id}`)).rejects.toThrow();
    await expect(sys(h, (tx) => tx`update notices set published_at_ms = 1 where id = ${n.id}`)).rejects.toThrow();
    await expect(sys(h, (tx) => tx`delete from notices where id = ${n.id}`)).rejects.toThrow();
    await expect(sys(h, (tx) => tx`delete from notice_acks where notice_id = ${n.id}`)).rejects.toThrow();
    await expect(sys(h, (tx) => tx`update notice_acks set acknowledged_at_ms = 1 where notice_id = ${n.id}`)).rejects.toThrow();
    // Even the table owner cannot rewrite content (trigger).
    await expect((async () => await h.db.migrator`update notices set title = 'x' where id = ${n.id}`)()).rejects.toThrow();
  });

  test("NOTICE: ack lists: owner/admin/auditor see everyone, a dept lead only their departments, members nobody", async () => {
    const n = await publishNotice(who.owner);
    await who.member.post(`/v1/me/notices/${n.id}/ack`); // sales
    await who.member2.post(`/v1/me/notices/${n.id}/ack`); // finance
    const ids = (r: { json: { items: Array<{ personId: string }> } }) => r.json.items.map((x) => x.personId).sort();
    const all = [h.a.people.member.id, h.a.people.member2.id].sort();
    expect(ids(await who.owner.get(`/v1/compliance/notices/${n.id}/acks`))).toEqual(all);
    expect(ids(await who.auditor.get(`/v1/compliance/notices/${n.id}/acks`))).toEqual(all);
    expect(ids(await who.lead.get(`/v1/compliance/notices/${n.id}/acks`))).toEqual([h.a.people.member.id]);
    expect((await who.member.get(`/v1/compliance/notices/${n.id}/acks`)).status).toBe(403);
    expect((await who.owner.get(`/v1/compliance/notices/${crypto.randomUUID()}/acks`)).status).toBe(404);
  });
});
