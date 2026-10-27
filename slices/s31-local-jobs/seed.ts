// s31 proof seed: puts a person's state into HOME so the INSTALLED app's background jobs have work to do.
// Run with the repo's bun (test harness only; the jobs themselves run from the copied app, not from here):
//   OFFLOAD_KEYS=file bun run slices/s31-local-jobs/seed.ts HOME          (or --frame HOME: one keyframe, now)
// Writes, relative to the real clock:
//   - the fixture week (observer store, raw day keys), ending today;
//   - a stub tone pack and the outreach workflow, dry-run and approved (active, auto-run off), with 3 recipients;
//   - activatedAt 8 days ago and no lastScheduledAt: a weekday 09:00 slot came due while "the Mac slept" (missed slot);
//   - 2 keyframes captured today (engine on-disk format) for the caption worker;
//   - two purge targets: frame-notes/<10 days ago>.jsonl.enc and frames/<10 days ago>.jsonl (older than 7 days) and
//     one keeper frames/<6 days ago>.jsonl (inside the window).
// Prints one JSON line: {workflowId, oldDay, keepDay}.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../brain/fixtures/gen.ts";
import { FIXTURE_FACTS } from "../../brain/fixtures/sent-mail.ts";
import { analyzeHome } from "../../brain/src/analyze.ts";
import { createBrain } from "../../brain/src/api/server.ts";
import { DEFAULT_MODELS, StubModel } from "../../brain/src/models/model.ts";
import { localDay } from "../../brain/src/store/vault.ts";
import { FixtureMailSource } from "../../brain/src/tone/mail-source.ts";
import { buildTonePack } from "../../brain/src/tone/pack.ts";
import { draftWorkflow } from "../../brain/src/workflows/drafter.ts";
import { writeFrame } from "../../brain/tests/s11-perception/support.ts";

if (process.env.OFFLOAD_KEYS !== "file") throw new Error("seed.ts runs with OFFLOAD_KEYS=file only (never the Keychain)");
// `seed.ts --frame HOME`: one more keyframe captured now (the WAKE check adds it while the brain is suspended).
if (process.argv[2] === "--frame") {
  const h = process.argv[3];
  if (h === undefined || h === "") throw new Error("usage: seed.ts --frame HOME");
  console.log(JSON.stringify({ frameId: writeFrame(h, Date.now()).frameId }));
  process.exit(0);
}
const home = process.argv[2];
if (home === undefined || home === "") throw new Error("usage: seed.ts HOME | seed.ts --frame HOME");
mkdirSync(home, { recursive: true, mode: 0o700 });

const DAY = 86_400_000;
const now = Date.now();
const start = localDay(now - 6 * DAY);
writeFixture(home, generateFixture({ seed: 42, startDay: start, days: 7 }), { encrypted: true, seed: 42 });
const analysis = await analyzeHome(home, { now: () => now });
const model = new StubModel();
await buildTonePack({ home, source: new FixtureMailSource(), model, models: DEFAULT_MODELS, now: () => now });
const first = analysis.insights[0];
if (first === undefined) throw new Error("the fixture week has no insight");
const { workflow } = draftWorkflow({ home, analysis, insightId: first.id, facts: FIXTURE_FACTS, now: () => now });
if (workflow.schedule.type !== "cron") throw new Error(`expected a cron schedule, got ${workflow.schedule.type}`);

const token = "s".repeat(40);
const brain = createBrain({ home, token, now: () => now, workflows: { model, modelLabel: "stub" } });
const call = async (path: string, body: unknown) => {
  const r = await brain.handle(new Request(`http://127.0.0.1:1${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const j = (await r.json()) as Record<string, unknown>;
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const dry = await call(`/workflows/${workflow.id}/dry-run`, { limit: 1 });
const ok = await call(`/workflows/${workflow.id}/approve`, { batchHash: dry.batchHash });
if (ok.result !== "activated") throw new Error(`approve: ${JSON.stringify(ok)}`);
await brain.idle?.();
writeFileSync(join(home, "workflows", workflow.id, "recipients.csv"), ["email,first_name,last_name,org,notes", "ana@fund.vc,Ana,Lee,Fund VC,", "bo@seed.vc,Bo,Kim,Seed VC,", "cy@pre.vc,Cy,Ito,Pre VC,"].join("\n") + "\n");

// The missed slot: activated 8 days ago, never scheduled since (the app was closed or the Mac asleep at 09:00).
const wfPath = join(home, "workflows", workflow.id, "workflow.json");
const wf = JSON.parse(readFileSync(wfPath, "utf8")) as Record<string, unknown>;
wf.activatedAt = now - 8 * DAY;
delete wf.lastScheduledAt;
writeFileSync(wfPath, JSON.stringify(wf, null, 2) + "\n", { mode: 0o600 });

// Keyframes captured today, for the caption worker.
writeFrame(home, now - 120_000);
writeFrame(home, now - 60_000);

// Purge targets (by file-name day) and one keeper.
const oldDay = localDay(now - 10 * DAY);
const keepDay = localDay(now - 6 * DAY);
mkdirSync(join(home, "frame-notes"), { recursive: true, mode: 0o700 });
writeFileSync(join(home, "frame-notes", `${oldDay}.jsonl.enc`), "s31-old\n", { mode: 0o600 });
writeFileSync(join(home, "frames", `${oldDay}.jsonl`), "s31-old\n", { mode: 0o600 });
writeFileSync(join(home, "frames", `${keepDay}.jsonl`), "s31-keep\n", { mode: 0o600 });

console.log(JSON.stringify({ workflowId: workflow.id, oldDay, keepDay }));
