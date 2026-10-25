// brain/tools/import-screenwatch.ts on a tiny synthetic archive: no real screenshots, an injected thumbnail function
// and the stub captioner, so it runs offline in milliseconds.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionize, DEFAULT_SESSION_OPTIONS, totalActiveMs } from "../../src/sessionize.ts";
import { readFrameSidecars } from "../../src/understanding/frames.ts";
import { buildNote, maskFields } from "../../src/vision/notes.ts";
import { StubCaptioner } from "../../src/vision/stub.ts";
import type { Captioner, CaptionFields } from "../../src/vision/types.ts";
import type { OffloadEvent } from "../../src/types.ts";
import {
  activityRuns,
  buildEvents,
  captionFrames,
  DEFAULT_SELECT,
  dHash,
  hamming,
  hashesFromThumb,
  importDay,
  parseLog,
  parsePgm,
  readCache,
  selectFrames,
  webpSize,
  writeSidecar,
  type Candidate,
  type ManifestFrame,
} from "../../tools/import-screenwatch.ts";
import { tempHome } from "../helpers.ts";

const DAY = "2026-10-12";
const BASE = new Date(2026, 9, 12, 9, 0, 0).getTime() / 1000; // local 09:00

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (sec: number) => {
  const d = new Date((BASE + sec) * 1000);
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};
const row = (sec: number, img = false) => JSON.stringify({ t: stamp(sec), epoch: BASE + sec, app: "", window: "", url: "", img });

/** A 36x32 thumbnail: `pattern` picks one of a few very different images, `noise` flips a little detail. */
function thumb(pattern: number, noise = 0): Uint8Array {
  const g = new Uint8Array(36 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 36; x++) g[y * 36 + x] = (((x * (pattern + 1) + y * (pattern + 3)) * 37) % 251 + noise * ((x + y) % 2)) & 0xff;
  return g;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmp(): string {
  const t = tempHome();
  cleanups.push(t.cleanup);
  return t.home;
}

describe("log parsing and activity", () => {
  test("rows are deduped by epoch, bad lines counted, sorted", () => {
    const text = [row(10), row(5, true), row(5), "not json", JSON.stringify({ t: "x", epoch: 1 }), ""].join("\n");
    const p = parseLog(text);
    expect(p.rows.map((r) => r.ts)).toEqual([(BASE + 5) * 1000, (BASE + 10) * 1000]);
    expect(p.rows[0]!.img).toBe(true);
    expect(p.duplicates).toBe(1);
    expect(p.bad).toBe(2);
  });

  test("a gap over 2 minutes splits activity runs", () => {
    const rows = parseLog([0, 5, 10, 130, 135, 400].map((s) => row(s)).join("\n")).rows;
    const runs = activityRuns(rows);
    expect(runs.map((r) => [(r.start / 1000 - BASE), (r.end / 1000 - BASE)])).toEqual([[0, 135], [400, 400]]);
  });
});

describe("hashes", () => {
  test("dHash, hamming and PGM parsing", () => {
    const grid = Float64Array.from([3, 2, 1, 0, 1, 2, 3, 4, 5]); // one row of 8 + 1
    expect(dHash(grid, 8, 1)).toBe("e0");
    expect(hamming("ff", "0f")).toBe(4);
    const pgm = new Uint8Array([...Buffer.from("P5\n2 1\n255\n"), 7, 9]);
    expect(parsePgm(pgm)).toMatchObject({ w: 2, h: 1 });
    const h = hashesFromThumb(thumb(1));
    expect(h.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(h.change).toMatch(/^[0-9a-f]{68}$/);
    expect(hamming(h.change, hashesFromThumb(thumb(1)).change)).toBe(0);
    expect(hamming(h.change, hashesFromThumb(thumb(4)).change)).toBeGreaterThan(40);
  });

  test("webp canvas size from a VP8X header", () => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "latin1");
    b.write("WEBP", 8, "latin1");
    b.write("VP8X", 12, "latin1");
    b.writeUIntLE(1567, 24, 3);
    b.writeUIntLE(1673, 27, 3);
    expect(webpSize(b)).toEqual({ width: 1568, height: 1674 });
    expect(webpSize(Buffer.from("nope"))).toBeNull();
  });
});

describe("frame selection", () => {
  const cand = (sec: number, pattern: number): Candidate => ({ ts: (BASE + sec) * 1000, t: stamp(sec), hashes: hashesFromThumb(thumb(pattern)) });

  test("keeps changes, drops repeats, keeps one per 3 minutes, first of each run", () => {
    // one run 0..600 s with the same image except a change at 60 s; a second run at 1000 s
    const rows = parseLog([...Array.from({ length: 121 }, (_, i) => row(i * 5)), row(1000)].join("\n")).rows;
    const runs = activityRuns(rows);
    const cands = [cand(0, 1), cand(30, 1), cand(60, 5), cand(90, 5), cand(240, 5), cand(300, 5), cand(500, 5), cand(1000, 5), cand(700, 2) /* idle: dropped */];
    const { kept } = selectFrames(cands, runs);
    expect(kept.map((k) => k.ts / 1000 - BASE)).toEqual([0, 60, 240, 500, 1000]);
  });

  test("raises the threshold to fit the cap, but never below the floor", () => {
    const rows = parseLog(Array.from({ length: 121 }, (_, i) => row(i * 5)).join("\n")).rows;
    const runs = activityRuns(rows);
    const cands = Array.from({ length: 60 }, (_, i) => cand(i * 10, i % 7));
    const loose = selectFrames(cands, runs, { ...DEFAULT_SELECT, maxPerDay: 100 });
    const tight = selectFrames(cands, runs, { ...DEFAULT_SELECT, maxPerDay: 2 });
    expect(loose.kept.length).toBeGreaterThan(10);
    expect(tight.threshold).toBeGreaterThan(loose.threshold);
    // 600 s of activity: the 3-minute floor keeps 0, 180, 360, 540 even with the cap at 2
    expect(tight.kept.map((k) => k.ts / 1000 - BASE)).toEqual([0, 180, 360, 540]);
  });
});

