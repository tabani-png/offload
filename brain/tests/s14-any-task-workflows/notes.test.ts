// NOTES: frame notes from the s11 notes store reach the v2 understanding; purge rules match 7-day retention; serve sees
// new notes; end to end: an engine-format keyframe -> stub captioner -> sealed note -> v2 insight.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeHome } from "../../src/analyze.ts";
import { createBrain } from "../../src/api/server.ts";
import { storeFingerprint } from "../../src/store/reader.ts";
import { localDay, purgeExpired, sealText } from "../../src/store/vault.ts";
import { windowFrameNotes } from "../../src/understanding/notes-source.ts";
import { ObserverFrameSource } from "../../src/vision/frames.ts";
import { appendNotes, notesPath, readFrameNotes } from "../../src/vision/notes.ts";
import { StubCaptioner } from "../../src/vision/stub.ts";
import type { FrameNote } from "../../src/vision/types.ts";
import { CaptionWorker } from "../../src/vision/worker.ts";
import { writeFrame } from "../s11-perception/support.ts";
import { freshHome, NOW, reportNow, tmp } from "./setup.ts";

const DAY_MS = 86_400_000;

/** Moves a persona's fixture sidecar notes into the s11 notes store and deletes the sidecar. */
function sidecarToStore(home: string): number {
  const dir = join(home, "frames");
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))) {
    const day = f.slice(0, 10);
    const notes = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as FrameNote);
    appendNotes(home, notes, NOW, process.env, () => day);
    n += notes.length;
    rmSync(join(dir, f));
  }
  return n;
}

