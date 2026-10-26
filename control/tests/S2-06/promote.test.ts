import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { definitionHash } from "../../src/modules/registry/hash.ts";
import { stripDefinition } from "../../src/modules/registry/strip.ts";
import { PERSONAL, auditOf, promoteBody, proposal, propose, seedConnections, type ExtraConnections } from "./fixtures.ts";

let h: Harness;
let extra: ExtraConnections;
beforeAll(async () => {
  h = await createHarness();
  extra = await seedConnections(h);
});
afterAll(async () => {
  await h.close();
});

const versionsOf = async (id: string) =>
  Number((await h.db.migrator`select count(*)::int as n from workflow_versions where workflow_id = ${id}`)[0]!.n);

async function promoted(who: "admin" | "owner" | "lead" = "admin") {
  const { id, obj } = await propose(h);
  const r = await (await asPrincipal(h, who)).post(`/v1/workflows/${id}/promote`, promoteBody(h.a));
  if (r.status !== 200) throw new Error(`promote ${r.status} ${JSON.stringify(r.json)}`);
  const v = await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}/versions/1`);
  return { id, obj, workflow: r.json, def: v.json };
}

describe("PROMOTE", () => {
  test("PROMOTE: admin promotes a proposal to version 1 owned by a job role and department", async () => {
    const { id } = await propose(h);
    const r = await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id,
      state: "role",
      jobRoleId: h.a.jobRoles.sdr,
      departmentId: h.a.departments.sales,
      latestVersion: 1,
      proposedBy: h.a.people.member.id,
      promotedBy: h.a.people.admin.id,
      promotedAt: h.clock.now(),
    });
    expect(r.json.versions).toHaveLength(1);
    expect(r.json.versions[0]).toMatchObject({ version: 1, createdBy: h.a.people.admin.id, createdAt: h.clock.now() });
  });

  test("PROMOTE: the dept_lead of the target department may promote", async () => {
    const { id } = await propose(h);
    const r = await (await asPrincipal(h, "lead")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a));
    expect(r.status).toBe(200);
    expect(r.json.promotedBy).toBe(h.a.people.lead.id);
  });

  test("PROMOTE: the owner may promote", async () => {
    const { id } = await propose(h);
    expect((await (await asPrincipal(h, "owner")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(200);
  });

  test("PROMOTE: a dept_lead may not promote into a department they do not lead", async () => {
    const { id } = await propose(h);
    const body = promoteBody(h.a, { jobRoleId: h.a.jobRoles.ap, departmentId: h.a.departments.finance });
    const r = await (await asPrincipal(h, "lead")).post(`/v1/workflows/${id}/promote`, body);
    expect(r.status).toBe(403);
    expect(await versionsOf(id)).toBe(0);
  });

  test("PROMOTE: members and auditors may not promote", async () => {
    const { id } = await propose(h);
    expect((await (await asPrincipal(h, "member")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(403);
    expect((await (await asPrincipal(h, "auditor")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(403);
    expect(await versionsOf(id)).toBe(0);
  });

  test("PROMOTE: the job role must belong to the target department", async () => {
    const { id } = await propose(h);
    const r = await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a, { jobRoleId: h.a.jobRoles.ap }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
  });

  test("PROMOTE: a job role of another tenant is unknown", async () => {
    const { id } = await propose(h);
    const r = await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a, { jobRoleId: h.b.jobRoles.sdr }));
    expect(r.status).toBe(400);
  });

  test("PROMOTE: a workflow is promoted once", async () => {
    const { id } = await promoted();
    const r = await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a));
    expect(r.status).toBe(409);
    expect(await versionsOf(id)).toBe(1);
  });

  test("PROMOTE: fromVersion must name the proposal (version 1)", async () => {
    const { id } = await propose(h);
    expect((await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a, { fromVersion: 2 }))).status).toBe(404);
  });

  test("PROMOTE: bindings must name steps of the proposal, once each", async () => {
    const { id } = await propose(h);
    const admin = await asPrincipal(h, "admin");
    const unknown = promoteBody(h.a);
    unknown.bindings.push({ stepId: "nope", connectionId: null, disable: true });
    expect((await admin.post(`/v1/workflows/${id}/promote`, unknown)).status).toBe(400);
    const twice = promoteBody(h.a);
    twice.bindings.push({ stepId: "send_intro", connectionId: null, disable: true });
    expect((await admin.post(`/v1/workflows/${id}/promote`, twice)).status).toBe(400);
    const unknownConn = promoteBody(h.a, {
      bindings: [
        { stepId: "read_leads", connectionId: crypto.randomUUID(), disable: false },
        { stepId: "send_intro", connectionId: h.a.connections.company, disable: false },
        { stepId: "post_linkedin", connectionId: null, disable: true },
      ],
    });
    expect((await admin.post(`/v1/workflows/${id}/promote`, unknownConn)).status).toBe(400);
    expect(await versionsOf(id)).toBe(0);
  });

  test("PROMOTE: version 1 is the stripped, company-bound definition with its own hash", async () => {
    const { id, def } = await promoted();
    expect(def.workflowId).toBe(id);
    expect(def.version).toBe(1);
    expect(def.definitionHash).toBe(definitionHash(def));
    expect(def.steps.map((s: { id: string }) => s.id)).toEqual(["read_leads", "draft_intro", "send_intro"]);
    expect(def.steps[2].connection).toEqual({ kind: "m365_shared_mailbox", ownership: "company", connectionId: h.a.connections.company, label: "m365_shared_mailbox" });
    expect(def.steps[1].connection).toBeNull();
  });

  test("PROMOTE: disabling every step is refused (a role workflow needs a step)", async () => {
    const only = proposal().steps.filter((s) => s.id === "send_intro");
    const { id } = await propose(h, "member", { steps: only });
    const r = await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a, { bindings: [{ stepId: "send_intro", connectionId: null, disable: true }] }));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
  });

  test("PROMOTE: a dept_lead cannot see or promote another department's proposal", async () => {
    const { id } = await propose(h, "member2");
    expect((await (await asPrincipal(h, "lead")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(404);
  });

  test("PROMOTE: a body with unknown fields is refused", async () => {
    const { id } = await propose(h);
    expect((await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, { ...promoteBody(h.a), note: "x" })).status).toBe(400);
  });
});

describe("BINDING", () => {
  async function tryBind(stepId: string, connectionId: string | null, disable = false) {
    const { id } = await propose(h);
    const bindings = promoteBody(h.a).bindings.filter((b) => b.stepId !== stepId);
    if (connectionId !== null || disable) bindings.push({ stepId, connectionId, disable });
    const r = await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/promote`, promoteBody(h.a, { bindings }));
    return { id, r };
  }

  test("BINDING: a commit step bound to a personal-forbidden connection is 409 forbidden_binding", async () => {
    const { id, r } = await tryBind("send_intro", extra.forbidden);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
    expect(await versionsOf(id)).toBe(0);
  });

  test("BINDING: a commit step bound to linkedin_personal is 409 forbidden_binding on promote", async () => {
    const { id, r } = await tryBind("post_linkedin", extra.linkedinPersonal);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
    expect(await versionsOf(id)).toBe(0);
  });

  test("BINDING: leaving the personal LinkedIn commit step enabled and unbound is 409 forbidden_binding", async () => {
    const { r } = await tryBind("post_linkedin", null);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
  });

  test("BINDING: a step bound to someone's personal-allowed connection is refused at promotion", async () => {
    const { r } = await tryBind("read_leads", h.a.connections.personal);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
  });

  test("BINDING: the LinkedIn step may be rebound to the company page instead", async () => {
    const { id, r } = await tryBind("post_linkedin", extra.companyPage);
    expect(r.status).toBe(200);
    const def = (await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}/versions/1`)).json;
    expect(def.steps.find((s: { id: string }) => s.id === "post_linkedin").connection).toMatchObject({ kind: "company_linkedin_page", ownership: "company" });
  });

  test("BINDING: version_bindings records each step's company connection or that it was disabled", async () => {
    const { id } = await promoted();
    const rows = await h.db.migrator`select step_id, connection_id, ownership, disabled from version_bindings
      where workflow_id = ${id} and version = 1 order by step_id`;
    expect(rows).toEqual([
      { step_id: "draft_intro", connection_id: null, ownership: null, disabled: false },
      { step_id: "post_linkedin", connection_id: null, ownership: null, disabled: true },
      { step_id: "read_leads", connection_id: h.a.connections.company, ownership: "company", disabled: false },
      { step_id: "send_intro", connection_id: h.a.connections.company, ownership: "company", disabled: false },
    ]);
  });

  test("BINDING: a refused promotion writes nothing (no version, no audit event)", async () => {
    const { id } = await tryBind("send_intro", extra.forbidden);
    expect(await versionsOf(id)).toBe(0);
    expect(await auditOf(h, "workflow.promoted", id)).toHaveLength(0);
    expect((await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}`)).json.state).toBe("proposed");
  });

  test("BINDING: another tenant's connection cannot be bound", async () => {
    const { r } = await tryBind("send_intro", h.b.connections.company);
    expect(r.status).toBe(400);
  });
});

