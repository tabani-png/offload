// brain/tools/import-screenwatch.ts on a tiny synthetic archive: no real screenshots, an injected thumbnail function
// and the stub captioner, so it runs offline in milliseconds.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionize, DEFAULT_SESSION_OPTIONS, totalActiveMs } from "../../src/sessionize.ts";
import { readFrameSidecars } from "../../src/understanding/frames.ts";
import { ModelBackend, ModelRouter } from "../../src/models/router.ts";
import { StubModel } from "../../src/models/model.ts";
import { CaptionerFatalError } from "../../src/vision/ollama.ts";
import { SYSTEM_PROMPT } from "../../src/vision/prompt.ts";
import { buildNote, maskFields } from "../../src/vision/notes.ts";
import { StubCaptioner } from "../../src/vision/stub.ts";
import type { Captioner, CaptionFields } from "../../src/vision/types.ts";
import type { OffloadEvent } from "../../src/types.ts";
import {
  activityRuns,
  buildEvents,
  CAPTION_ADDENDUM,
  captionFrames,
  captionStats,
  claudeCaptioner,
  costCapReached,
  frameKey,
  GENERIC_VERBS,
  promptFetch,
  regroupDay,
  regroupEvents,
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
    expect(first).toEqual({ done: 2, failed: 1, skipped: 0, stopped: null });
    // resume without retry: nothing to do
    expect(await captionFrames(frames, cachePath, deps, { concurrency: 2, retryFailed: false })).toEqual({ done: 0, failed: 0, skipped: 3, stopped: null });
    fail = false;
    expect(await captionFrames(frames, cachePath, deps, { concurrency: 2, retryFailed: true })).toEqual({ done: 1, failed: 0, skipped: 2, stopped: null });
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

// ---------------------------------------------------------------- v2: Claude captions, cost cap, regrouping

/** A fetch that answers like the Messages API and records every request body. */
function fakeAnthropic(text: string) {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  return { fetch: f, seen };
}
const CLAUDE_NOTE = JSON.stringify({ activity: "Writing a reply in the support inbox", verb: "writing", object: "support reply", counterpart: "a customer", surface: "Helpdesk - Inbox", step: "drafting", inputs: ["ticket"], outputs: ["reply"], identifiers: [], confidence: 0.8 });

describe("v2: Claude captioning through the router", () => {
  test("the importer's rules are appended to the system prompt; requests still go only to api.anthropic.com on the router's Haiku", async () => {
    const home = tmp();
    const router = new ModelRouter({ home, backend: new ModelBackend("stub", new StubModel()), monthlyBudgetUsd: null });
    const api = fakeAnthropic(CLAUDE_NOTE);
    const c = claudeCaptioner({ router, env: { ANTHROPIC_API_KEY: "sk-ant-test-0000" }, fetch: api.fetch, maxRetries: 0 });
    const f = await c.caption({ image: new Uint8Array([1, 2]), ref: { frameId: "f1", ts: 1, day: DAY, width: 10, height: 10, bytes: 2, maskedRegions: 0 } });
    expect(f.verb).toBe("writing");
    expect(c.id).toBe("claude:claude-haiku-5-5");
    const body = api.seen[0]!.body as { model: string; system: string };
    expect(new URL(api.seen[0]!.url).host).toBe("api.anthropic.com");
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(body.system.endsWith(CAPTION_ADDENDUM)).toBe(true);
    // 2000 in + 200 out on Haiku = 0.0002 + 0.0001
    expect(router.spentUsd()).toBeCloseTo(0.0003, 6);
  });

  test("the addendum asks for the app or site, the specific object and a concrete verb, and limits 'reviewing'", () => {
    const a = CAPTION_ADDENDUM.toLowerCase();
    for (const w of ["app or web site", "object", "verb", "reviewing", "only reading"]) expect(a).toContain(w);
  });

  test("promptFetch never lets a non-Anthropic host through (the captioner's guard runs first) and leaves other bodies alone", async () => {
    const seen: string[] = [];
    const inner = async (_i: string | URL | Request, init?: RequestInit) => (seen.push(String(init?.body)), new Response("{}"));
    const f = promptFetch("EXTRA", inner);
    await f("https://api.anthropic.com/v1/models/x", { method: "GET" });
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ system: "S", messages: [] }) });
    expect(seen[0]).toBe("undefined");
    expect(JSON.parse(seen[1]!).system).toBe("S\n\nEXTRA");
  });
});

