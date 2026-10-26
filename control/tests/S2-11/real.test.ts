import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createValidator } from "../../src/schema/registry.ts";
import { buildWorld, type Browser, type World } from "./world.ts";

// What each dashboard screen reads (web/src/screens/*), as the role that uses it, against the seeded tenant. Every
// answer is validated here with a fresh Ajv over schemas/stage2, independent of the server's own response check.
const S = (n: string) => `offload/stage2/${n}.schema.json`;
const P = "from=2026-10-01&to=2026-10-27";

let w: World;
const v = createValidator();

beforeAll(async () => {
  w = await buildWorld();
}, 60_000);
afterAll(() => w.close());

/** GET, expect 200, validate the body (lists: every item) against `schema`. */
async function read(b: Browser, path: string, schema: string, list = false) {
  const r = await b.get(path);
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.json)}`);
  const items = list ? (r.json.items as unknown[]) : [r.json];
  if (list) expect(v.validate(S("common").replace(".schema.json", ".schema.json#/$defs/page"), r.json.page)).toEqual({ ok: true });
  for (const x of items) {
    const res = v.validate(schema, x);
    if (!res.ok) throw new Error(`${path} breaks ${schema}: ${res.errors.join("; ")}`);
  }
  return r.json;
}

describe("REAL screens on the real API", () => {
  test("REAL: overview reads validate and carry the seeded company's numbers", async () => {
    const owner = w.as("owner");
    const tenant = await read(owner, "/v1/tenant", S("tenant"));
    expect(tenant.name).toBe(w.t.name);
    const r = await read(owner, `/v1/metrics/hours-saved?scope=company&${P}`, S("hours-saved-report"));
    expect(r.total.people).toBe(15);
    expect(r.total.runs.success).toBe(45);
    expect(r.total.seconds).toBeGreaterThan(0);
    expect(r.children.map((c: { label: string }) => c.label)).toEqual(["Finance", "Legal", "Sales"]);
    // Legal's workflow is run by 4 people: under the floor, so it is not a top workflow.
    expect(r.topWorkflows.map((t: { workflowId: string }) => t.workflowId).sort()).toEqual([w.workflows.sales, w.workflows.finance].sort());
    const a = await read(owner, `/v1/metrics/adoption?scope=company&${P}`, S("adoption-report"));
    expect(a.value.peopleWithActiveWorkflow).toBe(15);
    const pending = await read(owner, "/v1/batches?state=pending", S("batch"), true);
    expect(Array.isArray(pending.items)).toBe(true);
    for (const m of ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
      const old = await read(owner, `/v1/metrics/hours-saved?scope=company&from=${m}-01&to=${m.slice(0, 5)}${String(Number(m.slice(5)) + 1).padStart(2, "0")}-01`, S("hours-saved-report"));
      expect(old.total.suppressed ?? old.total.seconds === 0).toBeTruthy();
    }
  });

  test("REAL: department reads validate (sales has numbers; its job role children are listed)", async () => {
    const owner = w.as("owner");
    const sales = w.depts.sales;
    const depts = await read(owner, "/v1/departments", S("department"), true);
    expect(depts.items.map((d: { name: string }) => d.name).sort()).toEqual(["Finance", "Legal", "Sales"]);
    const r = await read(owner, `/v1/metrics/hours-saved?scope=department:${sales}&${P}`, S("hours-saved-report"));
    expect(r.total.people).toBe(6);
    expect(r.children.map((c: { scope: { id: string } }) => c.scope.id)).toEqual([w.jobRoles.sdr]);
    await read(owner, `/v1/metrics/adoption?scope=department:${sales}&${P}`, S("adoption-report"));
    const wfs = await read(owner, `/v1/workflows?departmentId=${sales}`, S("workflow"), true);
    expect(wfs.items.map((x: { id: string }) => x.id)).toEqual([w.workflows.sales]);
    const people = await read(owner, "/v1/people", S("person"), true);
    expect(people.items.filter((p: { departmentId: string }) => p.departmentId === sales).length).toBe(7);
    // The same screen as the sales lead: summaries, not full person records (ADR 0111 §2).
    const lead = w.as("lead");
    const lp = await read(lead, "/v1/people", S("person-summary"), true);
    expect(lp.items.every((p: { departmentId: string }) => p.departmentId === sales)).toBe(true);
    await read(lead, `/v1/metrics/hours-saved?scope=department:${sales}&${P}`, S("hours-saved-report"));
  });

  test("REAL: workflows registry reads validate (list, one workflow, its version, job roles)", async () => {
    const admin = w.as("admin");
    const list = await read(admin, "/v1/workflows", S("workflow"), true);
    const role = list.items.filter((x: { state: string }) => x.state === "role");
    expect(role.map((x: { name: string }) => x.name).sort()).toEqual(["Contract intake", "Invoice matching", "Lead follow-up"]);
    const one = await read(admin, `/v1/workflows/${w.workflows.sales}`, S("workflow"));
    expect(one.latestVersion).toBe(1);
    await read(admin, `/v1/workflows/${w.workflows.sales}/versions/1`, S("workflow-definition"));
    await read(admin, "/v1/job-roles", S("job-role"), true);
    const sop = await admin.get(`/v1/workflows/${w.workflows.sales}/versions/1/sop?format=md`);
    expect(sop.status).toBe(200);
    expect(String(sop.json)).toContain("Lead follow-up");
  });

  test("REAL: approvals reads validate: the runner sees the waiting batch with its policy", async () => {
    const member = w.as("member");
    const pending = await read(member, "/v1/batches?state=pending", S("batch"), true);
    expect(pending.items.map((b: { batchHash: string }) => b.batchHash)).toContain(w.pendingBatch);
    const b = await read(member, `/v1/batches/${w.pendingBatch}`, S("batch"));
    expect(b.state).toBe("pending");
    expect(b.items.length).toBe(1);
    await read(member, `/v1/policies/job-roles/${w.jobRoles.sdr}`, S("role-policy"));
    const lead = w.as("lead");
    expect((await read(lead, "/v1/batches?state=pending", S("batch"), true)).items.length).toBe(1);
  });

  test("REAL: compliance reads validate: features off, the published notice and its acknowledgements, the audit log", async () => {
    const owner = w.as("owner");
    const f = await read(owner, "/v1/compliance/features", S("feature-enablement"), true);
    expect(f.items).toEqual([]);
    const n = await read(owner, "/v1/compliance/notices", S("notice"), true);
    expect(n.items.length).toBe(1);
    expect(n.items[0].acks).toBe(15);
    const acks = await owner.get(`/v1/compliance/notices/${w.noticeId}/acks?limit=200`);
    expect(acks.status).toBe(200);
    expect(acks.json.items.length).toBe(15);
    const log = await read(owner, "/v1/audit-log?limit=200", S("audit-event"), true);
    expect(log.items.some((e: { action: string }) => e.action === "workflow.promoted")).toBe(true);
    expect((await owner.get("/v1/audit-log/verify")).json).toEqual({ ok: true });
  });

  test("REAL: self-view reads validate: the member's own runs, devices, acknowledgement and access log", async () => {
    const member = w.as("member");
    const me = await read(member, "/v1/me/data", S("self-view"));
    expect(me.person.id).toBe(w.t.people.member.id);
    // me.runs / me.hoursSaved are filled by S2-08 from S2-05's tables (REVIEW-wave-B #10 fix 2, in progress on the
    // wave-B PR); the screen shows whatever /v1/me/data answers, so only the contract shape is asserted for them here.
    expect(Array.isArray(me.runs)).toBe(true);
    expect(me.devices.length).toBe(1);
    expect(me.acks.map((a: { noticeVersionId: string }) => a.noticeVersionId)).toEqual([w.noticeId]);
    await read(member, "/v1/me/access-log", S("audit-event"), true);
    const own = await read(member, `/v1/metrics/hours-saved?scope=person:${w.t.people.member.id}&${P}`, S("hours-saved-report"));
    expect(own.total.runs.success).toBe(3);
  });

  test("REAL: evidence reads validate and page: owner lists every run of the workflow in the period", async () => {
    const owner = w.as("owner");
    const all: unknown[] = [];
    let cursor: string | null = null;
    let first: { baseline: { n: number } } | null = null;
    do {
      const e = await read(owner, `/v1/metrics/hours-saved/evidence?workflowId=${w.workflows.sales}&version=1&${P}&limit=5${cursor ? `&cursor=${cursor}` : ""}`, S("hours-saved-evidence"));
      first ??= e;
      all.push(...e.runs);
      cursor = e.page.nextCursor;
    } while (cursor);
    expect(all.length).toBe(18);
    expect(first!.baseline.n).toBe(30);
  });

  test("REAL: gated reads answer 403 feature_disabled while the features are off", async () => {
    const owner = w.as("owner");
    const pp = await owner.get(`/v1/metrics/hours-saved?scope=person:${w.members[1]!.personId}&${P}`);
    expect(pp.status).toBe(403);
    expect(pp.json.error.code).toBe("feature_disabled");
    const wt = await owner.get(`/v1/metrics/working-time?scope=company&${P}`);
    expect(wt.status).toBe(403);
    expect(wt.json.error.code).toBe("feature_disabled");
  });
});
