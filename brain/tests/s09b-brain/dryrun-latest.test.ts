// s09b: GET /workflows/:id/dry-runs/latest returns the last sealed dry run (opened for the response only), so reopening
// the review window does not pay for a new one. 404 when there is none, or it was purged.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DryRunResponse, ErrorResponse } from "../../src/api/types.ts";
import { local, s09bWorld, type S09bWorld } from "./setup.ts";

let w: S09bWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const latest = (id: string) => `/workflows/${id}/dry-runs/latest`;

describe("s09b last dry run", () => {
  test("LATEST: 404 not_found before any dry run", async () => {
    w = await s09bWorld();
    const r = await w.call<ErrorResponse>(latest(w.outreach.id));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });

  test("LATEST: returns the dry run exactly as POST dry-run answered it, without a model call; the file stays sealed", async () => {
    w = await s09bWorld();
    const id = w.outreach.id;
    const dry = await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 2 } });
    expect(dry.status).toBe(200);
    const calls = w.model.calls.length;
    const r = await w.call<DryRunResponse>(latest(id));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(dry.body);
    expect(w.model.calls.length).toBe(calls);
    const sealed = readFileSync(join(w.home, "workflows", id, "dry-run.json.enc"), "utf8");
    expect(sealed.startsWith("OBV1 ")).toBe(true);
    expect(sealed).not.toContain(dry.body.instances[0]!.recipient.email);
  });

  test("LATEST: after two dry runs it is the second one", async () => {
    w = await s09bWorld();
    const id = w.outreach.id;
    await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 1 } });
    w.clock.now += 60_000;
    const second = await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 3 } });
    const r = await w.call<DryRunResponse>(latest(id));
    expect(r.body.ranAt).toBe(second.body.ranAt);
    expect(r.body.instances.length).toBe(second.body.instances.length);
  });

  test("LATEST: 404 once the dry run is older than 30 local days (purged), and the sealed file is gone", async () => {
    w = await s09bWorld();
    const id = w.outreach.id;
    await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 1 } });
    w.clock.now = local(2026, 11, 20, 9, 0);
    const r = await w.call<ErrorResponse>(latest(id));
    expect(r.status).toBe(404);
    expect(existsSync(join(w.home, "workflows", id, "dry-run.json.enc"))).toBe(false);
  });

  test("LATEST: 404 when the sealed file was removed by the purge; unknown workflow 404; POST 405", async () => {
    w = await s09bWorld();
    const id = w.outreach.id;
    await w.call<DryRunResponse>(`/workflows/${id}/dry-run`, { method: "POST", body: { limit: 1 } });
    rmSync(join(w.home, "workflows", id, "dry-run.json.enc"));
    expect((await w.call<ErrorResponse>(latest(id))).status).toBe(404);
    expect((await w.call<ErrorResponse>(latest("wf_nope"))).status).toBe(404);
    expect((await w.call<ErrorResponse>(latest(id), { method: "POST" })).status).toBe(405);
    expect((await w.call<ErrorResponse>(`/workflows/${id}/dry-runs/first`)).status).toBe(404);
  });
});
