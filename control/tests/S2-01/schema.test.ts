import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";
import { createValidator, STAGE2_SCHEMA_DIR } from "../../src/schema/registry.ts";
import { send } from "../../src/schema/http.ts";

let h: Harness;
let admin: Client;
beforeAll(async () => {
  h = await createHarness();
  admin = await asPrincipal(h, "admin");
});
afterAll(() => h.close());

describe("SCHEMA", () => {
  test("SCHEMA: every schemas/stage2 file is loaded by its $id", () => {
    const v = createValidator();
    const files = readdirSync(STAGE2_SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"));
    for (const f of files) {
      const { $id } = JSON.parse(readFileSync(`${STAGE2_SCHEMA_DIR}/${f}`, "utf8"));
      expect(v.ids).toContain($id);
      expect(() => v.validate($id, {})).not.toThrow();
    }
    expect(files.length).toBeGreaterThanOrEqual(39);
  });

  test("SCHEMA: an unknown field is 400 validation_failed", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/v1/departments", { name: "X", colour: "red" }],
      ["PATCH", "/v1/tenant", { groupFloor: 6, plan: "pro" }],
      ["POST", "/v1/people/invite", { email: "a@b.co", displayName: "A", departmentId: null, jurisdiction: "GB", role: "owner" }],
      ["PATCH", `/v1/people/${h.a.people.member.id}`, { state: "departed" }],
      ["POST", "/v1/devices/enrollment-codes", { forever: true }],
    ];
    for (const [m, p, b] of cases) {
      const r = await admin.send(m, p, b);
      expect({ p, status: r.status, code: r.json?.error?.code }).toEqual({ p, status: 400, code: "validation_failed" });
    }
    const enroll = await h.request("POST", "/v1/devices/enroll", {
      body: { enrollmentCode: "x".repeat(40), deviceName: "M", appVersion: "1", publicKeyJwk: { kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret" } },
    });
    expect(enroll.status).toBe(400);
    const owner = await asPrincipal(h, "owner");
    expect((await owner.post("/v1/support-grants", { hours: 1, scope: "all" })).json.error.code).toBe("validation_failed");
  });

  test("SCHEMA: malformed JSON and wrong types are 400", async () => {
    expect((await admin.send("POST", "/v1/departments", "{not json")).status).toBe(400);
    expect((await admin.post("/v1/departments", { name: 42 })).status).toBe(400);
    expect((await admin.post("/v1/departments", { name: "" })).status).toBe(400);
    expect((await admin.post("/v1/people/invite", { email: "not-an-email", displayName: "A", departmentId: null, jurisdiction: "GB" })).status).toBe(400);
    expect((await admin.patch(`/v1/people/${h.a.people.member.id}`, { jurisdiction: "canada" })).status).toBe(400);
  });

  test("SCHEMA: error bodies match error.schema.json for 400, 401, 403, 404 and 409", async () => {
    const v = createValidator();
    const responses = [
      await admin.post("/v1/departments", {}),
      await h.request("GET", "/v1/tenant"),
      await admin.get("/v1/audit-log/verify"),
      await admin.get(`/v1/people/${crypto.randomUUID()}`),
      await admin.patch("/v1/tenant", { groupFloor: 5, retention: { perPersonDays: 90 } }).then(async () =>
        admin.patch(`/v1/departments/${h.a.departments.sales}`, { directoryGroups: ["g1"] }).then(() =>
          admin.post("/v1/departments", { name: "Dup", directoryGroups: ["g1"] }),
        ),
      ),
      await h.request("GET", "/v1/not-a-route"),
      await admin.get("/v1/people/%E0%A4%A"),
    ];
    expect(responses.map((r) => r.status)).toEqual([400, 401, 403, 404, 409, 404, 404]);
    for (const r of responses) expect(v.validate("offload/stage2/error.schema.json", r.json)).toEqual({ ok: true });
  });

  test("SCHEMA: list limits are 1..200 and lists page with a cursor", async () => {
    expect((await admin.get("/v1/departments?limit=0")).status).toBe(400);
    expect((await admin.get("/v1/departments?limit=201")).status).toBe(400);
    expect((await admin.get("/v1/departments?cursor=%%%")).status).toBe(400);
    for (const n of ["P1", "P2", "P3"]) await admin.post("/v1/departments", { name: n });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { json: { items: Array<{ id: string }>; page: { nextCursor: string | null } } } = await admin.get(
        `/v1/departments?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...r.json.items.map((d) => d.id));
      cursor = r.json.page.nextCursor;
    } while (cursor);
    const all = await admin.get("/v1/departments?limit=200");
    expect(seen).toEqual(all.json.items.map((d: { id: string }) => d.id));
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  test("SCHEMA: a response that breaks its schema is a server error, not a silent pass", async () => {
    const v = createValidator();
    const app = new Hono();
    app.get("/x", (c) => send(c, v, true, 200, { id: "not-a-uuid" }, "offload/stage2/tenant.schema.json"));
    app.onError((e, c) => c.text(e.message, 500));
    const r = await app.request("http://t/x");
    expect(r.status).toBe(500);
    expect(await r.text()).toContain("does not match offload/stage2/tenant.schema.json");
  });

  test("SCHEMA: successful responses validate against their schemas", async () => {
    const v = createValidator();
    const owner = await asPrincipal(h, "owner");
    const checks: Array<[string, string]> = [
      ["/v1/tenant", "offload/stage2/tenant.schema.json"],
      [`/v1/people/${h.a.people.lead.id}`, "offload/stage2/person.schema.json"],
      ["/v1/people", "offload/control/person-list.json"],
      ["/v1/departments", "offload/control/department-list.json"],
      ["/v1/job-roles", "offload/control/job-role-list.json"],
      ["/v1/role-identities", "offload/control/role-identity-list.json"],
      ["/v1/devices", "offload/control/device-list.json"],
      ["/v1/audit-log", "offload/control/audit-event-list.json"],
      ["/auth/session", "offload/control/auth-session.json"],
    ];
    for (const [path, ref] of checks) {
      const r = await owner.get(path);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
      expect({ path, v: v.validate(ref, r.json) }).toEqual({ path, v: { ok: true } });
    }
  });
});
