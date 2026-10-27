import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import type { StatusResponse } from "../../src/api/types.ts";
import { parseArgs, visionWorker } from "../../src/cli.ts";
import { clearBrainKeyCache, localDay, purgeExpired } from "../../src/store/vault.ts";
import { FrameReadError, ObserverFrameSource } from "../../src/vision/frames.ts";
import { appendNotes, buildNote, listNoteDays, notesPath, readFrameNotes, readFrameNotesDetailed } from "../../src/vision/notes.ts";
import { CaptionerFatalError } from "../../src/vision/ollama.ts";
import { StubCaptioner } from "../../src/vision/stub.ts";
import type { Captioner, CaptionFields, CaptionInput, FrameRef } from "../../src/vision/types.ts";
import { CaptionWorker } from "../../src/vision/worker.ts";
import { tempHome } from "../helpers.ts";
import { fakeFrameObserver, writeFrame } from "./support.ts";

const homes: Array<() => void> = [];
function home(): string {
  const h = tempHome();
  homes.push(h.cleanup);
  return h.home;
}
afterEach(() => {
  while (homes.length > 0) homes.pop()!();
  clearBrainKeyCache();
});

const NOW = Date.now();
const FILE_ENV = { OFFLOAD_KEYS: "file" } as const;

class ScriptedCaptioner implements Captioner {
  readonly kind = "ollama" as const;
  readonly model = "test-model";
  readonly id = "ollama:test-model";
  calls = 0;
  constructor(
    private readonly fn: (n: number, image: string) => CaptionFields | Error,
    private readonly ok = true,
  ) {}
  async caption(input: CaptionInput): Promise<CaptionFields> {
    this.calls += 1;
    const r = this.fn(this.calls, Buffer.from(input.image).toString());
    if (r instanceof Error) throw r;
    return r;
  }
  async health() {
    return this.ok ? { ok: true, detail: "ready" } : { ok: false, detail: "ollama unreachable at http://127.0.0.1:11434: ECONNREFUSED" };
  }
}

describe("s11 frame source", () => {
  test("C6: file mode lists and reads frames written in the engine format", () => {
    const h = home();
    const a = writeFrame(h, NOW - 60_000, Buffer.from("frame-a"));
    const b = writeFrame(h, NOW, Buffer.from("frame-b"));
    const src = new ObserverFrameSource(h, FILE_ENV);
    expect(src.days()).toEqual([...new Set([a.day, b.day])].sort());
    const listing = src.list(b.day, NOW);
    expect(listing.expired).toBe(false);
    expect(listing.frames.map((f) => f.frameId)).toContain(b.frameId);
    expect(Buffer.from(src.read(b, NOW)!).toString()).toBe("frame-b");
  });

  test("C6: a blob renamed to another id does not open; expired days are not read", () => {
    const h = home();
    const a = writeFrame(h, NOW, Buffer.from("frame-a"));
    const fake = { ...a, frameId: "01JB00000000000000000ZZZZZ" };
    copyFileSync(join(h, "frames", a.day, `${a.frameId}.enc`), join(h, "frames", a.day, `${fake.frameId}.enc`));
    const src = new ObserverFrameSource(h, FILE_ENV);
    expect(() => src.read(fake, NOW)).toThrow(FrameReadError);
    const old = writeFrame(h, NOW - 32 * 86_400_000);
    expect(src.list(old.day, NOW)).toEqual({ frames: [], expired: true });
    expect(src.read(old, NOW)).toBeNull();
  });

  test("C6: keychain mode goes through the observer CLI with the minimal child environment", () => {
    const h = home();
    const bin = fakeFrameObserver(h);
    const day = localDay(NOW);
    mkdirSync(join(h, "frames", day), { recursive: true });
    const id = "01JB0000000000000000000ABC";
    writeFileSync(join(h, "frames", day, "plain-index.jsonl"), JSON.stringify({ frameId: id, ts: NOW, app: "a", appName: "A", phash: "0123456789abcdef", width: 10, height: 10, bytes: 3, maskedRegions: 0 }) + "\nnot json\n");
    writeFileSync(join(h, "frames", day, `${id}.jpg`), Buffer.from([1, 2, 3]));
    const src = new ObserverFrameSource(h, { OFFLOAD_OBSERVER_BIN: bin, PATH: process.env.PATH, HOME: process.env.HOME, OFFLOAD_TOKEN: "secret-token", ANTHROPIC_API_KEY: "sk-x" });
    const listing = src.list(day, NOW);
    expect(listing.frames).toHaveLength(1);
    expect(listing.frames[0]!.day).toBe(day);
    expect([...src.read(listing.frames[0]!, NOW)!]).toEqual([1, 2, 3]);
    const env = readFileSync(join(h, "env.log"), "utf8");
    expect(env).not.toContain("secret-token");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).toContain(`OFFLOAD_HOME=${h}`);
    writeFileSync(join(h, `expired-${day}`), "");
    expect(src.list(day, NOW).expired).toBe(true);
  });

  test("C6: a missing observer binary is a listing error, not a crash", () => {
    const h = home();
    const src = new ObserverFrameSource(h, { OFFLOAD_OBSERVER_BIN: join(h, "nope") });
    expect(src.list(localDay(NOW), NOW).error).toContain("does not exist");
  });
});

