// Prints the sha256 of the v1 analysis of the founder fixture (seed 42, week of 2026-10-12, read at noon 2026-10-19).
// Run with TZ=UTC: local days and ids depend on the zone. Arg "v1" passes understanding: "v1" explicitly.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { toInsights } from "../../src/api/dto.ts";

process.env.OFFLOAD_KEYS ??= "file";
const home = mkdtempSync(join(tmpdir(), "offload-v1digest-"));
try {
  writeFixture(home, generateFixture({ seed: 42, startDay: "2026-10-12" }), { encrypted: false, seed: 42 });
  const now = new Date(2026, 9, 19, 12).getTime();
  const opts = process.argv[2] === "v1" ? ({ now: () => now, understanding: "v1" } as Parameters<typeof analyzeHome>[1]) : { now: () => now };
  const a = await analyzeHome(home, opts);
  const insights = toInsights(a).insights.map((i) => {
    const { understanding, ...rest } = i as typeof i & { understanding?: unknown };
    if (understanding !== undefined) throw new Error("v1 insight carries an understanding block");
    return rest;
  });
  console.log(createHash("sha256").update(JSON.stringify({ insights, tasks: a.tasks.map((t) => [t.id, t.label, t.instances.length]) })).digest("hex"));
} finally {
  rmSync(home, { recursive: true, force: true });
}
