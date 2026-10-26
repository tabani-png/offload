// s23 API: GET /time on the brain's local API (brain/API.md), same network policy as every other route.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain } from "../../src/api/server.ts";
import { brainOn, call, neutralHome, TOKEN } from "./setup.ts";

const fx = neutralHome();
let brain: Brain;

beforeAll(() => {
  brain = brainOn(fx.home);
});
afterAll(() => fx.cleanup());

describe("s23 GET /time", () => {
  test("API: GET /time answers 200 JSON with the response shape", async () => {
    const r = await call(brain, "/time");
    expect(r.status).toBe(200);
    for (const k of ["version", "window", "total", "byTask", "byApp", "byKind", "findings", "fixKinds", "rounding"]) expect(k in r.body).toBe(true);
    expect(["s22", "absent"]).toContain(r.body.fixKinds);
    const f = r.body.findings[0];
    expect(f).toBeDefined();
    for (const k of ["id", "taskId", "insightId", "name", "taskMinutes", "observedHoursPerWeek", "hoursFreed", "arithmetic", "fixKind", "workflowInsightId"]) {
      expect({ k, has: k in f }).toEqual({ k, has: true });
    }
  });

  test("API: ?window=week is the default; ?day= picks one stored day", async () => {
    const a = await call(brain, "/time");
    const b = await call(brain, "/time?window=week");
    expect(b.status).toBe(200);
    expect(b.body.total.value).toBe(a.body.total.value);
    const d = await call(brain, `/time?day=${a.body.window.days[0]}`);
    expect(d.status).toBe(200);
    expect(d.body.window.kind).toBe("day");
  });

  test("API: a malformed day is 400, a day not in the store is 404, an unknown window is 400", async () => {
    expect((await call(brain, "/time?day=12-10-2026")).status).toBe(400);
    expect((await call(brain, "/time?day=2026-01-01")).status).toBe(404);
    expect((await call(brain, "/time?window=month")).status).toBe(400);
  });

  test("API: no token is 401, a foreign Host is 403, POST is 405", async () => {
    expect((await brain.handle(new Request("http://127.0.0.1:4545/time"))).status).toBe(401);
    const foreign = new Request("http://evil.example/time", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await brain.handle(foreign)).status).toBe(403);
    expect((await call(brain, "/time", "POST")).status).toBe(405);
  });

  test("API: brain/API.md documents GET /time, its rounding rule and the fix-kind fallback", () => {
    const doc = readFileSync(join(import.meta.dir, "../../API.md"), "utf8");
    expect(doc).toMatch(/^## GET \/time/m);
    expect(doc).toContain("tenths-half-up");
    expect(doc).toMatch(/fixKind[^\n]*null/);
  });

  test("API: the response types are exported from api/types.ts", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/api/types.ts"), "utf8");
    for (const t of ["TimeBreakdownResponse", "TimeMetric", "TimeRow", "TimeFinding"]) expect(src).toMatch(new RegExp(`export (interface|type) ${t}\\b`));
  });
});