describe("v2: cost cap and persistent errors", () => {
  test("costCapReached counts the frames already in flight", () => {
    expect(costCapReached({ spentUsd: 0, avgUsd: 0, inFlight: 8, maxUsd: 15 })).toBe(false);
    expect(costCapReached({ spentUsd: 14.99, avgUsd: 0.002, inFlight: 8, maxUsd: 15 })).toBe(true);
    expect(costCapReached({ spentUsd: 15, avgUsd: 0, inFlight: 0, maxUsd: 15 })).toBe(true);
    expect(costCapReached({ spentUsd: 1, avgUsd: 0.001, inFlight: 8, maxUsd: 15 })).toBe(false);
  });

  function frames(n: number): ManifestFrame[] {
    return Array.from({ length: n }, (_, i) => ({ frameId: `f${i}`, ts: (BASE + i * 60) * 1000, day: DAY, src: "", phash: "0".repeat(16), width: 1, height: 1, bytes: 1 }));
  }

  test("a stop condition ends the run cleanly: frames not started stay uncached and are done on resume", async () => {
    const work = tmp();
    const cachePath = (d: string) => join(work, "notes-cache", `${d}.jsonl`);
    const stub = new StubCaptioner();
    let calls = 0;
    const deps = { captioner: { ...stub, kind: stub.kind, model: stub.model, id: stub.id, health: () => stub.health(), caption: (i: Parameters<typeof stub.caption>[0]) => (calls++, stub.caption(i)) }, load: async () => new Uint8Array([1]), mask: maskFields, build: buildNote, log: () => {} };
    const r = await captionFrames(frames(10), cachePath, deps, { concurrency: 1, retryFailed: false, shouldStop: () => (calls >= 4 ? "cost cap $15 reached" : null) });
    expect(r).toMatchObject({ done: 4, failed: 0, skipped: 0, stopped: "cost cap $15 reached" });
    expect(readCache(cachePath(DAY)).size).toBe(4);
    const again = await captionFrames(frames(10), cachePath, deps, { concurrency: 3, retryFailed: false });
    expect(again).toMatchObject({ done: 6, skipped: 4, stopped: null });
  });

  test("a fatal captioner error or too many failures in a row stops the run instead of failing every frame", async () => {
    const work = tmp();
    const cachePath = (d: string) => join(work, "notes-cache", `${d}.jsonl`);
    const base = { kind: "claude" as const, model: "m", id: "claude:m", health: async () => ({ ok: true, detail: "ok" }) };
    const fatal = { ...base, caption: async (): Promise<CaptionFields> => { throw new CaptionerFatalError("Claude did not accept the account key (HTTP 401)"); } };
    const deps = { captioner: fatal, load: async () => new Uint8Array([1]), mask: maskFields, build: buildNote, log: () => {} };
    const r = await captionFrames(frames(10), cachePath, deps, { concurrency: 1, retryFailed: false });
    expect(r.failed).toBe(1);
    expect(r.stopped).toContain("HTTP 401");
    const flaky = { ...base, caption: async (): Promise<CaptionFields> => { throw new Error("Claude answered HTTP 529"); } };
    const r2 = await captionFrames(frames(30), (d) => join(work, "c2", `${d}.jsonl`), { ...deps, captioner: flaky }, { concurrency: 1, retryFailed: false, maxConsecutiveFailures: 5 });
    expect(r2.failed).toBe(5);
    expect(r2.stopped).toContain("5 frames failed in a row");
  });
});

