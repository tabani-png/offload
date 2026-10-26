// Screenwatch importer (local blind test only). Turns a screenwatch archive (days/<YYYY-MM-DD>/log.jsonl with rows
// {t, epoch, app, window, url, img} every ~5 s, plus <t>.webp screenshots for img rows) into an Offload home in plain
// mode (docs/store-contract.md "Plain mode"), then captions the kept frames with the LOCAL Ollama captioner.
//
//   bun run brain/tools/import-screenwatch.ts import  --src DIR --home DIR --work DIR [--days 7] [--max-per-day 250]
//   bun run brain/tools/import-screenwatch.ts caption --home DIR --work DIR [--model qwen3-vl:2b-instruct] [--concurrency 2] [--retry-failed]
//
// import: rows are deduped by epoch; activity runs = rows no more than 2 min apart (a longer gap is idle). Each run
// opens with a focus event, each kept frame starts a new focus (so a span = one screen state), and the run ends
// with idle_start stamped 120 s after its last row (sessionize backdates it). Frames are kept on perceptual change
// (272-bit (17x16) dHash distance to the last kept frame, threshold raised until the day fits max-per-day) with a floor of
// one frame per 3 minutes of activity. The archive has no app/window/url in the window this was built for, so every
// span is on one synthetic app and the screenshots carry all the meaning.
// caption: frames go to OllamaCaptioner (127.0.0.1 only), at most `concurrency` at a time, fields masked with
// vision/notes.ts maskFields (grouping maskText), notes built with buildNote. Every result (note or failure) is
// appended to <work>/notes-cache/<day>.jsonl first, so a crash resumes where it stopped; the plain fixture sidecar
// <home>/frames/<day>.jsonl (understanding/frames.ts readFrameSidecars) is rewritten from the cache.
// Screenshots are read in place and converted to a temporary JPEG under <work>/tmp that is deleted after the call.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OffloadEvent } from "../src/types.ts";
import type { Captioner, CaptionFields, FrameNote, FrameRef } from "../src/vision/types.ts";

export interface Row {
  /** "HH-MM-SS" local time, also the screenshot's file stem. */
  t: string;
  /** ms since epoch. */
  ts: number;
  img: boolean;
}

export const IDLE_GAP_MS = 120_000;
export const FLOOR_MS = 180_000;
export const DEFAULT_MAX_PER_DAY = 250;
const IDLE_STAMP_MS = 120_000;

/** Parses log.jsonl text. Bad lines are counted; rows are unique by epoch (two writers can log the same second). */
export function parseLog(text: string): { rows: Row[]; bad: number; duplicates: number } {
  const byTs = new Map<number, Row>();
  let bad = 0;
  let duplicates = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    const o = r as { t?: unknown; epoch?: unknown; img?: unknown };
    if (typeof o.t !== "string" || !/^\d{2}-\d{2}-\d{2}$/.test(o.t) || typeof o.epoch !== "number" || !Number.isFinite(o.epoch)) {
      bad += 1;
      continue;
    }
    const ts = Math.round(o.epoch * 1000);
    const prev = byTs.get(ts);
    if (prev !== undefined) {
      duplicates += 1;
      if (o.img === true) prev.img = true;
      continue;
    }
    byTs.set(ts, { t: o.t, ts, img: o.img === true });
  }
  return { rows: [...byTs.values()].sort((a, b) => a.ts - b.ts), bad, duplicates };
}

export interface Run {
  start: number;
  /** ts of the last row of the run. */
  end: number;
  rows: number;
}

/** Activity runs: consecutive rows at most `gapMs` apart. */
export function activityRuns(rows: readonly Row[], gapMs = IDLE_GAP_MS): Run[] {
  const out: Run[] = [];
  let cur: Run | null = null;
  for (const r of rows) {
    if (cur !== null && r.ts - cur.end <= gapMs) {
      cur.end = r.ts;
      cur.rows += 1;
      continue;
    }
    if (cur !== null) out.push(cur);
    cur = { start: r.ts, end: r.ts, rows: 1 };
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Box-averages a w x h grayscale image down to tw x th (w, h multiples of tw, th). */
export function boxDown(gray: Uint8Array, w: number, h: number, tw: number, th: number): Float64Array {
  if (w % tw !== 0 || h % th !== 0) throw new Error(`cannot box ${w}x${h} to ${tw}x${th}`);
  const bx = w / tw;
  const by = h / th;
  const out = new Float64Array(tw * th);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[Math.floor(y / by) * tw + Math.floor(x / bx)]! += gray[y * w + x]!;
  for (let i = 0; i < out.length; i++) out[i]! /= bx * by;
  return out;
}

/** dHash over a (cols+1) x rows grid: bit = left pixel brighter than its right neighbour. Hex, MSB first. */
export function dHash(grid: Float64Array, cols: number, rows: number): string {
  let bits = "";
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) bits += grid[y * (cols + 1) + x]! > grid[y * (cols + 1) + x + 1]! ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) throw new Error("hash lengths differ");
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x > 0) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

