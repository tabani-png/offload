import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asDevice, asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import { holdJobRole, promoteBody, propose } from "./fixtures.ts";

let h: Harness;
/** sales: SDR role workflow (member holds SDR); finance: AP role workflow; plus pending proposals of both members. */
let w: { sdr: string; ap: string; memberProposal: string; member2Proposal: string; leadProposal: string };

beforeAll(async () => {
  h = await createHarness();
  await holdJobRole(h, h.a, h.a.jobRoles.sdr, h.a.people.member.id);
  await holdJobRole(h, h.a, h.a.jobRoles.ap, h.a.people.member2.id);
  const admin = await asPrincipal(h, "admin");
  const sdr = (await propose(h, "member2")).id; // proposed by finance, owned by sales once promoted
  expect((await admin.post(`/v1/workflows/${sdr}/promote`, promoteBody(h.a))).status).toBe(200);
  const ap = (await propose(h, "member")).id; // proposed by sales, owned by finance once promoted
  const apBody = promoteBody(h.a, { jobRoleId: h.a.jobRoles.ap, departmentId: h.a.departments.finance });
  expect((await admin.post(`/v1/workflows/${ap}/promote`, apBody)).status).toBe(200);
  w = {
    sdr,
    ap,
    memberProposal: (await propose(h, "member")).id,
    member2Proposal: (await propose(h, "member2")).id,
    leadProposal: (await propose(h, "lead")).id,
  };
});
afterAll(async () => {
  await h.close();
});

const ids = (r: { json: { items: Array<{ id: string }> } }) => r.json.items.map((x) => x.id).sort();

