import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { withTenant } from "../../src/db/tenant.ts";
import { jcs } from "../../src/schema/encoding.ts";
import { definitionHash } from "../../src/modules/registry/hash.ts";
import { promoteBody, proposal, propose, seedConnections, versionBody, type ExtraConnections } from "./fixtures.ts";

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
  const r = await admin.post(`/v1/workflows/${id}/promote`, promoteBody(h.a));
  if (r.status !== 200) throw new Error(`promote ${r.status}`);
  const v1 = (await admin.get(`/v1/workflows/${id}/versions/1`)).json;
  return { id, v1, admin };
}

/** The error message of a query or transaction that must fail ("resolved" if it did not). */
const errOf = (p: PromiseLike<unknown>): Promise<string> =>
  (p as Promise<unknown>).then(() => "resolved", (e: Error) => e.message);

/** Recursively reverses key order: same JSON value, different bytes. */
function reversed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversed);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reversed(x)]));
  }
  return v;
}

describe("VERSION", () => {
  test("VERSION: a new version is n+1 and leaves version 1 untouched", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const body = versionBody(v1, (d) => {
      d.description = "Intro emails to new investor leads, now with a softer opener.";
    });
    const r = await admin.post(`/v1/workflows/${id}/versions`, body);
    expect(r.status).toBe(200);
    expect(r.json.latestVersion).toBe(2);
    expect(r.json.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect((await admin.get(`/v1/workflows/${id}/versions/1`)).json).toEqual(v1);
    const v2 = (await admin.get(`/v1/workflows/${id}/versions/2`)).json;
    expect(v2.version).toBe(2);
    expect(v2.description).toBe(body.description);
    expect(v2.definitionHash).toBe(definitionHash(v2));
  });

  test("VERSION: UPDATE of a version fails at the database for the app role", async () => {
    const { id } = await roleWorkflow();
    const attempt = withTenant(h.db.app, { tenantId: h.a.id }, (tx) =>
      tx`update workflow_versions set definition = '{"name":"evil"}'::jsonb where workflow_id = ${id} and version = 1`);
    expect(await errOf(attempt)).toMatch(/permission denied/);
  });

  test("VERSION: UPDATE and DELETE of a version fail even for the table owner", async () => {
    const { id } = await roleWorkflow();
    expect(await errOf(h.db.migrator`update workflow_versions set definition_hash = ${"f".repeat(64)} where workflow_id = ${id}`)).toMatch(/immutable/);
    expect(await errOf(h.db.migrator`delete from workflow_versions where workflow_id = ${id}`)).toMatch(/immutable/);
  });

  test("VERSION: bindings and the stored proposal are immutable too", async () => {
    const { id } = await roleWorkflow();
    expect(await errOf(h.db.migrator`update version_bindings set disabled = true where workflow_id = ${id}`)).toMatch(/immutable/);
    const app = withTenant(h.db.app, { tenantId: h.a.id }, (tx) =>
      tx`update workflows set proposal_definition = '{}'::jsonb where id = ${id}`);
    expect(await errOf(app)).toMatch(/permission denied/);
    expect(await errOf(h.db.migrator`update workflows set proposal_hash = ${"0".repeat(64)} where id = ${id}`)).toMatch(/immutable/);
  });

  test("VERSION: definitionHash is stable across key order", () => {
    const def = proposal();
    expect(definitionHash(reversed(def) as never)).toBe(definitionHash(def));
    expect(jcs(reversed(def))).toBe(jcs(def));
  });

  test("VERSION: a version body sent with reversed key order is accepted with the same hash", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const body = versionBody(v1, (d) => {
      d.name = "Investor outreach v2";
    });
    const r = await admin.post(`/v1/workflows/${id}/versions`, reversed(body));
    expect(r.status).toBe(200);
    expect(r.json.versions[1].definitionHash).toBe(body.definitionHash);
  });

  test("VERSION: a body whose hash does not match is 409 hash_mismatch", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const body = { ...versionBody(v1), description: "edited after hashing" };
    const r = await admin.post(`/v1/workflows/${id}/versions`, body);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("hash_mismatch");
  });

  test("VERSION: the body must be for this workflow and the next version number", async () => {
    const { id, v1, admin } = await roleWorkflow();
    expect((await admin.post(`/v1/workflows/${id}/versions`, versionBody(v1, (d) => { d.workflowId = crypto.randomUUID(); }))).status).toBe(400);
    expect((await admin.post(`/v1/workflows/${id}/versions`, versionBody(v1, (d) => { d.version = 5; }))).status).toBe(409);
    expect((await admin.post(`/v1/workflows/${id}/versions`, versionBody(v1, (d) => { d.version = null; }))).status).toBe(200);
  });

  test("VERSION: only role workflows get new versions (not proposals, not retired)", async () => {
    const { id: proposed, obj } = await propose(h);
    const admin = await asPrincipal(h, "admin");
    expect((await admin.post(`/v1/workflows/${proposed}/versions`, versionBody(obj))).status).toBe(409);
    const { id, v1 } = await roleWorkflow();
    expect((await admin.post(`/v1/workflows/${id}/retire`)).status).toBe(200);
    expect((await admin.post(`/v1/workflows/${id}/versions`, versionBody(v1))).status).toBe(409);
  });

  test("VERSION: retire marks a role workflow retired, once", async () => {
    const { id, admin } = await roleWorkflow();
    const r = await admin.post(`/v1/workflows/${id}/retire`);
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("retired");
    expect((await admin.post(`/v1/workflows/${id}/retire`)).status).toBe(409);
    // Its versions stay readable.
    expect((await admin.get(`/v1/workflows/${id}/versions/1`)).status).toBe(200);
  });

  test("VERSION: baseline carries over when step capabilities are unchanged, not when they change", async () => {
    const { id, v1, admin } = await roleWorkflow();
    await admin.post(`/v1/workflows/${id}/versions`, versionBody(v1, (d) => { d.steps[0]!.title = "Read the new leads"; }));
    const v2 = (await admin.get(`/v1/workflows/${id}/versions/2`)).json;
    await admin.post(`/v1/workflows/${id}/versions`, versionBody(v2, (d) => { d.steps[0]!.capability = "crm.read"; }));
    const rows = await h.db.migrator`select version, baseline_carry_over from workflow_versions where workflow_id = ${id} order by version`;
    expect(rows).toEqual([
      { version: 1, baseline_carry_over: false },
      { version: 2, baseline_carry_over: true },
      { version: 3, baseline_carry_over: false },
    ]);
  });

  test("VERSION: a version's bindings must match the stored company connection", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const lie = versionBody(v1, (d) => {
      d.steps[0]!.connection = { kind: "m365_shared_mailbox", ownership: "company", connectionId: h.a.connections.personal, label: "Shared" };
    });
    const r = await admin.post(`/v1/workflows/${id}/versions`, lie);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
  });
});