describe("events into spans", () => {
  test("a span per kept screen, idle gaps removed, active time = run time", () => {
    const rows = parseLog([...Array.from({ length: 25 }, (_, i) => row(i * 5)), ...Array.from({ length: 13 }, (_, i) => row(600 + i * 5))].join("\n")).rows;
    const runs = activityRuns(rows);
    const kept: Candidate[] = [0, 60, 600].map((s, i) => ({ ts: (BASE + s) * 1000, t: stamp(s), hashes: hashesFromThumb(thumb(i)) }));
    const events = buildEvents(DAY, runs, kept);
    expect(events.map((e) => e.kind)).toEqual(["focus", "focus", "idle_start", "idle_end", "focus", "idle_start"]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const spans = sessionize(events, DAY, DEFAULT_SESSION_OPTIONS);
    expect(spans.map((s) => [(s.start / 1000 - BASE), (s.end / 1000 - BASE)])).toEqual([[0, 60], [60, 120], [600, 660]]);
    expect(totalActiveMs(spans)).toBe((120 + 60) * 1000);
  });
});

describe("import and caption end to end", () => {
  function archive(): { src: string; home: string; work: string; thumbs: Map<string, Uint8Array> } {
    const root = tmp();
    const src = join(root, "days", DAY);
    mkdirSync(src, { recursive: true });
    const lines: string[] = [];
    const thumbs = new Map<string, Uint8Array>();
    for (let i = 0; i <= 72; i++) {
      const sec = i * 5;
      const img = i % 6 === 0;
      lines.push(row(sec, img));
      if (img) {
        const p = join(src, `${stamp(sec)}.webp`);
        writeFileSync(p, Buffer.from(`fake ${sec}`));
        thumbs.set(p, thumb(sec < 180 ? 1 : 3));
      }
    }
    lines.push(row(35), "garbage");
    writeFileSync(join(src, "log.jsonl"), lines.join("\n") + "\n");
    return { src, home: join(root, "home"), work: join(root, "work"), thumbs };
  }

  test("import writes plain day events and a frame manifest", () => {
    const a = archive();
    const r = importDay(a.src, DAY, a.home, a.work, DEFAULT_SELECT, { thumb: (p) => a.thumbs.get(p)! });
    expect(r).toMatchObject({ rows: 73, duplicates: 1, bad: 1, imgRows: 13, missingImages: 0, runs: 1, framesKept: 3 });
    const events = readFileSync(join(a.home, "days", `${DAY}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as OffloadEvent);
    expect(events.filter((e) => e.kind === "focus")).toHaveLength(3);
    const manifest = readFileSync(join(a.work, "manifest", `${DAY}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ManifestFrame);
    expect(manifest.map((m) => m.ts / 1000 - BASE)).toEqual([0, 180, 360]);
  });

  test("captioning is resumable, masks text and writes a readable sidecar", async () => {
    const a = archive();
    importDay(a.src, DAY, a.home, a.work, DEFAULT_SELECT, { thumb: (p) => a.thumbs.get(p)! });
    const frames = readFileSync(join(a.work, "manifest", `${DAY}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ManifestFrame);
    const cachePath = (d: string) => join(a.work, "notes-cache", `${d}.jsonl`);
    const stub = new StubCaptioner();
    let fail = true;
    const flaky: Captioner = {
      kind: "ollama",
      model: "test",
      id: "ollama:test",
      health: async () => ({ ok: true, detail: "ok" }),
      caption: async (input): Promise<CaptionFields> => {
        if (fail && input.ref.frameId === frames[1]!.frameId) throw new Error("ollama did not answer within 10 ms");
        const f = await stub.caption(input);
        return { ...f, activity: "Writing to jane.doe@example.com about order 12345", counterpart: "Jane Doe" };
      },
    };
    const deps = { captioner: flaky, load: async (m: ManifestFrame) => new Uint8Array(Buffer.from(m.frameId)), mask: maskFields, build: buildNote, log: () => {} };
    const first = await captionFrames(frames, cachePath, deps, { concurrency: 2, retryFailed: false });
    expect(first).toEqual({ done: 2, failed: 1, skipped: 0 });
    // resume without retry: nothing to do
    expect(await captionFrames(frames, cachePath, deps, { concurrency: 2, retryFailed: false })).toEqual({ done: 0, failed: 0, skipped: 3 });
    fail = false;
    expect(await captionFrames(frames, cachePath, deps, { concurrency: 2, retryFailed: true })).toEqual({ done: 1, failed: 0, skipped: 2 });
    const cache = readCache(cachePath(DAY));
    expect([...cache.values()].every((c) => c.ok)).toBe(true);
    expect(writeSidecar(a.home, DAY, cache)).toBe(3);
    const side = readFrameSidecars(a.home, [DAY]);
    expect(side.invalid).toBe(0);
    expect(side.frames).toHaveLength(3);
    for (const n of side.frames) {
      expect(n.activity).not.toContain("example.com");
      expect(n.activity).not.toContain("12345");
      expect(n.counterpart).toBe("<name>");
      expect(n.model).toBe("ollama:test");
    }
  });
});
