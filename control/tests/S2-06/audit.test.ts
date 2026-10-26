import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { auditOf, ingest, promoteBody, proposal, propose, seedConnections, versionBody, workflowIdOf, type ExtraConnections } from "./fixtures.ts";

let h: Harness;
let extra: ExtraConnections;
beforeAll(async () => {
  h = await createHarness();
  extra = await seedConnections(h);
});
afterAll(async () => {
  await h.close();
});

async function roleWorkflow() {
  const { id } = await propose(h);
  const admin = await asPrincipal(h, "admin");
  expect((await admin.post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(200);
  return { id, admin };
}

describe("AUDIT", () => {
  test("AUDIT: workflow.proposed is written by the device for the proposer", async () => {
    const obj = proposal({ localWorkflowId: "wf_audit_proposed" });
    await ingest(h, "member", obj);
    const id = await workflowIdOf(h, obj);
    const [e, ...more] = await auditOf(h, "workflow.proposed", id);
    expect(more).toHaveLength(0);
    expect(e).toMatchObject({ actor_type: "device", subject_person_id: h.a.people.member.id, resource_type: "workflow" });
    expect(e!.detail).toMatchObject({ definitionHash: obj.definitionHash, steps: 4 });
  });

  test("AUDIT: a deduped proposal writes no second event", async () => {
    const obj = proposal({ localWorkflowId: "wf_audit_dupe" });
    await ingest(h, "member", obj);
    await ingest(h, "member", obj);
    expect(await auditOf(h, "workflow.proposed", await workflowIdOf(h, obj))).toHaveLength(1);
  });

  test("AUDIT: workflow.promoted names the job role, department, hash and disabled steps", async () => {
    const { id } = await roleWorkflow();
    const [e] = await auditOf(h, "workflow.promoted", id);
    expect(e).toMatchObject({ actor_type: "person", actor_id: h.a.people.admin.id, subject_person_id: h.a.people.member.id });
    expect(e!.detail).toMatchObject({
      version: 1,
      fromVersion: 1,
      jobRoleId: h.a.jobRoles.sdr,
      departmentId: h.a.departments.sales,
      disabledSteps: ["post_linkedin"],
    });
    expect(e!.detail.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("AUDIT: workflow.versioned records the version, hash and baseline carry-over", async () => {
    const { id, admin } = await roleWorkflow();
    const v1 = (await admin.get(`/v1/workflows/${id}/versions/1`)).json;
    const body = versionBody(v1, (d) => { d.description = "Same steps, new words."; });
    expect((await admin.post(`/v1/workflows/${id}/versions`, body)).status).toBe(200);
    const [e] = await auditOf(h, "workflow.versioned", id);
    expect(e!.detail).toEqual({ version: 2, definitionHash: body.definitionHash, baselineCarryOver: true });
  });

  test("AUDIT: workflow.retired is written", async () => {
    const { id, admin } = await roleWorkflow();
    await admin.post(`/v1/workflows/${id}/retire`);
    const [e] = await auditOf(h, "workflow.retired", id);
    expect(e).toMatchObject({ actor_id: h.a.people.admin.id, resource_type: "workflow" });
  });

  test("AUDIT: workflow.declined carries the reason for the proposer", async () => {
    const { id } = await propose(h);
    await (await asPrincipal(h, "lead")).post(`/v1/workflows/${id}/decline`, { reason: "Duplicate of the SDR workflow." });
    const [e] = await auditOf(h, "workflow.declined", id);
    expect(e).toMatchObject({ actor_id: h.a.people.lead.id, subject_person_id: h.a.people.member.id });
    expect(e!.detail).toEqual({ reason: "Duplicate of the SDR workflow." });
  });

  test("AUDIT: refused mutations write no event", async () => {
    const { id } = await propose(h);
    const admin = await asPrincipal(h, "admin");
    const bad = promoteBody(h.a);
    bad.bindings[1] = { stepId: "send_intro", connectionId: extra.forbidden, disable: false };
    expect((await admin.post(`/v1/workflows/${id}/promote`, bad)).status).toBe(409);
    expect((await admin.post(`/v1/workflows/${id}/retire`)).status).toBe(409);
    for (const a of ["workflow.promoted", "workflow.retired", "workflow.versioned", "workflow.declined"]) {
      expect(await auditOf(h, a, id)).toHaveLength(0);
    }
  });

  test("AUDIT: events hold hashes and ids, never definition text", async () => {
    const { id } = await roleWorkflow();
    const rows = await h.db.migrator`select detail from audit_events where tenant_id = ${h.a.id} and resource_id = ${id}`;
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Investor outreach");
    expect(text).not.toContain("skillMd");
    expect(text).not.toContain("jane.doe");
  });

  test("AUDIT: the tenant's chain still verifies after registry writes", async () => {
    await roleWorkflow();
    const r = await (await asPrincipal(h, "owner")).get("/v1/audit-log/verify");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });
});