describe("BINDING", () => {
  test("BINDING: a new version with a linkedin_personal commit step is 409 forbidden_binding", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const body = versionBody(v1, (d) => {
      d.steps.push({
        id: "post_linkedin",
        title: "Post on LinkedIn",
        detail: "Share a post.",
        class: "commit",
        capability: "linkedin.post",
        connection: { kind: "linkedin_personal", ownership: "personal-forbidden", connectionId: extra.linkedinPersonal, label: "LinkedIn" },
        gate: "approval",
      });
    });
    const r = await admin.post(`/v1/workflows/${id}/versions`, body);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
    expect((await admin.get(`/v1/workflows/${id}`)).json.latestVersion).toBe(1);
  });

  test("BINDING: a linkedin_personal commit claimed as personal-allowed is still 409", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const body = versionBody(v1, (d) => {
      d.steps[2]!.connection = { kind: "linkedin_personal", ownership: "personal-allowed", connectionId: null, label: "LinkedIn" };
    });
    const r = await admin.post(`/v1/workflows/${id}/versions`, body);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
  });

  test("BINDING: a new version with a personal-forbidden commit step is 409 forbidden_binding", async () => {
    const { id, v1, admin } = await roleWorkflow();
    const body = versionBody(v1, (d) => {
      d.steps[2]!.connection = { kind: "gmail", ownership: "personal-forbidden", connectionId: extra.forbidden, label: "Gmail" };
    });
    const r = await admin.post(`/v1/workflows/${id}/versions`, body);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("forbidden_binding");
  });

  test("BINDING: the database refuses a live personal-forbidden commit binding even if code did not", async () => {
    const { id } = await roleWorkflow();
    const insert = h.db.migrator`insert into version_bindings (tenant_id, workflow_id, version, position, step_id, step_class,
        capability, connection_id, ownership, disabled)
      values (${h.a.id}, ${id}, 1, 39, 'sneaky', 'commit', 'mail.send', ${extra.forbidden}, 'personal-forbidden', false)`;
    expect(await errOf(insert)).toMatch(/check constraint/);
  });
});
