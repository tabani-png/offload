// AC-1 FRAMES: schema-driven validation, frames from events and the fixture sidecar, attachment to spans.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptLine, KEY_BYTES, NONCE_BYTES } from "../../src/store/crypto.ts";
import { attachFrames, framesFromEvents, readFrameSidecars, validateFrameNote, type FrameNote } from "../../src/understanding/frames.ts";
import { tempHome } from "../helpers.ts";
import { span } from "./setup.ts";

const note = (over: Partial<FrameNote> = {}): FrameNote => ({ id: "f1", ts: 1000, kind: "frame", frameId: "kf_1", model: "stub", activity: "Reading a supplier invoice PDF", confidence: 0.9, ...over });

describe("FRAMES validation (schemas/frame-note.schema.json)", () => {
  test("a stub captioner note is valid", () => {
    const r = validateFrameNote(note({ verb: "read", object: "invoice", identifiers: ["inv-1"], inputs: ["amount"], app: "com.apple.Preview" }));
    expect(r.ok).toBe(true);
  });
  test("missing required fields and unknown properties are rejected", () => {
    const { activity: _a, ...noActivity } = note();
    expect(validateFrameNote(noActivity).ok).toBe(false);
    expect(validateFrameNote({ ...note(), image: "base64..." }).ok).toBe(false);
    expect(validateFrameNote({ ...note(), kind: "ocr" }).ok).toBe(false);
  });
  test("limits from the schema hold: maxLength, maxItems, confidence 0..1", () => {
    expect(validateFrameNote(note({ activity: "x".repeat(201) })).ok).toBe(false);
    expect(validateFrameNote(note({ identifiers: Array.from({ length: 13 }, (_, i) => `id${i}`) })).ok).toBe(false);
    expect(validateFrameNote(note({ confidence: 1.2 })).ok).toBe(false);
    expect(validateFrameNote(note({ confidence: -0.1 })).ok).toBe(false);
    expect(validateFrameNote(note({ ts: 1.5 })).ok).toBe(false);
  });
});

describe("FRAMES sources", () => {
  test("framesFromEvents takes kind=frame only and counts invalid notes", () => {
    const r = framesFromEvents([{ id: "e1", ts: 1, kind: "focus" }, note(), { ...note({ id: "f2" }), confidence: 3 }]);
    expect(r.frames.map((f) => f.id)).toEqual(["f1"]);
    expect(r.invalid).toBe(1);
  });

  test("sidecar: plain and encrypted read the same notes; no key = unreadable, counted", () => {
    const { home, cleanup } = tempHome();
    try {
      const day = "2026-10-14";
      mkdirSync(join(home, "frames"), { recursive: true });
      mkdirSync(join(home, "keys"), { recursive: true });
      const notes = [note({ id: "a", ts: 5 }), note({ id: "b", ts: 2 })];
      writeFileSync(join(home, "frames", `${day}.jsonl`), notes.map((n) => JSON.stringify(n)).join("\n") + "\nnot json\n");
      const plain = readFrameSidecars(home, [day]);
      expect(plain.frames.map((f) => f.id)).toEqual(["b", "a"]);
      expect(plain.invalid).toBe(1);
      rmSync(join(home, "frames", `${day}.jsonl`));
      const key = Buffer.alloc(KEY_BYTES, 7);
      writeFileSync(join(home, "keys", `${day}.key`), key);
      writeFileSync(join(home, "frames", `${day}.jsonl.enc`), notes.map((n, i) => encryptLine(key, JSON.stringify(n), Buffer.alloc(NONCE_BYTES, i + 1))).join("\n") + "\n");
      expect(readFrameSidecars(home, [day]).frames.map((f) => f.id)).toEqual(["b", "a"]);
      rmSync(join(home, "keys", `${day}.key`));
      const gone = readFrameSidecars(home, [day]);
      expect(gone.frames).toEqual([]);
      expect(gone.invalid).toBe(2);
      expect(gone.errors[0]).toContain("no raw day key");
    } finally {
      cleanup();
    }
  });

  test("sidecar days older than 30 local days are refused", () => {
    const { home, cleanup } = tempHome();
    try {
      mkdirSync(join(home, "frames"), { recursive: true });
      writeFileSync(join(home, "frames", "2026-10-01.jsonl"), JSON.stringify(note()) + "\n");
      const r = readFrameSidecars(home, ["2026-10-01"], { now: new Date(2026, 10, 1, 12).getTime() });
      expect(r.frames).toEqual([]);
      expect(r.errors[0]).toContain("refused");
    } finally {
      cleanup();
    }
  });

  test("attachFrames: by time inside the span and the same app; notes outside spans are dropped", () => {
    const spans = [span({ id: "sp_a", start: 0, end: 100, app: "com.apple.Preview" }), span({ id: "sp_b", start: 100, end: 200 }), span({ id: "sp_c", start: 500, end: 600 })];
    const m = attachFrames(spans, [note({ id: "1", ts: 10, app: "com.apple.Preview" }), note({ id: "2", ts: 100, app: "com.google.Chrome" }), note({ id: "3", ts: 150, app: "com.apple.Preview" }), note({ id: "4", ts: 300 }), note({ id: "5", ts: 550 })]);
    expect(m.get("sp_a")?.map((f) => f.id)).toEqual(["1"]);
    expect(m.get("sp_b")?.map((f) => f.id)).toEqual(["2"]);
    expect(m.get("sp_c")?.map((f) => f.id)).toEqual(["5"]);
    expect([...m.values()].flat().some((f) => f.id === "3" || f.id === "4")).toBe(false);
  });
});
