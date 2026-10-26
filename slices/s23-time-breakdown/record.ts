// s23: records the app's wire fixtures from the REAL brain on the neutral week, or checks the committed ones.
//   bun run slices/s23-time-breakdown/record.ts           write tests/fixtures/time-*.json
//   bun run slices/s23-time-breakdown/record.ts --check   exit 1 if a committed fixture differs from the brain's answer
// The app tests (tests/S23Tests.swift) decode these files, so the app is tested on what the brain really sends,
// never on hand-written JSON. `model` is left out (it says which model serve runs, not what the screen shows).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeHome } from "../../brain/src/analyze.ts";
import { timeBreakdown } from "../../brain/src/time/breakdown.ts";
import { brainOn, call, neutralHome, NOW } from "../../brain/tests/s23-time-breakdown/setup.ts";

process.env.OFFLOAD_KEYS ??= "file"; // as brain/tests/preload.ts: raw fixture key files, never the Keychain
// Fixture event times (and so their ids) come from local wall-clock days; pin the zone so --check is the same answer
// in every timezone (the fixed clock NOW is in UTC).
process.env.TZ = "UTC";
const OUT = join(import.meta.dir, "tests", "fixtures");
const check = process.argv.includes("--check");
const fx = neutralHome();
let bad = 0;
try {
  const brain = brainOn(fx.home);
  const week = await call(brain, "/time");
  if (week.status !== 200) throw new Error(`GET /time answered ${week.status}`);
  const day = await call(brain, `/time?day=${week.body.window.days[2]}`);
  if (day.status !== 200) throw new Error(`GET /time?day= answered ${day.status}`);
  const nofix = await timeBreakdown(await analyzeHome(fx.home, { now: () => NOW }), { fixOf: null });
  const files: Record<string, unknown> = { "time-week.json": week.body, "time-day.json": day.body, "time-week-nofix.json": nofix };
  for (const [name, body] of Object.entries(files)) {
    const text = JSON.stringify({ ...(body as object), model: undefined }, null, 1) + "\n";
    const path = join(OUT, name);
    if (!check) {
      writeFileSync(path, text);
      console.log(`wrote ${name}`);
    } else if (!existsSync(path)) {
      console.log(`FAIL ${name}: not committed`);
      bad++;
    } else if (readFileSync(path, "utf8") !== text) {
      console.log(`FAIL ${name}: differs from the brain's answer (re-record with record.ts)`);
      bad++;
    } else console.log(`ok ${name}`);
  }
} finally {
  fx.cleanup();
}
process.exit(bad === 0 ? 0 : 1);