describe("s11 notes store", () => {
  const ref = (h: string, ts = NOW): FrameRef => writeFrame(h, ts);

  test("C7: notes are sealed under the capture day and read back", () => {
    const h = home();
    const r = ref(h);
    const n = buildNote(r, { activity: "Entering a bill", confidence: 0.9 }, "stub");
    expect(appendNotes(h, [n], NOW, FILE_ENV, () => r.day)).toEqual([r.day]);
    const raw = readFileSync(notesPath(h, r.day), "utf8");
    expect(raw.startsWith(`OBV1 ${r.day}\n`)).toBe(true);
    expect(raw).not.toContain("Entering a bill");
    expect(readFrameNotes(h, r.day, NOW, FILE_ENV)).toEqual([n]);
    expect(listNoteDays(h)).toEqual([r.day]);
  });

  test("C7: a second note for the same frame replaces the first", () => {
    const h = home();
    const r = ref(h);
    appendNotes(h, [buildNote(r, { activity: "First", confidence: 0.5 }, "stub")], NOW, FILE_ENV, () => r.day);
    appendNotes(h, [buildNote(r, { activity: "Second", confidence: 0.5 }, "stub")], NOW, FILE_ENV, () => r.day);
    const notes = readFrameNotes(h, r.day, NOW, FILE_ENV);
    expect(notes.map((x) => x.activity)).toEqual(["Second"]);
  });

  test("C7: the brain purge deletes expired note files and their key", () => {
    const h = home();
    const r = ref(h, NOW - 3 * 86_400_000);
    appendNotes(h, [buildNote(r, { activity: "Old", confidence: 0.5 }, "stub")], NOW, FILE_ENV, () => r.day);
    expect(existsSync(notesPath(h, r.day))).toBe(true);
    const res = purgeExpired(h, NOW + 29 * 86_400_000, { log: () => {} });
    expect(res.files).toBeGreaterThanOrEqual(1);
    expect(existsSync(notesPath(h, r.day))).toBe(false);
    expect(readFrameNotes(h, r.day, NOW + 29 * 86_400_000, FILE_ENV)).toEqual([]);
  });

  test("C7: expired days are never written or read", () => {
    const h = home();
    const old = NOW - 32 * 86_400_000;
    const r: FrameRef = { frameId: "01JB000000000000000000000Q", ts: old, day: localDay(old), width: 1, height: 1, bytes: 1, maskedRegions: 0 };
    expect(appendNotes(h, [buildNote(r, { activity: "x", confidence: 0.5 }, "stub")], NOW, FILE_ENV, () => r.day)).toEqual([]);
    expect(readFrameNotesDetailed(h, r.day, NOW, FILE_ENV)).toEqual({ notes: [], bad: 0 });
  });
});

