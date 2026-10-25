// AC-9: v1 stays the default and its output for the founder fixture is byte-identical to before s12.
// The hash was captured on the base commit (a3f7f28) before any s12 code existed.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { toInsights } from "../../src/api/dto.ts";
import { tempHome } from "../helpers.ts";

const V1_GOLDEN = "12616fc1660f07738066946f21ce33aff87511bc144184dc1bb0f56222fffdb3";

const { home, cleanup } = tempHome();
afterAll(cleanup);
writeFixture(home, generateFixture({ seed: 42, startDay: "2026-10-12" }), { encrypted: false, seed: 42 });
const now = new Date(2026, 9, 19, 12).getTime();

function digest(a: Awaited<ReturnType<typeof analyzeHome>>): string {
  const body = toInsights(a);
  const insights = body.insights.map((i) => {
    // `understanding` is the additive v2 block; v1 never sets it.
    const { understanding, ...rest } = i as typeof i & { understanding?: unknown };
    expect(understanding).toBeUndefined();
    return rest;
  });
  return createHash("sha256").update(JSON.stringify({ insights, tasks: a.tasks.map((t) => [t.id, t.label, t.instances.length]) })).digest("hex");
}

describe("V1GOLDEN", () => {
  test("default analysis is byte-identical to the base commit", async () => {
    const h = digest(await analyzeHome(home, { now: () => now }));
    expect(h).toBe(V1_GOLDEN);
  });
  test("understanding: 'v1' is the same as the default", async () => {
    const h = digest(await analyzeHome(home, { now: () => now, understanding: "v1" } as Parameters<typeof analyzeHome>[1]));
    expect(h).toBe(V1_GOLDEN);
  });
});
