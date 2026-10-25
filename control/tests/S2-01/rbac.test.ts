import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asDevice, asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import {
  COLUMNS, PERMISSIONS, authorize, matchPermission, parseCell, permissionKey, type Column, type Permission,
} from "../../src/rbac/permissions.ts";

const API_MD = join(import.meta.dir, "../../../plan/stage-2/API.md");
const METHODS = "GET|POST|PUT|PATCH|DELETE";

/** Expands the first cell of every API.md matrix row ("GET/POST /v1/x, PATCH/DELETE /:id", "/resume", ...). */
function apiRows(): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(API_MD, "utf8").split("\n")) {
    const m = new RegExp(`^\\| ((?:${METHODS})[ /].*?) \\|`).exec(line);
    if (!m) continue;
    let methods: string[] = [];
    let path = "";
    let base = "";
    for (const part of m[1]!.split(/,\s*/)) {
      const pm = new RegExp(`^((?:${METHODS})(?:/(?:${METHODS}))*)?\\s*(\\S+)?$`).exec(part.trim());
      if (!pm) throw new Error(`cannot parse ${part}`);
      if (pm[1]) methods = pm[1].split("/");
      if (pm[2]) {
        const p = pm[2].replace(/\?.*$/, "");
        if (p.startsWith("/v1") || p.startsWith("/auth") || p.startsWith("/webhooks")) {
          path = p;
          base = p;
        } else if (p.startsWith("/:")) path = base + p;
        else path = path.replace(/\/[^/]+$/, p);
      }
      for (const meth of methods) out.add(`${meth} ${path}`);
    }
  }
  return out;
}

function samplePath(p: Permission): string {
  const filled = p.path
    .replace(/:hash/g, "a".repeat(64))
    .replace(/:scope/g, "person")
    .replace(/:feature/g, "working_time")
    .replace(/:v\b|:version/g, "1")
    .replace(/:token/g, "tok")
    .replace(/:[a-zA-Z]+/g, () => crypto.randomUUID());
  if (p.variant === "scope=person") return `${filled}?scope=person:${crypto.randomUUID()}`;
  if (p.variant === "scope=group") return `${filled}?scope=company`;
  return filled;
}

let h: Harness;
type Send = (method: string, path: string, body?: unknown) => Promise<{ status: number }>;
const callers = {} as Record<Column, Send>;

beforeAll(async () => {
  h = await createHarness();
  const map: Record<Exclude<Column, "device">, "owner" | "admin" | "lead" | "member" | "auditor"> = {
    owner: "owner", admin: "admin", dept_lead: "lead", member: "member", auditor: "auditor",
  };
  for (const [col, who] of Object.entries(map)) {
    const c = await asPrincipal(h, who);
    callers[col as Column] = (method, path, body) => c.send(method, path, body);
  }
  const dev = await enrollDevice(h, await asPrincipal(h, "member2"));
  const d = asDevice(h, dev.token);
  callers.device = (method, path, body) => d(method, path, body);
});
afterAll(() => h.close());

describe("RBAC matrix data", () => {
  test("RBAC: every endpoint of API.md is a row in permissions.ts and nothing else is", () => {
    const api = apiRows();
    const ours = new Set(PERMISSIONS.map((p) => `${p.method} ${p.path}`));
    expect([...api].filter((k) => !ours.has(k))).toEqual([]);
    expect([...ours].filter((k) => !api.has(k))).toEqual([]);
    expect(api.size).toBeGreaterThan(80);
  });

  test("RBAC: every cell is a valid T/Dp/S/F:x/- value and keys are unique", () => {
    const keys = new Set<string>();
    for (const p of PERMISSIONS) {
      expect(keys.has(permissionKey(p))).toBe(false);
      keys.add(permissionKey(p));
      for (const col of COLUMNS) expect(() => parseCell(p.roles[col])).not.toThrow();
      if (p.auth !== "principal") expect(Object.values(p.roles).every((c) => c === "-")).toBe(true);
    }
  });

  test("RBAC: spot checks against API.md", () => {
    const cell = (k: string, col: Column) => matchPermission(k.split(" ")[0]!, k.split(" ")[1]!.split("?")[0]!, new URLSearchParams(k.split("?")[1] ?? ""))!.perm.roles[col];
    expect(cell("POST /v1/support-grants", "owner")).toBe("T");
    expect(cell("POST /v1/support-grants", "admin")).toBe("-");
    expect(cell("GET /v1/people", "dept_lead")).toBe("Dp");
    expect(cell("GET /v1/people/x", "member")).toBe("S");
    expect(cell("GET /v1/audit-log/verify", "admin")).toBe("-");
    expect(cell("GET /v1/metrics/hours-saved?scope=person:x", "admin")).toBe("F:per_person_views");
    expect(cell("GET /v1/metrics/hours-saved?scope=company", "member")).toBe("-");
    expect(cell("GET /v1/metrics/working-time?scope=person:x", "member")).toBe("S+F:working_time");
    expect(cell("POST /v1/sync/batches", "device")).toBe("S");
    expect(cell("POST /v1/people/invite", "admin")).toBe("T");
  });
});