export interface Hashes {
  /** 64-bit dHash (16 hex chars), the frame note's phash. */
  phash: string;
  /** 272-bit (17x16) dHash, used for change detection. */
  change: string;
}

/** Both hashes from a 36 x 32 grayscale thumbnail. */
export function hashesFromThumb(gray: Uint8Array): Hashes {
  if (gray.length !== 36 * 32) throw new Error("thumbnail must be 36x32");
  return { phash: dHash(boxDown(gray, 36, 32, 9, 8), 8, 8), change: dHash(boxDown(gray, 36, 32, 18, 16), 17, 16) };
}

/** Parses a binary PGM (P5, maxval <= 255). */
export function parsePgm(buf: Uint8Array): { w: number; h: number; gray: Uint8Array } {
  const head = Buffer.from(buf.subarray(0, Math.min(64, buf.length))).toString("latin1");
  const m = /^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
  if (m === null) throw new Error("not a binary PGM");
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (Number(m[3]) > 255) throw new Error("16-bit PGM not supported");
  const off = m[0].length;
  if (buf.length < off + w * h) throw new Error("PGM is truncated");
  return { w, h, gray: buf.subarray(off, off + w * h) };
}

/** Thumbnail of a webp file with dwebp (Homebrew libwebp), 36 x 32 grayscale. */
export function webpThumb(path: string, dwebp = "dwebp"): Uint8Array {
  const r = spawnSync(dwebp, ["-quiet", "-scale", "36", "32", "-pgm", "-o", "-", path], { maxBuffer: 1 << 20 });
  if (r.status !== 0) throw new Error(`dwebp failed (${r.status ?? r.signal}) for a frame`);
  const p = parsePgm(new Uint8Array(r.stdout));
  // dwebp writes YUV planes as PGM (height * 1.5); the first w*h bytes are luma.
  if (p.w !== 36 || p.h < 32) throw new Error("unexpected thumbnail size");
  return p.gray.subarray(0, 36 * 32);
}

/** Canvas size from a WebP header (VP8, VP8L or VP8X). */
export function webpSize(buf: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(buf);
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const v = b.readUInt32LE(21);
    return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) };
  }
  return null;
}

export interface Candidate {
  ts: number;
  t: string;
  hashes: Hashes;
}

export interface SelectOptions {
  maxPerDay: number;
  floorMs: number;
  /** Thresholds tried in order (bits of the 272-bit change hash); the first that fits maxPerDay wins. */
  thresholds: readonly number[];
}

export const DEFAULT_SELECT: SelectOptions = { maxPerDay: DEFAULT_MAX_PER_DAY, floorMs: FLOOR_MS, thresholds: [12, 16, 20, 24, 28, 32, 40, 48, 64, 96, 128, 257] };

function keepWith(cands: readonly Candidate[], runs: readonly Run[], threshold: number, floorMs: number): Candidate[] {
  const kept: Candidate[] = [];
  let ri = 0;
  let last: Candidate | null = null;
  let lastRun = -1;
  for (const c of cands) {
    while (ri < runs.length && c.ts > runs[ri]!.end) ri += 1;
    if (ri >= runs.length || c.ts < runs[ri]!.start) continue; // not inside an activity run
    const newRun = ri !== lastRun;
    if (newRun || last === null || hamming(c.hashes.change, last.hashes.change) >= threshold || c.ts - last.ts >= floorMs) {
      kept.push(c);
      last = c;
      lastRun = ri;
    }
  }
  return kept;
}