describe("v2: regrouping spans by captioned task", () => {
  test("frameKey: app part of the surface + verb, normalised; the object may vary; no note = no key", () => {
    const n = (surface: string, verb: string, object: string) => ({ activity: "x", surface, verb, object, confidence: 1 });
    expect(frameKey(n("Helpdesk - Inbox", "Writing", "Support reply."))).toBe(frameKey(n("helpdesk — Ticket 3", "writing", "support reply")));
    expect(frameKey(n("Helpdesk - Inbox", "writing", "support reply"))).not.toBe(frameKey(n("Helpdesk - Inbox", "reviewing", "support reply")));
    expect(frameKey(n("Claude desktop app, New session view", "prompting", "pull request"))).toBe(frameKey(n("Claude app - Trade UI session", "prompting", "coding session")));
    expect(frameKey(n("Claude app", "prompting", "x"))).not.toBe(frameKey(n("Terminal", "prompting", "x")));
    expect(frameKey(undefined)).toBeNull();
  });

  test("consecutive frames with the same key in one activity run become one span; idle and changes split", () => {
    // run 1: 0..600 s, frames at 30 (A), 90 (A), 200 (B), 380 (A); run 2: 1000..1300 s, frame at 1000 (A, opens the run)
    const rows = parseLog([...Array.from({ length: 121 }, (_, i) => row(i * 5)), ...Array.from({ length: 61 }, (_, i) => row(1000 + i * 5))].join("\n")).rows;
    const runs = activityRuns(rows);
    const at = [30, 90, 200, 380, 1000];
    const kept: Candidate[] = at.map((s, i) => ({ ts: (BASE + s) * 1000, t: stamp(s), hashes: hashesFromThumb(thumb(i)) }));
    const events = buildEvents(DAY, runs, kept);
    const keys = new Map<number, string | null>([[30, "A"], [90, "A"], [200, "B"], [380, "A"], [1000, "A"]].map(([s, k]) => [(BASE + (s as number)) * 1000, k as string]));
    const out = regroupEvents(events, keys);
    const spans = sessionize(out, DAY, DEFAULT_SESSION_OPTIONS);
    // the frameless lead-in (0..30) joins the first frame's span; 30 and 90 merge; B and the later A stay apart
    expect(spans.map((s) => [s.start / 1000 - BASE, s.end / 1000 - BASE])).toEqual([[0, 200], [200, 380], [380, 600], [1000, 1300]]);
    expect(totalActiveMs(spans)).toBe(totalActiveMs(sessionize(events, DAY, DEFAULT_SESSION_OPTIONS)));
    // a failed caption (null key) never merges
    const withNull = regroupEvents(events, new Map([...keys, [(BASE + 90) * 1000, null]]));
    expect(sessionize(withNull, DAY, DEFAULT_SESSION_OPTIONS)).toHaveLength(5);
  });

  test("regroupDay rewrites the day from the original events, so running it twice gives the same file", () => {
    const root = tmp();
    const home = join(root, "home");
    const work = join(root, "work");
    const rows = parseLog(Array.from({ length: 121 }, (_, i) => row(i * 5)).join("\n")).rows;
    const kept: Candidate[] = [0, 60, 120].map((s, i) => ({ ts: (BASE + s) * 1000, t: stamp(s), hashes: hashesFromThumb(thumb(i)) }));
    mkdirSync(join(home, "days"), { recursive: true });
    writeFileSync(join(home, "days", `${DAY}.jsonl`), buildEvents(DAY, activityRuns(rows), kept).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const manifest: ManifestFrame[] = kept.map((k, i) => ({ frameId: `f${i}`, ts: k.ts, day: DAY, src: "", phash: "0".repeat(16), width: 1, height: 1, bytes: 1 }));
    mkdirSync(join(work, "manifest"), { recursive: true });
    writeFileSync(join(work, "manifest", `${DAY}.jsonl`), manifest.map((m) => JSON.stringify(m)).join("\n") + "\n");
    mkdirSync(join(work, "notes-cache"), { recursive: true });
    const note = (m: ManifestFrame) => buildNote({ frameId: m.frameId, ts: m.ts, day: DAY, width: 1, height: 1, bytes: 1, maskedRegions: 0 }, { activity: "Writing a reply", verb: "writing", object: "reply", surface: "Helpdesk - Inbox", confidence: 0.9 }, "claude:test");
    writeFileSync(join(work, "notes-cache", `${DAY}.jsonl`), manifest.map((m) => JSON.stringify({ frameId: m.frameId, ok: true, note: note(m), ms: 1 })).join("\n") + "\n");
    const r1 = regroupDay(home, work, DAY);
    const once = readFileSync(join(home, "days", `${DAY}.jsonl`), "utf8");
    const r2 = regroupDay(home, work, DAY);
    expect(readFileSync(join(home, "days", `${DAY}.jsonl`), "utf8")).toBe(once);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ day: DAY, spansBefore: 3, spansAfter: 1 });
  });
});

describe("v2: caption stats", () => {
  test("generic verb share counts reviewing/viewing/reading-type verbs over captioned frames", () => {
    expect(GENERIC_VERBS).toContain("reviewing");
    const line = (verb: string, ok = true) => (ok ? { frameId: verb, ok: true as const, ms: 1, note: buildNote({ frameId: verb + Math.random(), ts: 1, day: DAY, width: 1, height: 1, bytes: 1, maskedRegions: 0 }, { activity: `${verb} x`, verb, object: "x", confidence: 1 }, "m") } : { frameId: verb, ok: false as const, error: "e", ms: 1 });
    const s = captionStats([line("reviewing"), line("Viewing"), line("writing"), line("entering"), line("x", false)]);
    expect(s).toMatchObject({ frames: 5, ok: 4, failed: 1, generic: 2, genericShare: 0.5, reviewing: 1 });
    expect(s.topVerbs).toContainEqual(["reviewing", 1]);
  });
});