describe("RBAC authorize()", () => {
  const lead = { column: "dept_lead" as const, personId: "p-lead", departmentScope: ["d-sales"] };
  const member = { column: "member" as const, personId: "p-mem", departmentScope: [] };
  const none = new Set<never>();

  test("RBAC: deny is the default for unknown actions, credential rows and the service role", () => {
    expect(authorize(member, "GET /v1/nope", null, none)).toMatchObject({ allow: false, status: 403 });
    expect(authorize(member, "POST /v1/devices/enroll", null, none)).toMatchObject({ allow: false, status: 403 });
    expect(authorize({ column: "service", personId: null, departmentScope: [] }, "GET /v1/tenant", null, none)).toMatchObject({ allow: false });
  });

  test("RBAC: Dp allows own departments and hides others as 404", () => {
    expect(authorize(lead, "GET /v1/people/:id", { personId: "x", departmentId: "d-sales" }, none)).toEqual({ allow: true, scope: "Dp" });
    expect(authorize(lead, "GET /v1/people/:id", { personId: "x", departmentId: "d-fin" }, none)).toEqual({ allow: false, status: 404, code: "not_found" });
    expect(authorize(lead, "GET /v1/people", null, none)).toEqual({ allow: true, scope: "Dp" });
  });

  test("RBAC: S allows only the principal's own resources", () => {
    expect(authorize(member, "GET /v1/people/:id", { personId: "p-mem" }, none)).toEqual({ allow: true, scope: "S" });
    expect(authorize(member, "GET /v1/people/:id", { personId: "p-other" }, none)).toMatchObject({ allow: false, status: 404 });
  });

  test("RBAC: F:x cells need the sensitive feature enabled for the subject", () => {
    const admin = { column: "admin" as const, personId: "p-a", departmentScope: [] };
    const k = "GET /v1/metrics/hours-saved [scope=person]";
    expect(authorize(admin, k, { personId: "x" }, none)).toEqual({ allow: false, status: 403, code: "feature_disabled" });
    expect(authorize(admin, k, { personId: "x" }, new Set(["per_person_views"] as const))).toEqual({ allow: true, scope: "T" });
    const wt = "GET /v1/metrics/working-time [scope=person]";
    expect(authorize(admin, wt, { personId: "x" }, new Set(["working_time"] as const))).toMatchObject({ code: "feature_disabled" });
    expect(authorize(member, wt, { personId: "p-mem" }, new Set(["working_time"] as const))).toEqual({ allow: true, scope: "S" });
    expect(authorize(lead, k, { departmentId: "d-fin" }, new Set(["per_person_views"] as const))).toMatchObject({ status: 404 });
  });

  test("RBAC: '-' is 403 forbidden whatever the resource", () => {
    expect(authorize(member, "GET /v1/audit-log", null, none)).toEqual({ allow: false, status: 403, code: "forbidden" });
  });
});

describe("RBAC every row x every access role over HTTP", () => {
  for (const p of PERMISSIONS) {
    if (p.auth !== "principal") {
      test(`RBAC: ${permissionKey(p)} (${p.auth}) needs no session and is never role-gated`, async () => {
        const body = p.method === "GET" || p.method === "DELETE" ? undefined : {};
        const anon = await h.request(p.method, samplePath(p), body !== undefined ? { body } : {});
        expect(anon.status).not.toBe(403);
        expect((await callers.member(p.method, samplePath(p), body)).status).not.toBe(403);
      });
      continue;
    }
    test(`RBAC: ${permissionKey(p)} is enforced for every access role`, async () => {
      const results: Record<string, number> = {};
      const expected: Record<string, string> = {};
      for (const col of COLUMNS) {
        const body = p.method === "GET" || p.method === "DELETE" ? undefined : {};
        const r = await callers[col](p.method, samplePath(p), body);
        const allowed = parseCell(p.roles[col]).scope !== null;
        results[col] = r.status;
        expected[col] = allowed ? "not 403" : "403";
      }
      const actual = Object.fromEntries(
        COLUMNS.map((c) => [c, results[c] === 403 ? "403" : results[c] === 401 ? `401` : "not 403"]),
      );
      expect(actual).toEqual(expected);
    });
  }
});
