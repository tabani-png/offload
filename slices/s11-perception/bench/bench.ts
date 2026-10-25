// s11 captioner bench. Usage: bun run slices/s11-perception/bench/bench.ts MODEL IMAGE_DIR [OUT_JSON]
// Converts each PNG in IMAGE_DIR to a JPEG with a 1280 px long edge (what the observer keeps), captions it with the
// real OllamaCaptioner (loopback only), and records latency, schema validity and a keyword quality check.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OllamaCaptioner } from "../../../brain/src/vision/ollama.ts";
import { maskFields } from "../../../brain/src/vision/notes.ts";

const [model = "qwen3-vl:2b-instruct", dir = "/tmp/s11-bench", outPath] = process.argv.slice(2);

/** Words a correct note should contain (any one per group), per screenshot. Lower-case substrings. */
const EXPECT: Record<string, { activity: string[][]; ids?: string[] }> = {
  invoice: { activity: [["bill", "invoice"], ["enter", "record", "creat", "input", "add", "fill"]], ids: ["inv-20431", "20431"] },
  crm: { activity: [["deal", "pipeline", "crm"], ["updat", "edit", "review", "manag", "chang"]], ids: ["d-1190", "1190"] },
  ticket: { activity: [["ticket", "support", "customer", "repl", "respond"]], ids: ["58213"] },
  sheet: { activity: [["budget", "spreadsheet", "sheet"]] },
  code: { activity: [["code", "test", "debug", "reconcil", "function"]], ids: ["reconcile.ts", "reconcile.test.ts", "bill-342"] },
  recruit: { activity: [["candidate", "resume", "cv", "scorecard", "interview", "screen"]], ids: ["req-2291", "2291"] },
  compose: { activity: [["email", "message", "writ", "compos", "draft"]], ids: ["cobaltventures.vc"] },
  "dashboard-light": { activity: [["dashboard", "automation", "review", "saving", "hours", "workflow"]] },
  "review-1280-dark": { activity: [["review", "workflow", "draft", "email"]] },
  "onboarding-permissions-light": { activity: [["permission", "setting", "grant", "onboard", "setup", "set up"]] },
  "card-light": { activity: [["suggest", "card", "automat", "option", "review", "insight"]] },
};

const jpgDir = join(dir, "jpg");
mkdirSync(jpgDir, { recursive: true });
const cap = new OllamaCaptioner({ model, timeoutMs: 180_000, retries: 1 });
const health = await cap.health();
console.log(`model ${model}: ${health.ok ? "ready" : health.detail}`);
if (!health.ok) process.exit(1);

const rows: Array<Record<string, unknown>> = [];
const names = readdirSync(dir).filter((n) => n.endsWith(".png")).sort();
for (const [i, n] of names.entries()) {
  const base = n.replace(/\.png$/, "");
  const jpg = join(jpgDir, `${base}.jpg`);
  const s = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "60", "-Z", "1280", join(dir, n), "--out", jpg], { encoding: "utf8" });
  if (s.status !== 0) throw new Error(`sips failed for ${n}`);
  const image = readFileSync(jpg);
  const t0 = performance.now();
  let fields: unknown = null;
  let error = "";
  try {
    fields = maskFields(await cap.caption({ image, ref: { frameId: `bench${i}`, ts: Date.now(), day: "2026-10-25", width: 1280, height: 800, bytes: image.length, maskedRegions: 0 } }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = Math.round(performance.now() - t0);
  const f = (fields ?? {}) as { activity?: string; identifiers?: string[]; object?: string; surface?: string };
  const exp = EXPECT[base];
  const text = `${f.activity ?? ""} ${f.object ?? ""} ${f.surface ?? ""}`.toLowerCase();
  const activityOk = exp === undefined ? null : exp.activity.every((g) => g.some((w) => text.includes(w)));
  const ids = (f.identifiers ?? []).join(" ").toLowerCase();
  // maskText turns digits into <n>/<id>, so an id counts as found when its letter prefix or file name survives.
  const idOk = exp?.ids === undefined ? null : exp.ids.some((w) => ids.includes(w) || ids.includes(w.replace(/\d+/g, "<n>")) || ids.includes(w.replace(/[\d-]+$/, "")));
  rows.push({ image: base, ms, bytes: image.length, error, activityOk, idOk, fields });
  console.log(`${base.padEnd(30)} ${String(ms).padStart(6)} ms  activity:${activityOk} ids:${idOk} ${error}`);
  console.log(`   ${JSON.stringify(fields)}`);
}
const ok = rows.filter((r) => r.error === "");
const lat = ok.map((r) => r.ms as number).sort((a, b) => a - b);
const median = lat.length === 0 ? 0 : lat[Math.floor(lat.length / 2)]!;
const summary = {
  model,
  images: rows.length,
  valid: ok.length,
  firstMs: rows[0]?.ms ?? null,
  medianMs: median,
  maxMs: lat[lat.length - 1] ?? null,
  activityOk: rows.filter((r) => r.activityOk === true).length,
  activityChecked: rows.filter((r) => r.activityOk !== null).length,
  idOk: rows.filter((r) => r.idOk === true).length,
  idChecked: rows.filter((r) => r.idOk !== null).length,
};
console.log(JSON.stringify(summary));
if (outPath !== undefined) writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));