describe("STRIP", () => {
  test("STRIP: the promoted definition holds no facts values", async () => {
    const { def } = await promoted();
    const text = JSON.stringify(def);
    expect(text).not.toContain("Acme Robotics");
    expect(text).not.toContain("calendly.com");
    expect(def.skillMd).not.toMatch(/^## Facts/m);
  });

  test("STRIP: the promoted definition holds no recipient-like strings from the proposal", async () => {
    const { def } = await promoted();
    const text = JSON.stringify(def);
    for (const s of PERSONAL) expect(text).not.toContain(s);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(def.skillMd).not.toMatch(/^## Recipients/m);
  });

  test("STRIP: tone examples are removed", async () => {
    const { def } = await promoted();
    expect(def.skillMd).not.toMatch(/^## Tone/m);
    expect(def.skillMd).not.toContain("Hi Sam");
  });

  test("STRIP: only factsKeys survive, and the plain-words parts stay", async () => {
    const { def } = await promoted();
    expect(def.factsKeys).toEqual(["calendly_link", "company_name"]);
    expect(def.skillMd).toContain("## Steps");
    expect(def.skillMd).toContain("Nothing is sent before the review step approves the exact batch.");
    expect(def.skillMd).toContain("company_name: [fact]");
  });

  test("STRIP: the proposer's local workflow id does not follow the role workflow", async () => {
    const { def } = await promoted();
    expect(def.localWorkflowId).toBe("");
  });

  test("STRIP: stripping is deterministic and idempotent", () => {
    const p = proposal();
    const once = stripDefinition(p);
    expect(stripDefinition(p)).toEqual(once);
    expect(stripDefinition({ ...p, ...once })).toEqual(once);
  });
});
