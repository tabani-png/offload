import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../helpers.ts";

const ROOT = join(import.meta.dir, "..", "..");
const fx = tempHome();
afterAll(() => fx.cleanup());

function run(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "run", ...args], { cwd: ROOT, env: { ...process.env, OFFLOAD_TOKEN: "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("cli", () => {
  test("the fixture generator writes 7 encrypted days with keys", () => {
    const r = run(["fixtures/gen.ts", "--out", fx.home, "--seed", "42", "--encrypted"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(fx.home, "days", "2026-10-12.jsonl.enc"))).toBe(true);
    expect(existsSync(join(fx.home, "keys", "2026-10-12.key"))).toBe(true);
  });

  test("analyze prints the top insights with their arithmetic", () => {
    const r = run(["src/cli.ts", "analyze", "--home", fx.home, "--top", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#1 Outreach emails");
    expect(r.out).toMatch(/\/day × \d+ days × [\d.]+ min = [\d.]+ h\/wk → review/);
    expect(r.out).toContain("#3 ");
    expect(r.out).not.toContain("#4 ");
  });

  test("analyze --json prints machine-readable insights", () => {
    const r = run(["src/cli.ts", "analyze", "--home", fx.home, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { insights: Array<{ kind: string }> };
    expect(parsed.insights[0]?.kind).toBe("email.outreach");
  });

  test("a missing --home is a usage error with a non-zero exit", () => {
    const r = run(["src/cli.ts", "analyze"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--home");
  });

  test("an unknown command is a usage error", () => {
    const r = run(["src/cli.ts", "frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("usage");
  });
});
