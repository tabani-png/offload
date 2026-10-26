// CLI / API: the real CLI and the real routes, prepare -> approve -> dry-run build -> record, with the recorded fake SDK.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Analysis } from "../../src/analyze.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { solutionsRoute } from "../../src/solutions/routes.ts";
import { chooseSolution, designSolutions } from "../../src/solutions/service.ts";
import { founderLive, freshFounder, NOW } from "../s22-solution-designer/setup.ts";
import { query as fakeSdk } from "./fake-sdk.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const FAKE = join(import.meta.dir, "fake-sdk.ts");

function cli(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, "run", CLI, ...args], { env: { ...process.env, OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("s24 CLI", () => {
  test("CLI: build --solution held:1 --option 1 writes the brief and frozen checks; approve; run (dry run); record", () => {
    const home = founderLive();
    const prep = cli(["build", "--solution", "held:1", "--option", "1", "--home", home, "--json"]);
    expect(prep.err).toBe("");
    expect(prep.code).toBe(0);
    const p = JSON.parse(prep.out);
    expect(p.briefId).toMatch(/^sol_/);
    expect(p.checks.sha256).toMatch(/^[0-9a-f]{64}$/);
    const noTok = cli(["build", "run", "--brief", p.briefId, "--token", "wrong", "--home", home], { OFFLOAD_BUILDER_FAKE_SDK: FAKE, NODE_ENV: "test" });
    expect(noTok.code).toBe(2);
    expect(noTok.err).toContain("no build approval");
    const ap = cli(["build", "approve", "--brief", p.briefId, "--brief-hash", p.briefHash, "--check-hash", p.checks.sha256, "--home", home, "--json"]);
    expect(ap.code).toBe(0);
    const { token } = JSON.parse(ap.out);
    const run = cli(["build", "run", "--brief", p.briefId, "--token", token, "--home", home, "--json"], { OFFLOAD_BUILDER_FAKE_SDK: FAKE, NODE_ENV: "test" });
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const rec = JSON.parse(run.out);
    expect(rec).toMatchObject({ outcome: "PASS", dryRun: true, briefId: p.briefId, checkHash: p.checks.sha256 });
    const got = cli(["build", "record", "--run", rec.id, "--home", home]);
    expect(JSON.parse(got.out)).toEqual(rec);
    // The token was used.
    expect(cli(["build", "run", "--brief", p.briefId, "--token", token, "--home", home], { OFFLOAD_BUILDER_FAKE_SDK: FAKE, NODE_ENV: "test" }).code).toBe(2);
  }, 60_000);

  test("CLI: a workflow option has no brief to build", () => {
    const home = founderLive();
    const r = cli(["build", "--solution", "1", "--option", "1", "--home", home]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("only tool, setup and remove_step");
  }, 60_000);
});

describe("s24 API", () => {
  async function setupApi() {
    const { home, a } = await freshFounder();
    const stub = new StubModel();
    const { set } = await designSolutions({ analysis: a, ref: "held:1", model: stub, models: DEFAULT_MODELS });
    const r = await chooseSolution({ home, analysis: a, set, kind: "setup", model: stub, models: DEFAULT_MODELS, now: () => NOW });
    if (r.kind === "workflow") throw new Error("expected a brief");
    const ctx = { home, env: {}, model: stub, modelLabel: "stub" as const, now: () => NOW, analysis: async (): Promise<Analysis> => a, models: { ...DEFAULT_MODELS }, buildQuery: fakeSdk };
    const call = async (method: string, path: string, body?: unknown) => {
      const req = new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
      const res = (await solutionsRoute(req, path, ctx))!;
      return { status: res.status, body: (await res.json()) as any };
    };
    return { brief: r.brief, subjectId: set.subjectId, call };
  }

  test("API: POST checks -> approve {briefHash, checkHash} -> POST build {token} -> GET /builds/:id; option shows build cost", async () => {
    const { brief, subjectId, call } = await setupApi();
    const c = await call("POST", `/solutions/${brief.id}/checks`);
    expect(c.status).toBe(201);
    const checkHash = c.body.set.sha256;
    expect((await call("POST", `/solutions/${brief.id}/build`, { token: "nope" })).status).toBe(403);
    expect((await call("POST", `/solutions/${brief.id}/build/approve`, { briefHash: brief.hash, checkHash: "a".repeat(64) })).status).toBe(409);
    const ap = await call("POST", `/solutions/${brief.id}/build/approve`, { briefHash: brief.hash, checkHash });
    expect(ap.status).toBe(200);
    const b = await call("POST", `/solutions/${brief.id}/build`, { token: ap.body.token });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ outcome: "PASS", dryRun: true });
    const g = await call("GET", `/builds/${b.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body).toEqual(b.body);
    expect((await call("GET", "/builds/run_doesnotexist00")).status).toBe(404);
    const sol = await call("GET", `/insights/${subjectId}/solutions`);
    const setup = sol.body.options.find((o: any) => o.kind === "setup");
    expect(setup.build).toMatchObject({ runId: b.body.id, outcome: "PASS", costUsd: 0.08 });
    // existing keys unchanged
    expect(Object.keys(setup)).toEqual(expect.arrayContaining(["kind", "what", "why", "weeklyHoursSaved", "share", "arithmetic", "effort", "confidence", "evidence", "handoff"]));
  });

  test("API: the existing s22 brief routes still answer (approve / handoff untouched)", async () => {
    const { brief, call } = await setupApi();
    expect((await call("GET", `/solutions/${brief.id}`)).body.hash).toBe(brief.hash);
    expect((await call("POST", `/solutions/${brief.id}/approve`, { briefHash: brief.hash })).status).toBe(200);
  });
});
