// s05 AC-8: the real CLI end to end on the fixture week with the stub model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { tempHome } from "../helpers.ts";

const ROOT = join(import.meta.dir, "..", "..");
const fx = tempHome();
const factsFile = join(fx.home, "facts-offload.md");
afterAll(() => fx.cleanup());

function run(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, OFFLOAD_TOKEN: "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeAll(() => {
  const g = Bun.spawnSync(["bun", "run", "fixtures/gen.ts", "--out", fx.home, "--seed", "42", "--encrypted"], { cwd: ROOT, env: { ...process.env, OFFLOAD_KEYS: "file" } });
  if (g.exitCode !== 0) throw new Error(g.stderr.toString());
  writeFileSync(factsFile, FIXTURE_FACTS);
});

describe("s05 cli", () => {
  test("tone build writes the cards", () => {
    const r = run(["tone", "build", "--home", fx.home, "--source", "fixture", "--model", "stub"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tone pack: 40 sent emails");
    expect(r.out).toContain("investor_outreach: 18 emails");
    expect(existsSync(join(fx.home, "tone", "investor_outreach.md"))).toBe(true);
  });

  test("draft --insight 1 writes the outreach workflow", () => {
    const r = run(["draft", "--insight", "1", "--home", fx.home, "--facts", factsFile]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^drafted wf_[a-z0-9]+: Investor outreach emails \[ready_for_review, auto-run off\]/);
    expect(r.out).toContain("4. approval_gate You review the batch");
  });

  test("dry-run --insight 1 prints drafts next to what you wrote, all side effects denied", () => {
    const r = run(["dry-run", "--insight", "1", "--home", fx.home, "--limit", "2", "--model", "stub"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("side effects 4/4 denied by the gate");
    expect(r.out).toContain("--- our draft");
    expect(r.out).toContain("--- what you wrote (OCR excerpt)");
    expect(r.out).toMatch(/total: you spent [\d.]+ min on these 2/);
  });

  test("tone test writes the blind pairs", () => {
    const r = run(["tone", "test", "--home", fx.home, "--hold-back", "4", "--model", "stub"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("blind test: 4 held back, trained on 36");
  });

  test("usage errors exit 2", () => {
    expect(run(["draft", "--home", fx.home]).code).toBe(2);
    expect(run(["dry-run", "--home", fx.home]).code).toBe(2);
    expect(run(["tone", "fly", "--home", fx.home]).code).toBe(2);
    expect(run(["draft", "--insight", "99", "--home", fx.home]).code).toBe(2);
    expect(run(["tone", "build", "--home", fx.home, "--source", "mcp"]).err).toContain("connect Gmail first");
  });
});
