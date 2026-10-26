// The founder week (fixtures/gen.ts, seed 42), written once, analysed at a fixed now; fresh copies for tests that write.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome, type Analysis } from "../../src/analyze.ts";

process.env.OFFLOAD_KEYS ??= "file";
export const START = "2026-10-12";
export const NOW = new Date(2026, 9, 19, 12).getTime();

export const tmp = (prefix = "offload-s22-") => mkdtempSync(join(tmpdir(), prefix));

let base: Promise<{ home: string; a: Analysis }> | null = null;
export function founder(): Promise<{ home: string; a: Analysis }> {
  base ??= (async () => {
    const home = tmp("offload-s22-founder-");
    writeFixture(home, generateFixture({ seed: 42, startDay: START }), { encrypted: false, seed: 42 });
    return { home, a: await analyzeHome(home, { now: () => NOW }) };
  })();
  return base;
}

/** A copy of the founder home without workflows or solutions. */
export async function freshFounder(): Promise<{ home: string; a: Analysis }> {
  const b = await founder();
  const home = tmp("offload-s22-w-");
  cpSync(b.home, home, { recursive: true, filter: (src) => !src.includes("/workflows") && !src.includes("/solutions") });
  return { home, a: b.a };
}

/** For the CLI, which reads at the real clock: the founder week ending yesterday (gen.ts's own default). */
let live: string | null = null;
export function founderLive(): string {
  if (live !== null) return live;
  const t = new Date(Date.now() - 7 * 86_400_000);
  const start = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  live = tmp("offload-s22-live-");
  writeFixture(live, generateFixture({ seed: 42, startDay: start }), { encrypted: false, seed: 42 });
  return live;
}
