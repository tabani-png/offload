import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";

let h: Harness;
let lead: Client;
let owner: Client;
beforeAll(async () => {
  h = await createHarness();
  lead = await asPrincipal(h, "lead");
  owner = await asPrincipal(h, "owner");
});
afterAll(() => h.close());

const SUMMARY_KEYS = ["departmentId", "displayName", "id", "jobRoleIds", "state"];
const listEvents = async () =>
  (await h.db.migrator`select actor_id, detail, subject_person_id, resource_id from audit_events
    where tenant_id = ${h.a.id} and action = 'person.list' order by seq`) as Array<{
    actor_id: string; detail: { ids: string[]; view: string }; subject_person_id: string | null; resource_id: string | null;
  }>;

describe("ORG person views", () => {
  test("ORG: a dept lead lists person summaries only (person-summary.schema.json)", async () => {
    const r = await lead.get("/v1/people?limit=200");
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBeGreaterThan(0);
    for (const p of r.json.items) {
      expect(Object.keys(p).sort()).toEqual(SUMMARY_KEYS);
      expect(h.deps.validator.validate("offload/stage2/person-summary.schema.json", p)).toEqual({ ok: true });
    }
    expect(JSON.stringify(r.json)).not.toContain("@");
  });

  test("ORG: a dept lead reading one person in scope gets a summary; their own record stays full", async () => {
    const other = await lead.get(`/v1/people/${h.a.people.member.id}`);
    expect(other.status).toBe(200);
    expect(Object.keys(other.json).sort()).toEqual(SUMMARY_KEYS);
    const self = await lead.get(`/v1/people/${h.a.people.lead.id}`);
    expect(self.json.email).toBe(h.a.people.lead.email);
  });

  test("ORG: owner, admin and auditor list full people", async () => {
    for (const c of [owner, await asPrincipal(h, "admin"), await asPrincipal(h, "auditor")]) {
      const r = await c.get("/v1/people?limit=200");
      expect(r.status).toBe(200);
      for (const p of r.json.items) expect(h.deps.validator.validate("offload/stage2/person.schema.json", p)).toEqual({ ok: true });
      expect(r.json.items.map((p: { email: string }) => p.email)).toContain(h.a.people.member.email);
    }
  });

  test("ORG: every list read writes exactly one person.list audit event with the ids read", async () => {
    const before = (await listEvents()).length;
    const first = await owner.get("/v1/people?limit=2");
    const second = await owner.get(`/v1/people?limit=2&cursor=${first.json.page.nextCursor}`);
    const evs = (await listEvents()).slice(before);
    expect(evs.length).toBe(2);
    expect(evs[0]!.detail.ids).toEqual(first.json.items.map((p: { id: string }) => p.id));
    expect(evs[1]!.detail.ids).toEqual(second.json.items.map((p: { id: string }) => p.id));
    expect(evs[0]!.actor_id).toBe(h.a.people.owner.id);
    expect(evs[0]!.detail.view).toBe("full");
    await lead.get("/v1/people");
    const [leadEv] = (await listEvents()).slice(-1);
    expect(leadEv!.detail.view).toBe("summary");
    expect(leadEv!.detail.ids).not.toContain(h.a.people.member2.id);
    // The chain still verifies with the new events in it.
    expect((await owner.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
  });

  test("ORG: a list read that is refused writes no audit event", async () => {
    const before = (await listEvents()).length;
    expect((await (await asPrincipal(h, "member")).get("/v1/people")).status).toBe(403);
    expect((await listEvents()).length).toBe(before);
  });
});
