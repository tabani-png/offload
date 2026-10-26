import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { withTenant } from "../../src/db/tenant.ts";
import type { RegistryApi } from "../../src/modules/registry/port.ts";
import { holdJobRole, promoteBody, propose, versionBody } from "./fixtures.ts";

let h: Harness;
let reg: RegistryApi;
let roleId: string;
let proposalId: string;
let identity: string;
let otherIdentity: string;

beforeAll(async () => {
  h = await createHarness();
  reg = h.deps.ports.registry as RegistryApi;
  await holdJobRole(h, h.a, h.a.jobRoles.sdr, h.a.people.member.id);
  const admin = await asPrincipal(h, "admin");
  roleId = (await propose(h, "member2")).id;
  expect((await admin.post(`/v1/workflows/${roleId}/promote`, promoteBody(h.a))).status).toBe(200);
  const v1 = (await admin.get(`/v1/workflows/${roleId}/versions/1`)).json;
  expect((await admin.post(`/v1/workflows/${roleId}/versions`, versionBody(v1, (d) => { d.name = "Outreach v2"; }))).status).toBe(200);
  proposalId = (await propose(h, "member")).id;
  const ident = async (jobRoleId: string) =>
    ((await h.db.migrator`insert into role_identities (tenant_id, job_role_id, label, connection_id)
      values (${h.a.id}, ${jobRoleId}, 'sales@', ${h.a.connections.company}) returning id`)[0]!.id as string);
  identity = await ident(h.a.jobRoles.sdr);
  otherIdentity = await ident(h.a.jobRoles.ap);
});
afterAll(async () => {
  await h.close();
});

const tx = <T>(fn: (t: Bun.TransactionSQL) => Promise<T>) => withTenant(h.db.app, { tenantId: h.a.id, accessRole: "system" }, fn);

describe("PORT", () => {
  test("PORT: the module provides the RegistryPort", () => {
    expect(typeof reg.getVersion).toBe("function");
    expect(typeof reg.bindingsFor).toBe("function");
    expect(typeof reg.isRunnableBy).toBe("function");
  });

  test("PORT: getVersion returns the immutable definition, owner and carry-over flag", async () => {
    const v2 = await tx((t) => reg.getVersion(t, roleId, 2));
    expect(v2).toMatchObject({ workflowId: roleId, version: 2, jobRoleId: h.a.jobRoles.sdr, departmentId: h.a.departments.sales, state: "role", baselineCarryOver: true });
    expect(v2!.definition.name).toBe("Outreach v2");
    expect(v2!.definitionHash).toBe(v2!.definition.definitionHash);
    expect(await tx((t) => reg.getVersion(t, roleId, 9))).toBeNull();
    expect(await tx((t) => reg.getVersion(t, proposalId, 1))).toBeNull();
  });

  test("PORT: bindingsFor lists every step's binding, disabled ones included", async () => {
    const b = await tx((t) => reg.bindingsFor(t, roleId, 1));
    expect(b.map((x) => [x.stepId, x.disabled, x.connectionId])).toEqual([
      ["read_leads", false, h.a.connections.company],
      ["draft_intro", false, null],
      ["send_intro", false, h.a.connections.company],
      ["post_linkedin", true, null],
    ]);
  });

  test("PORT: isRunnableBy a person holding the job role, not anyone else", async () => {
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 2, { personId: h.a.people.member.id }))).toBe(true);
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 2, { personId: h.a.people.member2.id }))).toBe(false);
    expect(await tx((t) => reg.isRunnableBy(t, proposalId, 1, { personId: h.a.people.member.id }))).toBe(false);
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 7, { personId: h.a.people.member.id }))).toBe(false);
  });

  test("PORT: isRunnableBy the job role's role identity only", async () => {
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 1, { identityId: identity }))).toBe(true);
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 1, { identityId: otherIdentity }))).toBe(false);
  });

  test("PORT: a frozen holder cannot run it", async () => {
    await h.db.migrator`update people set state = 'frozen' where id = ${h.a.people.member.id}`;
    try {
      expect(await tx((t) => reg.isRunnableBy(t, roleId, 2, { personId: h.a.people.member.id }))).toBe(false);
    } finally {
      await h.db.migrator`update people set state = 'active' where id = ${h.a.people.member.id}`;
    }
  });

  test("PORT: workflowsOf lists role workflows of held job roles and own pending proposals", async () => {
    expect(await tx((t) => reg.workflowsOf(t, h.a.people.member.id))).toEqual([roleId, proposalId].sort());
    expect(await tx((t) => reg.workflowsOf(t, h.a.people.auditor.id))).toEqual([]);
  });

  test("PORT: a retired workflow is no longer runnable", async () => {
    expect((await (await asPrincipal(h, "admin")).post(`/v1/workflows/${roleId}/retire`)).status).toBe(200);
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 2, { personId: h.a.people.member.id }))).toBe(false);
    expect(await tx((t) => reg.isRunnableBy(t, roleId, 1, { identityId: identity }))).toBe(false);
  });
});
