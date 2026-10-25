import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { HttpError } from "../../src/schema/http.ts";
import { definitionHash } from "../../src/modules/registry/hash.ts";
import { ingest, promoteBody, proposal, propose, workflowIdOf } from "./fixtures.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

const count = async (local: string) =>
  Number((await h.db.migrator`select count(*)::int as n from workflows where tenant_id = ${h.a.id} and local_workflow_id = ${local}`)[0]!.n);

describe("PROPOSAL", () => {
  test("PROPOSAL: a workflow_proposal sync object becomes a proposed workflow", async () => {
    const obj = proposal({ localWorkflowId: "wf_accept" });
    await ingest(h, "member", obj);
    const id = await workflowIdOf(h, obj);
    const r = await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id,
      name: "Investor outreach",
      state: "proposed",
      jobRoleId: null,
      departmentId: null,
      latestVersion: 1,
      proposedBy: h.a.people.member.id,
      promotedBy: null,
      promotedAt: null,
      baselineGrade: null,
    });
    expect(r.json.versions).toEqual([{ version: 1, definitionHash: obj.definitionHash, createdAt: obj.createdAt, createdBy: h.a.people.member.id }]);
  });

  test("PROPOSAL: the proposal definition is served back exactly as received", async () => {
    const { id, obj } = await propose(h);
    const r = await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}/versions/1`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual(obj);
  });

  test("PROPOSAL: a definitionHash that does not match the definition is rejected with hash_mismatch", async () => {
    const obj = proposal({ localWorkflowId: "wf_tampered" });
    obj.description = "changed after hashing";
    const e = await rejection(ingest(h, "member", obj));
    expect(e.status).toBe(409);
    expect(e.code).toBe("hash_mismatch");
    expect(await count("wf_tampered")).toBe(0);
  });

  test("PROPOSAL: a forged hash over different content is rejected", async () => {
    const e = await rejection(ingest(h, "member", proposal({ localWorkflowId: "wf_forged" }, { hash: "0".repeat(64) })));
    expect(e.code).toBe("hash_mismatch");
    expect(await count("wf_forged")).toBe(0);
  });

  test("PROPOSAL: an object that breaks workflow-definition.schema.json is rejected as validation_failed", async () => {
    const obj = { ...proposal({ localWorkflowId: "wf_bad" }), recipients: ["sam@vc-partners.example"] };
    const e = await rejection(ingest(h, "member", obj));
    expect(e.status).toBe(400);
    expect(e.code).toBe("validation_failed");
    const notProposal = await rejection(ingest(h, "member", { ...proposal({ localWorkflowId: "wf_bad" }), kind: "run_outcome" }));
    expect(notProposal.code).toBe("validation_failed");
    expect(await count("wf_bad")).toBe(0);
  });

  test("PROPOSAL: a duplicate (same person, localWorkflowId, definitionHash) is deduped", async () => {
    const first = proposal({ localWorkflowId: "wf_dupe" });
    await ingest(h, "member", first);
    // A resend after a retry carries a new object id and time but the same definition.
    await ingest(h, "member", proposal({ localWorkflowId: "wf_dupe" }, { createdAt: first.createdAt + 60_000 }));
    await ingest(h, "member", first);
    expect(await count("wf_dupe")).toBe(1);
  });

  test("PROPOSAL: a changed definition under the same localWorkflowId is a new proposal", async () => {
    await ingest(h, "member", proposal({ localWorkflowId: "wf_changed" }));
    await ingest(h, "member", proposal({ localWorkflowId: "wf_changed", description: "A second take." }));
    expect(await count("wf_changed")).toBe(2);
  });

  test("PROPOSAL: the same definition from another person is that person's own proposal", async () => {
    await ingest(h, "member", proposal({ localWorkflowId: "wf_shared" }));
    await ingest(h, "member2", proposal({ localWorkflowId: "wf_shared" }));
    const rows = await h.db.migrator`select proposed_by, proposer_department_id from workflows
      where tenant_id = ${h.a.id} and local_workflow_id = 'wf_shared' order by proposed_by`;
    expect(rows.map((r: { proposed_by: string }) => r.proposed_by).sort()).toEqual([h.a.people.member.id, h.a.people.member2.id].sort());
  });

  test("PROPOSAL: the hash covers the definition only, not id, kind, createdAt, workflowId or version", () => {
    const a = proposal({ localWorkflowId: "wf_meta" });
    const b = { ...a, id: "01JBV2Z7Y3Q8W6X5N4M3K2J1H0", createdAt: a.createdAt + 1, workflowId: crypto.randomUUID(), version: 7 };
    expect(definitionHash(b)).toBe(definitionHash(a));
    expect(definitionHash({ ...a, name: "Other" })).not.toBe(definitionHash(a));
  });

  test("PROPOSAL: decline with a reason marks it declined and stores the reason", async () => {
    const { id } = await propose(h);
    const r = await (await asPrincipal(h, "lead")).post(`/v1/workflows/${id}/decline`, { reason: "We already have a team process for this." });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("declined");
    const [d] = await h.db.migrator`select reason, declined_by from proposals_declined where workflow_id = ${id}`;
    expect(d).toEqual({ reason: "We already have a team process for this.", declined_by: h.a.people.lead.id });
    // The proposer still sees their declined proposal.
    expect((await (await asPrincipal(h, "member")).get(`/v1/workflows/${id}`)).json.state).toBe("declined");
  });

  test("PROPOSAL: decline needs a plain, non-empty reason and nothing else", async () => {
    const { id } = await propose(h);
    const admin = await asPrincipal(h, "admin");
    expect((await admin.post(`/v1/workflows/${id}/decline`, {})).status).toBe(400);
    expect((await admin.post(`/v1/workflows/${id}/decline`, { reason: "" })).status).toBe(400);
    expect((await admin.post(`/v1/workflows/${id}/decline`, { reason: "no", extra: 1 })).status).toBe(400);
    expect((await admin.post(`/v1/workflows/${id}/decline`, { reason: "x".repeat(2001) })).status).toBe(400);
    expect((await admin.get(`/v1/workflows/${id}`)).json.state).toBe("proposed");
  });

  test("PROPOSAL: only a pending proposal can be declined", async () => {
    const { id } = await propose(h);
    const admin = await asPrincipal(h, "admin");
    expect((await admin.post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(200);
    const r = await admin.post(`/v1/workflows/${id}/decline`, { reason: "too late" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
  });

  test("PROPOSAL: resending a declined definition does not reopen it", async () => {
    const obj = proposal({ localWorkflowId: "wf_declined_resend" });
    await ingest(h, "member", obj);
    const id = await workflowIdOf(h, obj);
    await (await asPrincipal(h, "admin")).post(`/v1/workflows/${id}/decline`, { reason: "Not now." });
    await ingest(h, "member", proposal({ localWorkflowId: "wf_declined_resend" }, { createdAt: obj.createdAt + 5 }));
    expect(await count("wf_declined_resend")).toBe(1);
    expect((await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}`)).json.state).toBe("declined");
  });

  test("PROPOSAL: a proposal stays inside its tenant", async () => {
    const { id } = await propose(h);
    expect((await (await asPrincipal(h, "owner", h.b)).get(`/v1/workflows/${id}`)).status).toBe(404);
    expect((await (await asPrincipal(h, "owner", h.b)).post(`/v1/workflows/${id}/decline`, { reason: "x" })).status).toBe(404);
  });
});