describe("s11 worker", () => {
  function setup(n: number, captioner: Captioner, opts: { maxQueue?: number } = {}) {
    const h = home();
    const refs = Array.from({ length: n }, (_, i) => writeFrame(h, NOW - (n - i) * 30_000, Buffer.from(`f${i}`)));
    const w = new CaptionWorker({ home: h, source: new ObserverFrameSource(h, FILE_ENV), captioner, env: FILE_ENV, now: () => NOW, log: () => {}, ...opts });
    return { h, refs, w };
  }

  test("C8: captions every new frame once and writes masked, valid notes", async () => {
    const cap = new ScriptedCaptioner((i) => ({ activity: `Replying to ana@example.com about case ${1000 + i}`, identifiers: ["CASE-1001"], confidence: 0.7 }));
    const { h, refs, w } = setup(4, cap);
    expect(await w.runOnce()).toBe(4);
    expect(await w.runOnce()).toBe(0);
    expect(cap.calls).toBe(4);
    const notes = refs.flatMap((r) => readFrameNotes(h, r.day, NOW, FILE_ENV)).filter((n, i, a) => a.findIndex((m) => m.id === n.id) === i);
    expect(notes).toHaveLength(4);
    for (const n of notes) {
      expect(n.activity).toContain("<email>");
      expect(n.activity).not.toContain("ana@example.com");
      expect(n.model).toBe("ollama:test-model");
      expect(n.app).toBe("com.google.Chrome");
    }
    const s = w.status();
    expect(s).toMatchObject({ enabled: true, captioner: "ollama", model: "test-model", healthy: true, queueDepth: 0, processed: 4, failed: 0, skipped: 0, lastError: null });
    expect(s.lastCaptionAt).toBe(NOW);
  });

  test("C8: the queue is capped (backpressure) and the rest is picked up on later polls", async () => {
    const cap = new StubCaptioner();
    const { w } = setup(5, cap, { maxQueue: 2 });
    expect(w.poll()).toBe(2);
    expect(w.poll()).toBe(0);
    expect(w.queueDepth).toBe(2);
    expect(await w.runOnce()).toBe(2);
    expect(await w.runOnce()).toBe(2);
    expect(await w.runOnce()).toBe(1);
    expect(cap.calls).toBe(5);
  });

  test("C8: a frame failing 3 times is skipped; others still get notes", async () => {
    const cap = new ScriptedCaptioner((_, image) => (image === "f0" ? new Error("ollama answered HTTP 500") : { activity: "Reading a page", confidence: 0.5 }));
    const { w } = setup(2, cap);
    await w.runOnce();
    const s = w.status();
    expect(cap.calls).toBe(4);
    expect(s.processed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.lastError).toBe("ollama answered HTTP 500");
    expect(await w.runOnce()).toBe(0);
  });

  test("C8: an unhealthy or fatal captioner keeps frames queued and reports why", async () => {
    const down = new ScriptedCaptioner(() => ({ activity: "x", confidence: 1 }), false);
    const a = setup(2, down);
    expect(await a.w.runOnce()).toBe(0);
    expect(down.calls).toBe(0);
    expect(a.w.status()).toMatchObject({ healthy: false, queueDepth: 2, lastError: "ollama unreachable at http://127.0.0.1:11434: ECONNREFUSED" });
    const fatal = new ScriptedCaptioner(() => new CaptionerFatalError("model qwen3-vl:8b-instruct is not pulled (ollama pull qwen3-vl:8b-instruct)"));
    const b = setup(1, fatal);
    await b.w.runOnce();
    expect(b.w.status()).toMatchObject({ healthy: false, queueDepth: 1, processed: 0, failed: 0 });
    expect(b.w.status().lastError).toContain("not pulled");
  });

  test("C8: a frame purged before captioning is skipped", async () => {
    const cap = new StubCaptioner();
    const { h, refs, w } = setup(1, cap);
    w.poll();
    const r = refs[0]!;
    // Remove the blob after it was listed.
    const p = join(h, "frames", r.day, `${r.frameId}.enc`);
    rmSync(p);
    await w.runOnce();
    expect(w.status().skipped).toBe(1);
    expect(cap.calls).toBe(0);
  });

  test("C8: status errors carry no note text", async () => {
    const cap = new ScriptedCaptioner(() => new Error("line one\nline two"));
    const { w } = setup(1, cap);
    await w.runOnce();
    expect(w.status().lastError).toBe("line one line two");
  });
});

