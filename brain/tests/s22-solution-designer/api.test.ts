// API: GET /insights gains `solutions` per insight and `heldBack[]` (additive), the solutions routes.
// CLI: the real CLI on the founder week.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import { toInsights } from "../../src/api/dto.ts";
import { StubModel } from "../../src/models/model.ts";
import { withSolutions } from "../../src/solutions/service.ts";
import { cpSync } from "node:fs";
import { founder, founderLive, freshFounder, NOW, tmp } from "./setup.ts";

const TOKEN = "s".repeat(40);
const brainAt = (home: string) => createBrain({ home, token: TOKEN, now: () => NOW, workflows: { model: new StubModel(), modelLabel: "stub" } });
const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const CLI = join(import.meta.dir, "../../src/cli.ts");
function cli(...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, "run", CLI, ...args], { env: { ...process.env, OFFLOAD_KEYS: "file", OFFLOAD_TOKEN: "" } });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("s22 api", () => {
  test("API: GET /insights keeps every existing key and adds solutions per insight plus heldBack", async () => {
    const { home, a } = await founder();
    const res = await brainAt(home).handle(req("/insights"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insights: Array<Record<string, unknown>>; heldBack: Array<{ kind: string; solutions: { top: string } }> };
    const before = toInsights(a);
    expect(body.insights.length).toBe(before.insights.length);
    body.insights.forEach((i, n) => {
      const { solutions, ...rest } = i;
      expect(rest).toEqual(JSON.parse(JSON.stringify(before.insights[n])));
      expect((solutions as { top: string }).top).toBeDefined();
    });
    expect(body.insights[0]!.solutions).toMatchObject({ top: "workflow" });
    const cc = body.heldBack.find((h) => h.kind === "code.claude-code");
    expect(cc?.solutions.top).toBe("setup");
  });

  test("API: toInsights itself is unchanged (no solutions key: the v1 golden digest holds)", async () => {
    const { a } = await founder();
    for (const i of toInsights(a).insights) expect("solutions" in i).toBe(false);
    expect("heldBack" in withSolutions(a, toInsights(a))).toBe(true);
  });

  test("API: the analysis keeps insights and their order; heldBack lists tasks judged to need a person", async () => {
    const { a } = await founder();
    expect(a.insights[0]!.label.kind).toBe("email.outreach");
    for (const h of a.heldBack ?? []) {
      expect(h.judge.judgement).toBeGreaterThanOrEqual(0.8);
      expect(a.insights.some((i) => i.id === h.id)).toBe(false);
    }
  });

  test("API: GET /insights/:id/solutions returns the ranked set; unknown id 404, wrong method 405", async () => {
    const { home, a } = await founder();
    const brain = brainAt(home);
    const res = await brain.handle(req(`/insights/${a.insights[0]!.id}/solutions`));
    expect(res.status).toBe(200);
    const set = (await res.json()) as { top: string; options: unknown[]; observedWeeklyHours: number };
    expect(set.top).toBe("workflow");
    expect(set.options).toHaveLength(5);
    expect((await brain.handle(req("/insights/ins_nope/solutions"))).status).toBe(404);
    expect((await brain.handle(req(`/insights/${a.insights[0]!.id}/solutions`, "POST", {}))).status).toBe(405);
  });

  test("API: choose {kind: setup} on a held-back task writes the brief (201); approve and hand off through the routes", async () => {
    const { home, a } = await freshFounder();
    const brain = brainAt(home);
    const held = a.heldBack!.find((h) => h.label.kind === "code.claude-code")!;
    const r = await brain.handle(req(`/insights/${held.id}/solutions/choose`, "POST", { kind: "setup" }));
    expect(r.status).toBe(201);
    const { brief } = (await r.json()) as { brief: { id: string; hash: string; status: string } };
    expect(brief.status).toBe("draft");
    expect((await brain.handle(req(`/solutions/${brief.id}`))).status).toBe(200);
    expect((await brain.handle(req(`/solutions/${brief.id}/approve`, "POST", { briefHash: "f".repeat(64) }))).status).toBe(409);
    expect((await brain.handle(req(`/solutions/${brief.id}/approve`, "POST", { briefHash: brief.hash, extra: 1 }))).status).toBe(400);
    const ap = await brain.handle(req(`/solutions/${brief.id}/approve`, "POST", { briefHash: brief.hash }));
    expect(ap.status).toBe(200);
    const { token } = (await ap.json()) as { token: string };
    expect((await brain.handle(req(`/solutions/${brief.id}/handoff`, "POST", { token: "wrong" }))).status).toBe(403);
    const ho = await brain.handle(req(`/solutions/${brief.id}/handoff`, "POST", { token }));
    expect(ho.status).toBe(200);
    expect(((await ho.json()) as { builderPrompt: string }).builderPrompt).toMatch(/coding agent/i);
    expect((await brain.handle(req(`/solutions/${brief.id}/handoff`, "POST", { token }))).status).toBe(409);
  });

  test("API: choose {kind: workflow} returns the drafter's workflow detail; a bad kind is 400", async () => {
    const { home, a } = await freshFounder();
    const brain = brainAt(home);
    const r = await brain.handle(req(`/insights/${a.insights[0]!.id}/solutions/choose`, "POST", { kind: "workflow" }));
    expect(r.status).toBe(201);
    const b = (await r.json()) as { kind: string; workflow: { id: string; kind: string; skillMd: string } };
    expect(b.kind).toBe("workflow");
    expect(b.workflow.kind).toBe("email.outreach");
    expect(b.workflow.skillMd).toContain("name: investor-outreach-emails");
    // The s05 route sees the same workflow.
    expect((await brain.handle(req(`/workflows/${b.workflow.id}`))).status).toBe(200);
    expect((await brain.handle(req(`/insights/${a.insights[0]!.id}/solutions/choose`, "POST", { kind: "email" }))).status).toBe(400);
    expect((await brain.handle(req("/solutions/not-an-id"))).status).toBe(404);
  });
});

describe("s22 cli", () => {
  test("CLI: solutions --insight 1 --json on the founder week ranks workflow first, all savings within observed time", async () => {
    const home = founderLive();
    const r = cli("solutions", "--insight", "1", "--home", home, "--json");
    expect(r.code).toBe(0);
    const set = JSON.parse(r.out) as { top: string; observedWeeklyHours: number; options: Array<{ weeklyHoursSaved: number }> };
    expect(set.top).toBe("workflow");
    for (const o of set.options) expect(o.weeklyHoursSaved).toBeLessThanOrEqual(set.observedWeeklyHours);
  });

  test("CLI: --held 1 shows the coding task with setup first in plain text", async () => {
    const home = founderLive();
    const r = cli("solutions", "--held", "1", "--home", home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Coding with Claude Code (held back");
    expect(r.out).toMatch(/1\. setup/);
  });

  test("CLI: --choose setup writes a brief; approve and handoff work once", async () => {
    const home = tmp();
    cpSync(founderLive(), home, { recursive: true });
    const c = cli("solutions", "--held", "1", "--home", home, "--choose", "setup", "--json");
    expect(c.code).toBe(0);
    const { brief } = JSON.parse(c.out) as { brief: { id: string; hash: string } };
    const ap = cli("solutions", "approve", "--brief", brief.id, "--hash", brief.hash, "--home", home, "--json");
    expect(ap.code).toBe(0);
    const { token } = JSON.parse(ap.out) as { token: string };
    expect(cli("solutions", "handoff", "--brief", brief.id, "--token", token, "--home", home).code).toBe(0);
    const again = cli("solutions", "handoff", "--brief", brief.id, "--token", token, "--home", home);
    expect(again.code).toBe(2);
    expect(again.err).toContain("not approved");
  });

  test("CLI: usage errors: no subject, both subjects, a bad kind", async () => {
    const home = founderLive();
    expect(cli("solutions", "--home", home).code).toBe(2);
    expect(cli("solutions", "--insight", "1", "--held", "1", "--home", home).code).toBe(2);
    expect(cli("solutions", "--insight", "1", "--choose", "magic", "--home", home).code).toBe(2);
  });
});
