import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES, createMockClient, findRoute } from "../src/api/mock/server.ts";
import * as fx from "../src/api/mock/fixtures.ts";
import { uuid } from "../src/api/mock/ids.ts";
import { check } from "./helpers/schemas.ts";

const API_MD = readFileSync(join(import.meta.dir, "../../plan/stage-2/API.md"), "utf8");

/** Every `GET /path` named in API.md, with `:params` kept and query strings dropped. */
function apiGets(): string[] {
  const out = new Set<string>();
  for (const m of API_MD.matchAll(/\bGET(?:\/[A-Z]+)*\s+`?(\/[A-Za-z0-9/:_.\-]+)/g)) out.add(m[1]!.replace(/\/$/, ""));
  return [...out];
}

const W = fx.WF[301]!;
const H = fx.batches[0]!.batchHash;
/** One concrete URL per GET route (params filled with fixture ids, queries the screens use). */
const SAMPLES: Record<string, string[]> = {
  "/v1/people/:id": [`/v1/people/${fx.ME.id}`],
  "/v1/policies/job-roles/:id": [`/v1/policies/job-roles/${fx.JR.sdr}`],
  "/v1/workflows/:id": [`/v1/workflows/${W}`, `/v1/workflows/${fx.WF[309]}`],
  "/v1/workflows/:id/versions/:v": [`/v1/workflows/${W}/versions/3`, `/v1/workflows/${fx.WF[309]}/versions/1`, `/v1/workflows/${fx.WF[310]}/versions/1`],
  "/v1/workflows/:id/versions/:v/sop": [`/v1/workflows/${W}/versions/3/sop?format=md`],
  "/v1/batches/:hash": [`/v1/batches/${H}`],
  "/v1/workers/:id/runs": [`/v1/workers/${fx.workers[0]!.id}/runs`],
  "/v1/worker-runs/:id": [`/v1/worker-runs/${fx.workerRuns[0]!.id}`],
  "/v1/compliance/notices/:id/acks": [`/v1/compliance/notices/${uuid(702)}/acks`],
  "/v1/metrics/hours-saved": [
    "/v1/metrics/hours-saved?scope=company&from=2026-10-01&to=2026-10-26",
    "/v1/metrics/hours-saved?scope=company&from=2026-05-01&to=2026-10-26",
    `/v1/metrics/hours-saved?scope=department:${fx.DEPT.sales}`,
    `/v1/metrics/hours-saved?scope=department:${fx.DEPT.finance}`,
    `/v1/metrics/hours-saved?scope=department:${fx.DEPT.legal}`,
    `/v1/metrics/hours-saved?scope=job_role:${fx.JR.sdr}`,
    `/v1/metrics/hours-saved?scope=person:${fx.ME.id}`,
  ],
  "/v1/metrics/hours-saved/evidence": [
    `/v1/metrics/hours-saved/evidence?workflowId=${W}&version=3`,
    `/v1/metrics/hours-saved/evidence?workflowId=${fx.WF[304]}&version=1`,
    `/v1/metrics/hours-saved/evidence?workflowId=${fx.WF[302]}&version=2`,
  ],
  "/v1/metrics/adoption": ["/v1/metrics/adoption?scope=company", `/v1/metrics/adoption?scope=department:${fx.DEPT.legal}`],
  "/v1/metrics/working-time": [`/v1/metrics/working-time?scope=department:${fx.DEPT.sales}`, `/v1/metrics/working-time?scope=department:${fx.DEPT.facilities}`],
  "/v1/me/digest": [`/v1/me/digest?day=${fx.TODAY}`],
};

describe("mock API against schemas/stage2", () => {
  test("SCHEMA: mock routes cover every GET in API.md", () => {
    const gets = apiGets();
    expect(gets.length).toBeGreaterThan(30);
    const missing = gets.filter((p) => !ROUTES.some((r) => r.method === "GET" && r.path === p));
    expect(missing).toEqual([]);
  });

  test("SCHEMA: every GET response validates against its schema (all sensitive features on)", async () => {
    const api = createMockClient({ features: ["per_person_views", "working_time"] });
    let checked = 0;
    for (const r of ROUTES.filter((x) => x.method === "GET")) {
      for (const url of SAMPLES[r.path] ?? [r.path]) {
        const data = r.response.kind === "text" ? await api.getText(url) : await api.get(url);
        const err = check(r.response, data);
        if (err) throw new Error(`${url}: ${err}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(45);
  });

  test("SCHEMA: fixture collections validate item by item", () => {
    const sets: [string, unknown[]][] = [
      ["person.schema.json", fx.people], ["department.schema.json", fx.departments], ["job-role.schema.json", fx.jobRoles],
      ["workflow.schema.json", fx.workflows], ["batch.schema.json", fx.batches], ["worker.schema.json", fx.workers],
      ["worker-run.schema.json", fx.workerRuns], ["handover.schema.json", fx.handovers], ["notice.schema.json", fx.notices],
      ["audit-event.schema.json", fx.auditLog], ["connection.schema.json", fx.connections], ["role-identity.schema.json", fx.roleIdentities],
      ["overnight-policy.schema.json", fx.overnightPolicies], ["kill-switch.schema.json", fx.killSwitches],
      ["device-enrollment.schema.json#/$defs/device", fx.devices], ["tenant.schema.json", [fx.tenant]],
    ];
    for (const [ref, items] of sets) {
      for (const item of items) {
        const err = check({ kind: "schema", ref }, item);
        if (err) throw new Error(`${ref}: ${err}`);
      }
    }
    for (const w of fx.WORKFLOW_SPECS) {
      for (let v = 1; v <= w.versions; v++) expect(check({ kind: "schema", ref: "workflow-definition.schema.json" }, fx.definitionFor(uuid(w.n), v))).toBeNull();
    }
  });

  test("SCHEMA: sensitive feature routes answer feature_disabled by default", async () => {
    const api = createMockClient();
    expect(api.get(`/v1/metrics/working-time?scope=department:${fx.DEPT.sales}`)).rejects.toMatchObject({ code: "feature_disabled", status: 403 });
    expect(api.get(`/v1/metrics/hours-saved?scope=person:${fx.people[0]!.id}`)).rejects.toMatchObject({ code: "feature_disabled" });
    // Self is always allowed (API.md: S always).
    expect(check({ kind: "schema", ref: "hours-saved-report.schema.json" }, await api.get(`/v1/metrics/hours-saved?scope=person:${fx.ME.id}`))).toBeNull();
    expect(await api.get<unknown>("/v1/compliance/features")).toEqual({ items: [], page: { nextCursor: null } });
  });

  test("SCHEMA: every route with a request schema accepts the body its screen sends", async () => {
    const bodies: Record<string, unknown> = {
      "/v1/workflows/:id/promote": { jobRoleId: fx.JR.sdr, departmentId: fx.DEPT.sales, fromVersion: 1, bindings: [{ stepId: "send-invites", connectionId: null, disable: true }] },
      "/v1/batches/:hash/approve": { batchHash: H, itemKeys: null, edits: [] },
      "/v1/handovers/:id/assign": { successor: { type: "role_identity", roleIdentityId: uuid(401) }, inFlight: "pause", inboxStep: "google_alias" },
      "/v1/compliance/features/:feature/enable": {
        feature: "per_person_views", jurisdictions: ["CA-ON"], legalBasis: "legitimate_interest",
        dpiaAttestation: { completedOn: "2026-10-20", documentHash: "a".repeat(64), documentName: "dpia.pdf", signerName: "Maya Okafor", signerTitle: "COO" },
        noticeVersionId: uuid(703), noticePeriodDays: 14, worksAgreementRef: null, quebecActivationAck: false, purposeLock: "process_improvement",
      },
    };
    const withReq = ROUTES.filter((r) => r.request);
    expect(withReq.map((r) => r.path).sort()).toEqual(Object.keys(bodies).sort());
    for (const r of withReq) expect(check(r.request!, bodies[r.path])).toBeNull();
    // and a malformed body is rejected by the same schema
    expect(check(findRoute("POST", `/v1/batches/${H}/approve`)!.route.request!, { batchHash: "nope" })).not.toBeNull();
  });

  test("SCHEMA: lists are { items, page } with cursor paging (API.md Lists) and listAll reads every page", async () => {
    const api = createMockClient();
    const first = await api.get<{ items: unknown[]; page: { nextCursor: string | null } }>("/v1/people?limit=20");
    expect(first.items.length).toBe(20);
    expect(first.page.nextCursor).not.toBeNull();
    const second = await api.get<{ items: unknown[]; page: { nextCursor: string | null } }>(`/v1/people?limit=20&cursor=${first.page.nextCursor}`);
    expect(second.items).not.toEqual(first.items);
    expect(api.get("/v1/people?limit=0")).rejects.toMatchObject({ code: "validation_failed" });
    expect(api.get("/v1/people?limit=201")).rejects.toMatchObject({ code: "validation_failed" });
    const { listAll } = await import("../src/api/client.ts");
    const all = await listAll<{ id: string }>(api, "/v1/people");
    expect(all.length).toBe(fx.people.length);
    // listAll follows nextCursor across pages when a list is longer than one page
    const paged: string[] = [];
    const small = { ...api, get: <T,>(p: string) => { paged.push(p); return api.get<T>(p.replace("limit=200", "limit=10")); } };
    expect((await listAll(small, "/v1/people")).length).toBe(fx.people.length);
    expect(paged.length).toBe(Math.ceil(fx.people.length / 10));
  });

  test("SCHEMA: list errors use codes from error.schema.json", async () => {
    const api = createMockClient({ failures: { "GET /v1/people": "rate_limited" } });
    expect(api.get("/v1/people")).rejects.toMatchObject({ code: "rate_limited" });
    expect(api.get("/v1/nothing-here")).rejects.toMatchObject({ code: "not_found", status: 404 });
    const err = { error: { code: "rate_limited", message: "Too many requests. Wait a minute and try again." } };
    expect(check({ kind: "schema", ref: "error.schema.json" }, err)).toBeNull();
  });
});
