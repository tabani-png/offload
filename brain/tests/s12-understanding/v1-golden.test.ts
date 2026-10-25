// AC-9: v1 stays the default and its output for the founder fixture is byte-identical to before s12.
// The hash was produced by v1-digest.ts on the base commit (a3f7f28) under TZ=UTC, before any s12 code existed.
// The digest runs in a child with TZ=UTC because local days and ids depend on the zone (verify-all runs other zones).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const V1_GOLDEN = "12616fc1660f07738066946f21ce33aff87511bc144184dc1bb0f56222fffdb3";
const DIGEST = join(import.meta.dir, "v1-digest.ts");

function digest(...args: string[]): string {
  const r = Bun.spawnSync([process.execPath, "run", DIGEST, ...args], { env: { ...process.env, TZ: "UTC", OFFLOAD_KEYS: "file" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

describe("V1GOLDEN", () => {
  test("default analysis is byte-identical to the base commit", () => {
    expect(digest()).toBe(V1_GOLDEN);
  });
  test("understanding: 'v1' is the same as the default", () => {
    expect(digest("v1")).toBe(V1_GOLDEN);
  });
});
