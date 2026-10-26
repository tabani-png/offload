// LOOP / CAPS / TAMPER / RECORD: the runner (code) runs the frozen check after each SDK try; done = exit 0.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { readRunRecord, withBuildCosts } from "../../src/builder/record.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { rulesSolutions } from "../../src/solutions/rules.ts";
import { buildFixture, LINKEDIN_IMAGE } from "../s22-solution-designer/fixtures.ts";
import { fakeQuery, NOW, prepared, writeSlug, type FakeTry } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

async function build(tries: FakeTry[], limits = {}) {
  const p = await prepared();
  const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
  const f = fakeQuery(tries);
  const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits });
  return { p, rec, seen: f.seen };
}

describe("s24 builder loop", () => {
  test("LOOP: a builder that gets it right passes on try 1 and the files stay in the workspace (dry run)", async () => {
    const { rec, seen } = await build([{ act: writeSlug("good") }]);
    expect(rec.outcome).toBe("PASS");
    expect(rec.tries).toHaveLength(1);
    expect(rec.tries[0]!.checkExit).toBe(0);
    expect(rec.tries[0]!.checkOutput).toContain("PASS slug('Hello World') = 'hello-world'");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.cwd).toBe(rec.artifactPath);
    expect(existsSync(join(rec.artifactPath, "slug.py"))).toBe(true);
    expect(rec.dryRun).toBe(true);
  });

  test("LOOP: fail on try 1, then pass on try 2 with the exact check failure output fed back", async () => {
    const { rec, seen } = await build([{ act: writeSlug("bad") }, { act: writeSlug("good") }]);
    expect(rec.outcome).toBe("PASS");
    expect(rec.tries.map((t) => t.checkExit)).toEqual([1, 0]);
    const failure = rec.tries[0]!.checkOutput;
    expect(failure).toContain("FAIL slug('Hello World') = 'Hello-World', want 'hello-world'");
    expect(seen[0]!.prompt).not.toContain("<check_output>");
    expect(seen[1]!.prompt).toContain(`<check_output>\n${failure}\n</check_output>`);
  });

  test("LOOP: the builder prompt carries the brief's prompt, inputs, outputs and the read-only check path", async () => {
    const { p, seen } = await build([{ act: writeSlug("good") }]);
    const brief = JSON.parse(readFileSync(join(p.home, "solutions", p.briefId, "brief.json"), "utf8"));
    expect(seen[0]!.prompt).toContain(brief.spec.builderPrompt);
    for (const i of brief.spec.inputs) expect(seen[0]!.prompt).toContain(i);
    expect(seen[0]!.prompt).toContain("accept/accept.py (read-only)");
  });

  test("CAPS: a builder that never passes stops at maxTries with outcome CAP", async () => {
    const { rec, seen } = await build([{ act: writeSlug("bad") }], { maxTries: 2 });
    expect(rec.outcome).toBe("CAP");
    expect(rec.reason).toContain("2 tries");
    expect(seen).toHaveLength(2);
    expect(rec.tries.every((t) => t.checkExit === 1)).toBe(true);
  });

  test("CAPS: the default is 3 tries", async () => {
    const { rec } = await build([{ act: writeSlug("bad") }]);
    expect(rec.outcome).toBe("CAP");
    expect(rec.tries).toHaveLength(3);
    expect(rec.profile.limits).toMatchObject({ maxTries: 3, maxUsd: 1 });
  });

  test("CAPS: the cost cap stops before the next try, and the SDK gets only the remaining budget", async () => {
    const { rec, seen } = await build([{ act: writeSlug("bad"), costUsd: 0.6 }], { maxUsd: 1, maxTries: 5 });
    expect(rec.outcome).toBe("CAP");
    expect(rec.reason).toContain("cost cap");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.options.maxBudgetUsd).toBe(1);
    expect(seen[1]!.options.maxBudgetUsd).toBeCloseTo(0.4, 6);
    expect(rec.totals.costUsd).toBeCloseTo(1.2, 6);
  });

  test("CAPS: max turns per try and wall time reach the SDK", async () => {
    const { seen } = await build([{ act: writeSlug("good") }], { maxTurns: 7 });
    expect(seen[0]!.options.maxTurns).toBe(7);
    expect(seen[0]!.options.abortController).toBeInstanceOf(AbortController);
  });

  test("CAPS: a wall-time abort during a try ends the run as CAP", async () => {
    const { rec } = await build([{ act: (ws, o) => { writeSlug("bad")(ws); o.abortController!.abort(); } }], { maxTries: 3 });
    expect(rec.outcome).toBe("CAP");
    expect(rec.reason).toContain("wall time");
  });

  test("TAMPER: a builder that edits the check file ends the run as TAMPER and the check never runs", async () => {
    const { rec, seen } = await build([
      {
        act: (ws) => {
          writeSlug("bad")(ws);
          const f = join(ws, "accept", "accept.py");
          chmodSync(f, 0o644); // a bypass-mode builder ignores modes
          writeFileSync(f, "import sys\nsys.exit(0)\n");
        },
      },
    ]);
    expect(rec.outcome).toBe("TAMPER");
    expect(rec.tries[0]!.checkHashOk).toBe(false);
    expect(rec.tries[0]!.checkExit).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("TAMPER: deleting the check file is tamper too", async () => {
    const { rec } = await build([{ act: (ws) => { const { rmSync } = require("node:fs"); rmSync(join(ws, "accept", "accept.py"), { force: true }); } }]);
    expect(rec.outcome).toBe("TAMPER");
  });

  test("TAMPER: the allowlist the SDK gets denies writes and edits under accept/", async () => {
    const { seen } = await build([{ act: writeSlug("good") }]);
    const can = seen[0]!.options.canUseTool!;
    const ws = seen[0]!.options.cwd!;
    const opts = { signal: new AbortController().signal, toolUseID: "t1" } as never;
    expect((await can("Write", { file_path: join(ws, "accept", "accept.py"), content: "x" }, opts))?.behavior).toBe("deny");
    expect((await can("Edit", { file_path: "accept/accept.py", old_string: "a", new_string: "b" }, opts))?.behavior).toBe("deny");
    expect((await can("Bash", { command: "mv accept/accept.py x.py" }, opts))?.behavior).toBe("deny");
    expect((await can("Write", { file_path: join(ws, "slug.py"), content: "x" }, opts))?.behavior).toBe("allow");
  });

  test("LOOP: an SDK error ends the run as FAIL with the reason", async () => {
    const { rec } = await build([{ throws: "process exited 1" }]);
    expect(rec.outcome).toBe("FAIL");
    expect(rec.reason).toContain("process exited 1");
  });

  test("RECORD: the run record is written once with every field", async () => {
    const { p, rec } = await build([{ act: writeSlug("bad"), costUsd: 0.04 }, { act: writeSlug("good"), costUsd: 0.07 }]);
    const disk = readRunRecord(p.home, rec.id)!;
    expect(disk).toEqual(rec);
    expect(disk).toMatchObject({ version: 1, briefId: p.briefId, briefHash: p.briefHash, checkHash: p.checkHash, checkFile: "accept.py", dryRun: true, outcome: "PASS", reason: null });
    expect(disk.models).toEqual({ checkWriter: "router:build_checks", builder: "claude-sonnet-5-5", reported: ["claude-sonnet-5-5"] });
    expect(disk.versions.sdk).toMatch(/^\d+\.\d+\.\d+/);
    expect(disk.versions.claudeCode).toBe("2.1.310");
    expect(disk.profile).toMatchObject({ mode: "allowlist", containerSandbox: false });
    expect(disk.profile.tools).not.toContain("WebFetch");
    expect(disk.totals).toEqual({ costUsd: 0.11, turns: 8, tokens: { input: 2400, output: 600, cacheRead: 100 } });
    for (const t of disk.tries) expect(Object.keys(t).sort()).toEqual(["checkExit", "checkHashOk", "checkOutput", "costUsd", "ms", "n", "result", "tokens", "turns"]);
    expect(disk.wallMs).toBeGreaterThanOrEqual(0);
    expect(disk.artifactPath).toBe(join(p.home, "builds", rec.id, "workspace"));
    const lines = readFileSync(join(p.home, "builds", "runs.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: rec.id, outcome: "PASS", costUsd: 0.11, tries: 2 });
    expect(() => require("../../src/builder/record.ts").writeRunRecord(p.home, rec)).toThrow();
  });

  test("RECORD: check output in the record is truncated", async () => {
    const { rec } = await build([{ act: writeSlug("bad") }], { maxTries: 1 });
    expect(rec.tries[0]!.checkOutput.length).toBeLessThanOrEqual(4100);
  });

  test("RECORD: the solution option gets the latest build's cost (additive field)", async () => {
    const { p, rec } = await build([{ act: writeSlug("good"), costUsd: 0.09 }]);
    const f = buildFixture(LINKEDIN_IMAGE);
    const set = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
    const out = withBuildCosts(p.home, set);
    const o = out.options.find((x) => x.kind === "remove_step")!;
    expect(o.build).toEqual({ runId: rec.id, outcome: "PASS", costUsd: 0.09, tries: 1, totalCostUsd: 0.09 });
    expect(o.weeklyHoursSaved).toBe(set.options.find((x) => x.kind === "remove_step")!.weeklyHoursSaved);
    expect(out.options.find((x) => x.kind === "workflow")!.build).toBeUndefined();
  });
});