/** Frames to keep for one day and the change threshold used. The floor (one per floorMs of a run) beats the cap. */
export function selectFrames(cands: readonly Candidate[], runs: readonly Run[], opts: SelectOptions = DEFAULT_SELECT): { kept: Candidate[]; threshold: number } {
  const sorted = [...cands].sort((a, b) => a.ts - b.ts);
  let best: { kept: Candidate[]; threshold: number } | null = null;
  for (const th of opts.thresholds) {
    best = { kept: keepWith(sorted, runs, th, opts.floorMs), threshold: th };
    if (best.kept.length <= opts.maxPerDay) break;
  }
  return best ?? { kept: [], threshold: opts.thresholds[0] ?? 0 };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic ULID: time + 80 bits of sha256(seed). */
export function ulid(ts: number, seed: string): string {
  let t = Math.max(0, Math.floor(ts));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const h = createHash("sha256").update(seed).digest();
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[h[i]! % 32]!;
  return time + rand;
}

export const SYNTH_APP = "screenwatch.screen";
export const SYNTH_APP_NAME = "Screen";

/** Store events for a day: focus per run and per kept frame, idle_start 120 s after a run's last row, idle_end on return. */
export function buildEvents(day: string, runs: readonly Run[], kept: readonly Candidate[]): OffloadEvent[] {
  const events: OffloadEvent[] = [];
  let screen = 0;
  const focus = (ts: number): OffloadEvent => {
    screen += 1;
    // "Screen <n>" masks to one title template, so spans differ in focus but not in surface.
    return { id: ulid(ts, `${day}|focus|${screen}`), ts, kind: "focus", app: SYNTH_APP, appName: SYNTH_APP_NAME, title: `Screen ${screen}` };
  };
  let ki = 0;
  runs.forEach((run, i) => {
    if (i > 0) events.push({ id: ulid(run.start, `${day}|idle_end|${i}`), ts: run.start, kind: "idle_end" });
    events.push(focus(run.start));
    while (ki < kept.length && kept[ki]!.ts <= run.end) {
      const k = kept[ki]!;
      if (k.ts > run.start) events.push(focus(k.ts));
      ki += 1;
    }
    events.push({ id: ulid(run.end + IDLE_STAMP_MS, `${day}|idle_start|${i}`), ts: run.end + IDLE_STAMP_MS, kind: "idle_start" });
  });
  return events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

export interface ManifestFrame {
  frameId: string;
  ts: number;
  day: string;
  src: string;
  phash: string;
  width: number;
  height: number;
  bytes: number;
}

export interface DayImport {
  day: string;
  rows: number;
  duplicates: number;
  bad: number;
  imgRows: number;
  missingImages: number;
  hashFailures: number;
  runs: number;
  activeMinutes: number;
  framesKept: number;
  threshold: number;
  events: number;
}

export interface ImportDeps {
  thumb: (path: string) => Uint8Array;
}

/** Imports one day folder. Writes <home>/days/<day>.jsonl and <work>/manifest/<day>.jsonl. */
export function importDay(srcDay: string, day: string, home: string, work: string, opts: SelectOptions = DEFAULT_SELECT, deps: ImportDeps = { thumb: (p) => webpThumb(p) }): DayImport {
  const parsed = parseLog(readFileSync(join(srcDay, "log.jsonl"), "utf8"));
  const runs = activityRuns(parsed.rows);
  const cands: Candidate[] = [];
  let missing = 0;
  let hashFailures = 0;
  const imgRows = parsed.rows.filter((r) => r.img);
  for (const r of imgRows) {
    const p = join(srcDay, `${r.t}.webp`);
    if (!existsSync(p)) {
      missing += 1;
      continue;
    }
    try {
      cands.push({ ts: r.ts, t: r.t, hashes: hashesFromThumb(deps.thumb(p)) });
    } catch {
      hashFailures += 1;
    }
  }
  const { kept, threshold } = selectFrames(cands, runs, opts);
  const events = buildEvents(day, runs, kept);
  mkdirSync(join(home, "days"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "days", `${day}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  const manifest: ManifestFrame[] = kept.map((k) => {
    const src = join(srcDay, `${k.t}.webp`);
    const buf = readFileSync(src);
    const size = webpSize(buf) ?? { width: 0, height: 0 };
    return { frameId: ulid(k.ts, `${day}|frame|${k.t}`), ts: k.ts, day, src, phash: k.hashes.phash, width: size.width, height: size.height, bytes: buf.length };
  });
  mkdirSync(join(work, "manifest"), { recursive: true, mode: 0o700 });
  writeFileSync(join(work, "manifest", `${day}.jsonl`), manifest.map((m) => JSON.stringify(m)).join("\n") + (manifest.length > 0 ? "\n" : ""), { mode: 0o600 });
  return {
    day,
    rows: parsed.rows.length,
    duplicates: parsed.duplicates,
    bad: parsed.bad,
    imgRows: imgRows.length,
    missingImages: missing,
    hashFailures,
    runs: runs.length,
    activeMinutes: Math.round(runs.reduce((n, r) => n + (r.end - r.start), 0) / 600) / 100,
    framesKept: kept.length,
    threshold,
    events: events.length,
  };
}

// ---------------------------------------------------------------- captioning

export type CacheLine = { frameId: string; ok: true; note: FrameNote; ms: number } | { frameId: string; ok: false; error: string; ms: number };

export function readCache(path: string): Map<string, CacheLine> {
  const out = new Map<string, CacheLine>();
  if (!existsSync(path)) return out;
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (l.trim() === "") continue;
    try {
      const c = JSON.parse(l) as CacheLine;
      // A later line wins (a retried failure that now has a note).
      if (typeof c.frameId === "string") out.set(c.frameId, c);
    } catch {
      // A torn last line from a crash: ignore it, the frame is captioned again.
    }
  }
  return out;
}

/** Rewrites the plain sidecar <home>/frames/<day>.jsonl from the cache's notes. Returns the note count. */
export function writeSidecar(home: string, day: string, cache: ReadonlyMap<string, CacheLine>): number {
  const notes = [...cache.values()].flatMap((c) => (c.ok ? [c.note] : [])).sort((a, b) => a.ts - b.ts);
  mkdirSync(join(home, "frames"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "frames", `${day}.jsonl`), notes.map((n) => JSON.stringify(n)).join("\n") + (notes.length > 0 ? "\n" : ""), { mode: 0o600 });
  return notes.length;
}

export interface CaptionDeps {
  captioner: Captioner;
  /** JPEG bytes for a manifest frame. */
  load: (m: ManifestFrame) => Promise<Uint8Array>;
  mask: (f: CaptionFields) => CaptionFields;
  build: (ref: FrameRef, fields: CaptionFields, model: string) => FrameNote;
  log: (line: string) => void;
  now?: () => number;
}

/** Captions every manifest frame without a cache line (or with a failed one when retryFailed), `concurrency` at a time. */
export async function captionFrames(frames: readonly ManifestFrame[], cachePath: (day: string) => string, deps: CaptionDeps, opts: { concurrency: number; retryFailed: boolean; onDayProgress?: (day: string) => void }): Promise<{ done: number; failed: number; skipped: number }> {
  const now = deps.now ?? Date.now;
  const caches = new Map<string, Map<string, CacheLine>>();
  const cacheOf = (day: string) => {
    let c = caches.get(day);
    if (c === undefined) {
      c = readCache(cachePath(day));
      caches.set(day, c);
    }
    return c;
  };
  const todo = frames.filter((f) => {
    const c = cacheOf(f.day).get(f.frameId);
    return c === undefined || (!c.ok && opts.retryFailed);
  });
  const skipped = frames.length - todo.length;
  let next = 0;
  let done = 0;
  let failed = 0;
  const t0 = now();
  const work = async () => {
    for (;;) {
      const i = next++;
      const f = todo[i];
      if (f === undefined) return;
      const start = now();
      let line: CacheLine;
      try {
        const image = await deps.load(f);
        const ref: FrameRef = { frameId: f.frameId, ts: f.ts, day: f.day, phash: f.phash, width: f.width, height: f.height, bytes: f.bytes, maskedRegions: 0 };
        const fields = await deps.captioner.caption({ image, ref });
        line = { frameId: f.frameId, ok: true, note: deps.build(ref, deps.mask(fields), deps.captioner.id), ms: now() - start };
        done += 1;
      } catch (err) {
        // The reason only (never note text): the captioner's errors carry status codes and timeouts.
        line = { frameId: f.frameId, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160), ms: now() - start };
        failed += 1;
      }
      mkdirSync(join(cachePath(f.day), ".."), { recursive: true, mode: 0o700 });
      appendFileSync(cachePath(f.day), JSON.stringify(line) + "\n", { mode: 0o600 });
      cacheOf(f.day).set(f.frameId, line);
      const n = done + failed;
      if (n % 10 === 0 || n === todo.length) {
        const rate = (now() - t0) / n;
        deps.log(`captioned ${n}/${todo.length} (ok ${done}, failed ${failed}, skipped ${skipped}) avg ${(rate / 1000).toFixed(1)} s/frame wall, eta ${((rate * (todo.length - n)) / 60000).toFixed(0)} min`);
        opts.onDayProgress?.(f.day);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, work));
  return { done, failed, skipped };
}

/** webp -> JPEG (quality 60, long edge <= 1280, like the observer's keyframes) through sips, in a temp file. */
export function sipsJpeg(tmpDir: string): (m: ManifestFrame) => Promise<Uint8Array> {
  return async (m) => {
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const out = join(tmpDir, `${m.frameId}.jpg`);
    try {
      const r = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "60", "-Z", "1280", m.src, "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
      if (r.status !== 0 || !existsSync(out)) throw new Error(`sips could not convert the frame (${r.status ?? r.signal})`);
      return new Uint8Array(readFileSync(out));
    } finally {
      rmSync(out, { force: true });
    }
  };
}

// ---------------------------------------------------------------- CLI

function flag(args: readonly string[], name: string, fallback?: string): string {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined || v.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} needs a value`);
  }
  return v;
}

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === "import") {
    const src = flag(args, "--src");
    const home = flag(args, "--home");
    const work = flag(args, "--work");
    const nDays = Number(flag(args, "--days", "7"));
    const maxPerDay = Number(flag(args, "--max-per-day", String(DEFAULT_MAX_PER_DAY)));
    const days = readdirSync(join(src, "days")).filter((d) => DAY_DIR_RE.test(d) && existsSync(join(src, "days", d, "log.jsonl"))).sort().slice(-nDays);
    const report: DayImport[] = [];
    for (const day of days) {
      const t0 = Date.now();
      const r = importDay(join(src, "days", day), day, home, work, { ...DEFAULT_SELECT, maxPerDay });
      report.push(r);
      console.error(`${day}: rows ${r.rows} (dup ${r.duplicates}), img ${r.imgRows}, runs ${r.runs}, active ${r.activeMinutes} min, kept ${r.framesKept} @ ${r.threshold} bits, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    writeFileSync(join(work, "import-report.json"), JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  if (cmd === "caption") {
    const home = flag(args, "--home");
    const work = flag(args, "--work");
    const model = flag(args, "--model", "qwen3-vl:2b-instruct");
    const concurrency = Math.min(2, Math.max(1, Number(flag(args, "--concurrency", "2"))));
    const { OllamaCaptioner } = await import("../src/vision/ollama.ts");
    const { maskFields, buildNote } = await import("../src/vision/notes.ts");
    const captioner = new OllamaCaptioner({ model, timeoutMs: 180_000 });
    const h = await captioner.health();
    if (!h.ok) throw new Error(`captioner not ready: ${h.detail}`);
    const mdir = join(work, "manifest");
    const frames = readdirSync(mdir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .flatMap((n) => readFileSync(join(mdir, n), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as ManifestFrame));
    const cachePath = (day: string) => join(work, "notes-cache", `${day}.jsonl`);
    const logPath = join(work, "caption.log");
    const log = (s: string) => {
      const line = `${new Date().toISOString()} ${s}`;
      appendFileSync(logPath, line + "\n");
      console.error(line);
    };
    const t0 = Date.now();
    log(`start: ${frames.length} frames, model ${captioner.id}, concurrency ${concurrency}`);
    const sync = (day: string) => writeSidecar(home, day, readCache(cachePath(day)));
    const r = await captionFrames(frames, cachePath, { captioner, load: sipsJpeg(join(work, "tmp")), mask: maskFields, build: buildNote, log }, { concurrency, retryFailed: args.includes("--retry-failed"), onDayProgress: sync });
    const days = [...new Set(frames.map((f) => f.day))];
    for (const d of days) log(`sidecar ${d}: ${sync(d)} notes`);
    log(`done: ok ${r.done}, failed ${r.failed}, skipped (cached) ${r.skipped}, wall ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    return 0;
  }
  console.error("usage: import-screenwatch.ts import --src DIR --home DIR --work DIR [--days 7] [--max-per-day 250] | caption --home DIR --work DIR [--model TAG] [--concurrency 1|2] [--retry-failed]");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
