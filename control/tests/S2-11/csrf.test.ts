import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The web's real fetch layer (the one every screen uses), pointed at the real app.
import { ApiError, createHttpClient, type ApiClient } from "../../../web/src/api/client.ts";
import { buildWorld, type World } from "./world.ts";

let w: World;

interface Sent {
  method: string;
  path: string;
  csrf: string | null;
  status: number;
}

/** A browser tab: the web client with the person's session cookie, every request recorded. */
async function tab(who: string): Promise<{ api: ApiClient; sent: Sent[]; csrf: string }> {
  const { cookie, csrf } = await w.as(who).cred();
  const sent: Sent[] = [];
  const api = createHttpClient("", async (input, init) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    const res = await w.h.app.request(`http://control.test${input}`, { ...init, headers });
    sent.push({ method: init.method ?? "GET", path: input, csrf: headers.get("x-csrf-token"), status: res.status });
    return res;
  });
  return { api, sent, csrf };
}

beforeAll(async () => {
  w = await buildWorld();
}, 60_000);
afterAll(() => w.close());

const raw = async (who: string, method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const { cookie } = await w.as(who).cred();
  return w.h.request(method, path, { body, headers: { Cookie: cookie, ...headers } });
};

describe("CSRF on every mutation", () => {
  test("CSRF: every mutation the web client sends carries the session's X-CSRF-Token, and the API accepts it", async () => {
    const owner = await tab("owner");
    await owner.api.post("/v1/compliance/notices", {
      template: "custom", title: "Draft v2", markdown: "# Draft", features: ["workflow_metrics"], jurisdictions: [],
    });
    await owner.api.patch(`/v1/departments/${w.depts.legal}`, { name: "Legal and compliance" });
    await owner.api.post("/v1/me/correction-requests", { field: "person.displayName", message: "Please use my full name." });
    const member = await tab("member");
    await member.api.post(`/v1/batches/${w.pendingBatch}/reject`, { reason: "Not this week" });
    const devices = await member.api.get<{ items: Array<{ id: string }> }>("/v1/devices");
    await member.api.delete(`/v1/devices/${devices.items[0]!.id}`);

    const mutations = [...owner.sent, ...member.sent].filter((s) => s.method !== "GET");
    expect(mutations.map((m) => m.method).sort()).toEqual(["DELETE", "PATCH", "POST", "POST", "POST"]);
    for (const m of owner.sent.filter((s) => s.method !== "GET")) expect(m.csrf).toBe(owner.csrf);
    for (const m of member.sent.filter((s) => s.method !== "GET")) expect(m.csrf).toBe(member.csrf);
    for (const m of mutations) expect(m.status).toBeLessThan(300);
    // The token came from GET /auth/session, once per tab.
    expect(owner.sent.filter((s) => s.path === "/auth/session").length).toBe(1);
  });

  test("CSRF: a mutation without the header is 403 and changes nothing", async () => {
    const before = (await w.as("owner").get("/v1/compliance/notices?limit=200")).json.items.length;
    const r = await raw("owner", "POST", "/v1/compliance/notices", {
      template: "custom", title: "Sneaky", markdown: "# x", features: ["workflow_metrics"], jurisdictions: [],
    });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("forbidden");
    expect((await w.as("owner").get("/v1/compliance/notices?limit=200")).json.items.length).toBe(before);
    for (const [method, path, body] of [
      ["PATCH", `/v1/departments/${w.depts.sales}`, { name: "Renamed" }],
      ["POST", "/v1/me/correction-requests", { field: "x", message: "y" }],
      ["POST", `/v1/compliance/features/per_person_views/disable`, {}],
      ["DELETE", `/v1/kill-switches/tenant/${w.t.id}`, undefined],
    ] as const) {
      const x = await raw("admin", method, path, body);
      expect(x.status).toBe(403);
    }
    const d = (await w.as("admin").get("/v1/departments?limit=200")).json.items.find((x: { id: string }) => x.id === w.depts.sales);
    expect(d.name).toBe("Sales");
  });

  test("CSRF: a wrong token, or another session's token, is 403", async () => {
    const other = await w.as("member2").cred();
    for (const token of ["nope", other.csrf, ""]) {
      const r = await raw("admin", "PATCH", `/v1/departments/${w.depts.sales}`, { name: "Renamed" }, { "X-CSRF-Token": token });
      expect(r.status).toBe(403);
    }
  });

  test("CSRF: the web client surfaces a rejected mutation as plain words, not a crash", async () => {
    const { cookie } = await w.as("owner").cred();
    // A tab whose fetch drops the header the client set (as a proxy stripping it would): the server refuses.
    const api = createHttpClient("", async (input, init) => {
      const headers = new Headers(init.headers);
      headers.delete("x-csrf-token");
      headers.set("cookie", cookie);
      return w.h.app.request(`http://control.test${input}`, { ...init, headers });
    });
    const err = await api.post("/v1/me/correction-requests", { field: "x", message: "y" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("forbidden");
    expect((err as ApiError).status).toBe(403);
  });

  test("CSRF: reads need no token (GET is not a mutation)", async () => {
    const { cookie } = await w.as("auditor").cred();
    const r = await w.h.request("GET", "/v1/tenant", { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
  });
});
