import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import type { DashboardResponse, EvidenceResponse, InsightsResponse, StatusResponse, TimelineResponse } from "../../src/api/types.ts";
import { createBrain, resolveToken, startBrainServer, type Brain } from "../../src/api/server.ts";
import { tempHome } from "../helpers.ts";

const TOKEN = "t".repeat(48);
const fx = tempHome();
let brain: Brain;

beforeAll(() => {
  writeFixture(fx.home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
  brain = createBrain({ home: fx.home, token: TOKEN, now: () => Date.UTC(2026, 9, 18, 20, 0) });
});
afterAll(() => fx.cleanup());

function req(path: string, init: { token?: string | null; origin?: string; method?: string; base?: string } = {}): Request {
  const headers = new Headers();
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
  if (init.origin !== undefined) headers.set("origin", init.origin);
  return new Request(`${init.base ?? "http://127.0.0.1:4545"}${path}`, { method: init.method ?? "GET", headers });
}

async function get<T>(path: string): Promise<T> {
  const res = await brain.handle(req(path));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as T;
}

describe("network policy", () => {
  test("a request without the bearer token is 401", async () => {
    expect((await brain.handle(req("/status", { token: null }))).status).toBe(401);
  });

  test("a wrong token is 401", async () => {
    expect((await brain.handle(req("/status", { token: "x".repeat(48) }))).status).toBe(401);
  });

  test("a foreign Host is 403", async () => {
    expect((await brain.handle(req("/status", { base: "http://evil.example" }))).status).toBe(403);
  });

  test("a foreign Origin is 403", async () => {
    expect((await brain.handle(req("/status", { origin: "https://evil.example" }))).status).toBe(403);
  });

  test("anything but GET is 405", async () => {
    expect((await brain.handle(req("/insights", { method: "POST" }))).status).toBe(405);
  });

  test("responses are no-store with no CORS headers", async () => {
    const res = await brain.handle(req("/status"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an unknown path is 404", async () => {
    expect((await brain.handle(req("/nope"))).status).toBe(404);
  });

  test("OFFLOAD_TOKEN is used when set, otherwise a fresh token is generated", () => {
    expect(resolveToken({ OFFLOAD_TOKEN: TOKEN })).toEqual({ token: TOKEN, generated: false });
    const gen = resolveToken({});
    expect(gen.generated).toBe(true);
    expect(gen.token.length).toBeGreaterThanOrEqual(43);
    expect(() => resolveToken({ OFFLOAD_TOKEN: "short" })).toThrow(/OFFLOAD_TOKEN/);
  });
});

describe("endpoints", () => {
  test("GET /status reports store days, retention and observer state", async () => {
    const s = await get<StatusResponse>("/status");
    expect(s.version).toBe(1);
    expect(s.store.days.length).toBe(7);
    expect(s.store.badLines).toBe(0);
    expect(s.retention.nextPurgeDay).toBe("2026-10-12");
    expect(["recording", "paused", "stale"]).toContain(s.observer.state);
    expect(s.analysis.insights).toBeGreaterThan(2);
  });

  test("GET /insights returns ranked insights with arithmetic and evidence counts", async () => {
    const r = await get<InsightsResponse>("/insights");
    const top = r.insights[0]!;
    expect(top.kind).toBe("email.outreach");
    expect(top.rank).toBe(1);
    expect(top.saving.arithmetic).toMatch(/h\/wk → review .* → saves .* h\/wk \(\d+%\)/);
    expect(top.figures.share.display).toMatch(/%$/);
    expect(top.figures.instances.eventCount).toBeGreaterThan(0);
    expect(top.connectors[0]).toMatchObject({ id: "gmail", how: "gmail-mcp", role: "primary" });
  });

  test("GET /insights?reviewSeconds= changes the saving estimate", async () => {
    const a = await get<InsightsResponse>("/insights");
    const b = await get<InsightsResponse>("/insights?reviewSeconds=40");
    expect(b.insights[0]!.saving.reviewSecondsPerItem).toBe(40);
    expect(b.insights[0]!.saving.weeklyHoursSaved).toBeLessThan(a.insights[0]!.saving.weeklyHoursSaved);
    expect((await brain.handle(req("/insights?reviewSeconds=abc"))).status).toBe(400);
  });

  test("GET /insights/:id/evidence returns the event ids behind each figure and the spans", async () => {
    const top = (await get<InsightsResponse>("/insights")).insights[0]!;
    const ev = await get<EvidenceResponse>(`/insights/${top.id}/evidence`);
    expect(ev.figures.instances.eventIds.length).toBe(top.figures.instances.eventCount);
    expect(ev.instances.length).toBe(top.figures.instances.value);
    const spanEvents = new Set(ev.spans.flatMap((s) => s.eventIds));
    for (const id of ev.figures.medianMinutes.eventIds) expect(spanEvents.has(id)).toBe(true);
  });

  test("GET /insights/:id/evidence for an unknown id is 404", async () => {
    expect((await brain.handle(req("/insights/ins_nope/evidence"))).status).toBe(404);
  });

  test("GET /timeline?day= returns that day's spans with task ids and per-task minutes", async () => {
    const t = await get<TimelineResponse>("/timeline?day=2026-10-12");
    expect(t.day).toBe("2026-10-12");
    expect(t.spans.length).toBeGreaterThan(100);
    expect(t.spans.every((s) => s.day === "2026-10-12" && s.taskId !== null)).toBe(true);
    const sum = t.byTask.reduce((n, x) => n + x.minutes, 0);
    expect(sum).toBeCloseTo(t.activeMinutes, 6);
  });

  test("GET /timeline with a malformed day is 400 and an absent day is 404", async () => {
    expect((await brain.handle(req("/timeline?day=12-10-2026"))).status).toBe(400);
    expect((await brain.handle(req("/timeline"))).status).toBe(400);
    expect((await brain.handle(req("/timeline?day=2020-01-01"))).status).toBe(404);
  });

  test("GET /dashboard lists no automations yet and suggests the top insight", async () => {
    const d = await get<DashboardResponse>("/dashboard");
    expect(d.automations).toEqual([]);
    expect(d.totals.estimatedHoursSavedPerWeek).toBe(0);
    expect(d.suggestions[0]?.name).toBe("Outreach emails");
  });
});

describe("real listener", () => {
  test("binds 127.0.0.1 only and serves with the token", async () => {
    const srv = await startBrainServer({ home: fx.home, token: TOKEN, port: 0 });
    try {
      expect(srv.hostname).toBe("127.0.0.1");
      const ok = await fetch(`${srv.url}status`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      const denied = await fetch(`${srv.url}status`);
      expect(denied.status).toBe(401);
    } finally {
      await srv.stop();
    }
  });
});