describe("RBAC", () => {
  test("RBAC: a member lists role workflows of their own job roles and their own proposals only", async () => {
    const r = await (await asPrincipal(h, "member")).get("/v1/workflows?limit=200");
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([w.sdr, w.memberProposal].sort());
  });

  test("RBAC: a member cannot read a role workflow of a job role they do not hold", async () => {
    const m = await asPrincipal(h, "member");
    expect((await m.get(`/v1/workflows/${w.ap}`)).status).toBe(404);
    expect((await m.get(`/v1/workflows/${w.ap}/versions/1`)).status).toBe(404);
    expect((await m.get(`/v1/workflows/${w.ap}/versions/1/sop`)).status).toBe(404);
  });

  test("RBAC: a member cannot read someone else's proposal, even after it became a role workflow they lack", async () => {
    const m = await asPrincipal(h, "member");
    expect((await m.get(`/v1/workflows/${w.member2Proposal}`)).status).toBe(404);
    expect((await m.get(`/v1/workflows/${w.member2Proposal}/versions/1`)).status).toBe(404);
    // member proposed `ap` but holds no AP job role: once promoted it is finance's.
    expect((await m.get(`/v1/workflows/${w.ap}`)).status).toBe(404);
  });

  test("RBAC: a member holding the job role reads the role workflow and its versions", async () => {
    const m = await asPrincipal(h, "member");
    expect((await m.get(`/v1/workflows/${w.sdr}`)).status).toBe(200);
    expect((await m.get(`/v1/workflows/${w.sdr}/versions/1`)).status).toBe(200);
    expect((await m.get(`/v1/workflows/${w.sdr}/versions/1/sop`)).status).toBe(200);
  });

  test("RBAC: a dept_lead sees only their departments' workflows and proposals", async () => {
    const r = await (await asPrincipal(h, "lead")).get("/v1/workflows?limit=200");
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([w.sdr, w.memberProposal, w.leadProposal].sort());
  });

  test("RBAC: a dept_lead gets 404 for another department's workflow and cannot act on it", async () => {
    const lead = await asPrincipal(h, "lead");
    expect((await lead.get(`/v1/workflows/${w.ap}`)).status).toBe(404);
    expect((await lead.get(`/v1/workflows/${w.ap}/versions/1/sop`)).status).toBe(404);
    expect((await lead.post(`/v1/workflows/${w.ap}/retire`)).status).toBe(404);
    expect((await lead.post(`/v1/workflows/${w.member2Proposal}/decline`, { reason: "no" })).status).toBe(404);
    const v1 = (await (await asPrincipal(h, "admin")).get(`/v1/workflows/${w.ap}/versions/1`)).json;
    expect((await lead.post(`/v1/workflows/${w.ap}/versions`, v1)).status).toBe(404);
  });

  test("RBAC: owner, admin and auditor see the whole tenant", async () => {
    for (const who of ["owner", "admin", "auditor"] as const) {
      const r = await (await asPrincipal(h, who)).get("/v1/workflows?limit=200");
      expect(ids(r)).toEqual(Object.values(w).sort());
    }
  });

  test("RBAC: an auditor and a member may read but not change the registry", async () => {
    for (const who of ["auditor", "member"] as const) {
      const c = await asPrincipal(h, who);
      expect((await c.post(`/v1/workflows/${w.sdr}/retire`)).status).toBe(403);
      expect((await c.post(`/v1/workflows/${w.memberProposal}/decline`, { reason: "no" })).status).toBe(403);
      expect((await c.post(`/v1/workflows/${w.sdr}/versions`, {})).status).toBe(403);
    }
  });

  test("RBAC: a device token has no registry access (proposals arrive only through sync)", async () => {
    const dev = await enrollDevice(h, await asPrincipal(h, "member"));
    const call = asDevice(h, dev.token);
    expect((await call("GET", "/v1/workflows")).status).toBe(403);
    expect((await call("GET", `/v1/workflows/${w.sdr}`)).status).toBe(403);
  });

  test("RBAC: list filters by state, job role and department", async () => {
    const admin = await asPrincipal(h, "admin");
    expect(ids(await admin.get("/v1/workflows?state=role"))).toEqual([w.sdr, w.ap].sort());
    expect(ids(await admin.get(`/v1/workflows?jobRoleId=${h.a.jobRoles.ap}`))).toEqual([w.ap]);
    expect(ids(await admin.get(`/v1/workflows?departmentId=${h.a.departments.sales}&state=role`))).toEqual([w.sdr]);
    expect(ids(await admin.get("/v1/workflows?state=proposed"))).toEqual([w.memberProposal, w.member2Proposal, w.leadProposal].sort());
  });

  test("RBAC: bad filters and limits are 400 validation_failed", async () => {
    const admin = await asPrincipal(h, "admin");
    for (const q of ["state=personal", "jobRoleId=abc", "departmentId=1", "limit=0", "limit=201", "cursor=%%%"]) {
      const r = await admin.get(`/v1/workflows?${q}`);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("validation_failed");
    }
  });

  test("RBAC: the list answers {items, page} and pages with an opaque cursor", async () => {
    const admin = await asPrincipal(h, "admin");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `&cursor=${cursor}` : "";
      const r = await admin.get(`/v1/workflows?limit=2${q}`);
      expect(Object.keys(r.json).sort()).toEqual(["items", "page"]);
      seen.push(...r.json.items.map((x: { id: string }) => x.id));
      cursor = r.json.page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen.sort()).toEqual(Object.values(w).sort());
  });

  test("RBAC: another tenant sees none of it", async () => {
    const b = await asPrincipal(h, "owner", h.b);
    expect((await b.get("/v1/workflows")).json.items).toEqual([]);
    expect((await b.get(`/v1/workflows/${w.sdr}`)).status).toBe(404);
    expect((await b.get(`/v1/workflows/${w.sdr}/versions/1/sop`)).status).toBe(404);
  });

  test("RBAC: unauthenticated calls are 401", async () => {
    expect((await h.request("GET", "/v1/workflows")).status).toBe(401);
    expect((await h.request("GET", `/v1/workflows/${w.sdr}/versions/1/sop`)).status).toBe(401);
  });
});