describe("s14 notes: s11 store -> v2", () => {
  test("NOTES: notes in the s11 notes store reach the v2 analysis and give the same top task as the sidecar", async () => {
    const { home, v2 } = await freshHome("bookkeeper");
    const moved = sidecarToStore(home);
    expect(moved).toBeGreaterThan(100);
    const a = await analyzeHome(home, { now: reportNow, understanding: "v2" });
    expect(a.understanding!.framesBySource.store).toBe(moved);
    expect(a.understanding!.framesBySource.sidecar).toBe(0);
    expect(a.understanding!.framesRead).toBe(v2.understanding!.framesRead);
    expect(a.insights[0]!.label.kind).toBe(v2.insights[0]!.label.kind);
    expect(a.insights[0]!.stats.instances.value).toBe(v2.insights[0]!.stats.instances.value);
  });

  test("NOTES: a note in both the sidecar and the store is used once", async () => {
    const { home } = await freshHome("support");
    // A weekday (the busiest file); weekend days have only a couple of notes.
    const files = readdirSync(join(home, "frames")).filter((x) => x.endsWith(".jsonl"));
    const day = files.sort((x, y) => readFileSync(join(home, "frames", y), "utf8").length - readFileSync(join(home, "frames", x), "utf8").length)[0]!.slice(0, 10);
    const notes = readFileSync(join(home, "frames", `${day}.jsonl`), "utf8").split("\n").filter((l) => l !== "").slice(0, 5).map((l) => JSON.parse(l) as FrameNote);
    appendNotes(home, notes, NOW, process.env, () => day);
    const days = [{ day, events: [] }];
    const w = windowFrameNotes(home, days, NOW);
    expect(w.bySource.store).toBe(5);
    expect(new Set(w.frames.map((f) => f.id)).size).toBe(w.frames.length);
    expect(w.frames.length).toBe(w.bySource.sidecar);
  });

  test("NOTES: the fingerprint changes when a note is written, so serve re-analyses", async () => {
    const { home } = await freshHome("recruiter");
    const before = storeFingerprint(home);
    expect(storeFingerprint(home)).toBe(before);
    const day = "2026-10-15";
    appendNotes(home, [{ id: "01JXAAAAAAAAAAAAAAAAAAAAAA", ts: new Date(2026, 9, 15, 10).getTime(), kind: "frame", frameId: "kf_x", model: "stub", activity: "Reading", confidence: 0.6 }], NOW, process.env, () => day);
    expect(storeFingerprint(home)).not.toBe(before);
    const empty = tmp();
    expect(storeFingerprint(empty)).toBe("empty");
  });

  test("NOTES: GET /status reports v2 and how many notes were read; a new note shows up without a restart", async () => {
    const { home } = await freshHome("support");
    sidecarToStore(home);
    const token = "s".repeat(40);
    const brain = createBrain({ home, token, now: () => NOW, analyze: { understanding: "v2" } });
    const get = async () => (await (await brain.handle(new Request("http://127.0.0.1/status", { headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" } }))).json()) as { understanding: { version: string; framesRead: number } };
    const s1 = await get();
    expect(s1.understanding.version).toBe("v2");
    const day = "2026-10-16";
    appendNotes(home, [{ id: "01JXBBBBBBBBBBBBBBBBBBBBBB", ts: new Date(2026, 9, 16, 11).getTime(), kind: "frame", frameId: "kf_new", model: "stub", activity: "Reading a ticket", confidence: 0.7 }], NOW, process.env, () => day);
    const s2 = await get();
    expect(s2.understanding.framesRead).toBe(s1.understanding.framesRead + 1);
  });
});

describe("s14 notes: retention", () => {
  test("NOTES: a notes file goes when its name day or its seal day is past 30 days, or when they disagree", () => {
    const home = tmp();
    const now = Date.now();
    const today = localDay(now);
    const old = localDay(now - 32 * DAY_MS);
    const recent = localDay(now - 2 * DAY_MS);
    mkdirSync(join(home, "frame-notes"), { recursive: true });
    sealText(home, notesPath(home, today), "{}\n", today);
    sealText(home, notesPath(home, recent), "{}\n", today); // named for a recent day, sealed under another: mismatch
    writeFileSync(notesPath(home, old), readFileSync(notesPath(home, today))); // old name, fresh seal
    purgeExpired(home, now, { log: () => {} });
    expect(existsSync(notesPath(home, today))).toBe(true);
    expect(existsSync(notesPath(home, recent))).toBe(false);
    expect(existsSync(notesPath(home, old))).toBe(false);
  });

  test("NOTES: fixture sidecars of frame notes older than 30 days are deleted; fresh ones and the engine's day folders stay", () => {
    const home = tmp();
    const now = Date.now();
    const fresh = localDay(now - 1 * DAY_MS);
    const old = localDay(now - 31 * DAY_MS);
    mkdirSync(join(home, "frames", fresh), { recursive: true });
    for (const d of [fresh, old]) writeFileSync(join(home, "frames", `${d}.jsonl`), "{}\n");
    writeFileSync(join(home, "frames", `${old}.jsonl.enc`), "x\n");
    purgeExpired(home, now, { log: () => {} });
    expect(existsSync(join(home, "frames", `${fresh}.jsonl`))).toBe(true);
    expect(existsSync(join(home, "frames", fresh))).toBe(true);
    expect(existsSync(join(home, "frames", `${old}.jsonl`))).toBe(false);
    expect(existsSync(join(home, "frames", `${old}.jsonl.enc`))).toBe(false);
  });
});

describe("s14 notes: end to end", () => {
  test("NOTES: engine keyframe -> StubCaptioner -> sealed notes -> v2 insight built from those notes", async () => {
    const home = tmp("offload-s14-e2e-");
    const now = Date.now();
    const day = localDay(now);
    const base = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate(), 0, 30).getTime();
    // 30 repeated items today: a record screen in a browser, 3 minutes each with typing; one keyframe per item.
    const events: object[] = [];
    let id = 0;
    const ev = (ts: number, e: object) => events.push({ id: `e${String(++id).padStart(5, "0")}`, ts, ...e });
    for (let i = 0; i < 30; i++) {
      const t0 = base + i * 200_000;
      ev(t0, { kind: "focus", app: "com.google.Chrome", appName: "Google Chrome", title: `Record ${1000 + i} - Example App`, url: `https://app.example.test/records/${1000 + i}`, host: "app.example.test" });
      ev(t0 + 2_000, { kind: "ocr", text: `Record ${1000 + i}\nStatus  Owner  Save`, textHash: `h${i}` });
      for (let m = 0; m < 3; m++) ev(t0 + 30_000 + m * 60_000, { kind: "input", keys: 60, clicks: 6 });
      writeFrame(home, t0 + 5_000, Buffer.from(`jpeg-${i}`), { app: "com.google.Chrome", appName: "Google Chrome", host: "app.example.test" });
    }
    ev(base + 30 * 200_000, { kind: "focus", app: "com.apple.finder", appName: "Finder", title: "Downloads" });
    mkdirSync(join(home, "days"), { recursive: true });
    writeFileSync(join(home, "days", `${day}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const captioner = new StubCaptioner();
    const worker = new CaptionWorker({ home, source: new ObserverFrameSource(home, { ...process.env, OFFLOAD_KEYS: "file" }), captioner, now: () => now, log: () => {} });
    let done = 0;
    while ((await worker.runOnce()) > 0) done += 1;
    expect(captioner.calls).toBe(30);
    const notes = readFrameNotes(home, day, now);
    expect(notes.length).toBe(30);
    // Sealed on disk: the note text is not readable in the file.
    expect(readFileSync(notesPath(home, day), "utf8")).not.toContain("record");

    const a = await analyzeHome(home, { now: () => now, understanding: "v2" });
    expect(a.understanding!.framesBySource.store).toBe(30);
    const top = a.insights[0]!;
    expect(top).toBeDefined();
    const u = top.profile.understanding!;
    expect(u.sources.frames).toBeGreaterThan(0);
    const noteIds = new Set(notes.map((x) => x.id));
    expect(u.frameIds.filter((x) => noteIds.has(x)).length).toBeGreaterThanOrEqual(25);
    expect(done).toBeGreaterThan(0);
  });
});