describe("s11 serve", () => {
  test("C9: --captioner, --vision-model and --ollama-url parse; non-loopback URLs are usage errors", () => {
    const a = parseArgs(["serve", "--home", "/tmp/x", "--captioner", "ollama", "--vision-model", "qwen3-vl:2b-instruct", "--ollama-url", "http://localhost:11434"]);
    expect(a.captioner).toBe("ollama");
    expect(a.visionModel).toBe("qwen3-vl:2b-instruct");
    expect(parseArgs(["serve", "--home", "/tmp/x"]).captioner).toBe("off");
    expect(parseArgs(["serve", "--home", "/tmp/x"]).visionModel).toBe("auto");
    // s14 scope change: claude and auto are captioners now (ADR 0008); an unknown one is still a usage error.
    expect(parseArgs(["serve", "--home", "/tmp/x", "--captioner", "claude"]).captioner).toBe("claude");
    expect(() => parseArgs(["serve", "--home", "/tmp/x", "--captioner", "gpt"])).toThrow("--captioner must be off, stub, ollama, claude or auto");
    expect(() => parseArgs(["serve", "--home", "/tmp/x", "--ollama-url", "http://10.1.1.1:11434"])).toThrow("must be loopback");
    expect(visionWorker({ home: "/tmp/x", captioner: "off", visionModel: "auto", ollamaUrl: "http://127.0.0.1:11434" })).toBeUndefined();
    expect(visionWorker({ home: "/tmp/x", captioner: "stub", visionModel: "auto", ollamaUrl: "http://127.0.0.1:11434" })!.status().captioner).toBe("stub");
  });

  test("C9: GET /status carries the captioner fields", async () => {
    const h = home();
    writeFrame(h, NOW, Buffer.from("x"));
    const TOKEN = "t".repeat(48);
    const req = () => new Request("http://127.0.0.1:4545/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    const off = await (await createBrain({ home: h, token: TOKEN }).handle(req())).json() as StatusResponse;
    expect(off.captioner).toEqual({ enabled: false, captioner: "off", model: null, healthy: null, queueDepth: 0, processed: 0, failed: 0, skipped: 0, lastPollAt: null, lastCaptionAt: null, lastLatencyMs: null, lastError: null });
    const w = new CaptionWorker({ home: h, source: new ObserverFrameSource(h, FILE_ENV), captioner: new StubCaptioner(), env: FILE_ENV, log: () => {} });
    await w.runOnce();
    const on = await (await createBrain({ home: h, token: TOKEN, vision: w }).handle(req())).json() as StatusResponse;
    expect(on.captioner).toMatchObject({ enabled: true, captioner: "stub", model: "stub", healthy: true, processed: 1, queueDepth: 0 });
  });
});

// Cross-language: frames written by the real Swift FrameStore (slices/s11-perception/verify.sh sets S11_FIXTURE_HOME
// and OFFLOAD_OBSERVER_BIN). Skipped in a plain `bun test`.
const FIXTURE = process.env.S11_FIXTURE_HOME ?? "";
const BIN = process.env.OFFLOAD_OBSERVER_BIN ?? "";
const haveFixture = FIXTURE !== "" && existsSync(join(FIXTURE, "fixture.json")) && BIN !== "" && existsSync(BIN);

describe("s11 cross-language", () => {
  const info = haveFixture ? (JSON.parse(readFileSync(join(FIXTURE, "fixture.json"), "utf8")) as { frameId: string; day: string; sha256: string; bytes: number }) : null;
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  test.skipIf(!haveFixture)("XL: the brain decrypts an engine-written frame in process", () => {
    const src = new ObserverFrameSource(FIXTURE, FILE_ENV, { inProcess: true });
    const listing = src.list(info!.day, Date.now());
    const ref = listing.frames.find((f) => f.frameId === info!.frameId)!;
    expect(ref).toBeDefined();
    expect(ref.bytes).toBe(info!.bytes);
    expect(sha(src.read(ref, Date.now())!)).toBe(info!.sha256);
  });

  test.skipIf(!haveFixture)("XL: the brain reads the same frame through the real export-frame", () => {
    const src = new ObserverFrameSource(FIXTURE, { OFFLOAD_OBSERVER_BIN: BIN, OFFLOAD_KEYS: "file", PATH: process.env.PATH, HOME: process.env.HOME }, { inProcess: false });
    const listing = src.list(info!.day, Date.now());
    expect(listing.error).toBeUndefined();
    const ref = listing.frames.find((f) => f.frameId === info!.frameId)!;
    expect(sha(src.read(ref, Date.now())!)).toBe(info!.sha256);
  });

  test.skipIf(!haveFixture)("XL: the stub pipeline turns the engine frame into a valid note", async () => {
    const w = new CaptionWorker({ home: FIXTURE, source: new ObserverFrameSource(FIXTURE, FILE_ENV), captioner: new StubCaptioner(), env: FILE_ENV, log: () => {} });
    await w.runOnce(); // a second run (verify.sh runs the tag again) finds the note already written
    expect(w.status().failed).toBe(0);
    expect(readFrameNotes(FIXTURE, info!.day, Date.now(), FILE_ENV).some((n) => n.frameId === info!.frameId)).toBe(true);
  });
});
