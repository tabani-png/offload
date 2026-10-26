import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handoverFor, offboard, stateOf, world, type World } from "./world.ts";

let w: World;
let member: string;

beforeAll(async () => {
  w = await world();
  member = w.t.people.member.id;
  await offboard(w, member);
  const admin = await w.as("admin");
  for (const wf of [w.wf.sdr1, w.wf.sdr2]) {
    const id = await handoverFor(w, member, wf);
    await admin.post(`/v1/handovers/${id}/assign`, { successor: { type: "role_identity", roleIdentityId: w.identities.sdr } });
    await admin.post(`/v1/handovers/${id}/close`);
  }
});
afterAll(() => w.close());

describe("SOP", () => {
  test("SOP: the leaver is departed", async () => {
    expect(await stateOf(w, member)).toBe("departed");
  });

  test.each(["admin", "owner", "auditor", "lead"] as const)("SOP: %s still reads the role workflows after departure", async (who) => {
    const c = await w.as(who);
    for (const wf of [w.wf.sdr1, w.wf.sdr2]) {
      const r = await c.get(`/v1/workflows/${wf}`);
      expect(r.status).toBe(200);
      expect(r.json.state).toBe("role");
    }
  });

  test("SOP: versions are still readable after departure", async () => {
    const r = await (await w.as("admin")).get(`/v1/workflows/${w.wf.sdr1}/versions/1`);
    expect(r.status).toBe(200);
    expect(w.h.deps.validator.validate("offload/stage2/workflow-definition.schema.json", r.json)).toEqual({ ok: true });
  });

  test("SOP: the SOP still exports as Markdown after departure, with no token or personal connection in it", async () => {
    const r = await (await w.as("admin")).get(`/v1/workflows/${w.wf.sdr1}/versions/1/sop?format=md`);
    expect(r.status).toBe(200);
    expect(typeof r.json).toBe("string");
    expect(r.json).toContain("Lead follow-up");
    for (const id of Object.values(w.personal)) expect(r.json).not.toContain(id);
    expect(r.json).not.toContain("acct_");
  });

  test("SOP: the workflow list for the department still has them", async () => {
    const r = await (await w.as("lead")).get(`/v1/workflows?state=role&jobRoleId=${w.t.jobRoles.sdr}`);
    expect(r.status).toBe(200);
    const ids = r.json.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(w.wf.sdr1);
    expect(ids).toContain(w.wf.sdr2);
  });

  test("SOP: the unpromoted proposal is kept (for the admin to promote or discard)", async () => {
    const r = await (await w.as("admin")).get(`/v1/workflows/${w.proposalId}`);
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("proposed");
  });
});
