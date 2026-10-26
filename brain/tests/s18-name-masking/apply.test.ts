// NOTES, SPANS: names never reach a stored frame note (every captioner goes through maskFields before storage) or a
// span description (fields and the embedded text).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePersona, writePersona, type PersonaId } from "../../fixtures/gen-domains.ts";
import { REPORT_START, reportNow } from "../../fixtures/domains-report.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { localDay } from "../../src/store/vault.ts";
import { describeSpans } from "../../src/understanding/describe.ts";
import { ClaudeCaptioner } from "../../src/vision/claude.ts";
import { ObserverFrameSource } from "../../src/vision/frames.ts";
import { maskFields, notesPath, readFrameNotes } from "../../src/vision/notes.ts";
import { userPrompt } from "../../src/vision/prompt.ts";
import type { Captioner, CaptionFields, FrameRef } from "../../src/vision/types.ts";
import { CaptionWorker } from "../../src/vision/worker.ts";
import { writeFrame } from "../s11-perception/support.ts";
import type { Span } from "../../src/types.ts";
import { FIXTURE_FIRST, FIXTURE_LAST, readable } from "./names.ts";

const homes: string[] = [];
const tmp = (p = "offload-s18-") => {
  const h = mkdtempSync(join(tmpdir(), p));
  homes.push(h);
  return h;
};
process.on("exit", () => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** What a captioner (local or Claude) may return when it ignores "never a person's name". */
const NAMED: CaptionFields = {
  activity: "Writing a scorecard for Amara Okafor in Greenhouse",
  verb: "write",
  object: "candidate scorecard",
  counterpart: "Amara Okafor",
  surface: "Greenhouse candidate page",
  step: "moving Okafor to the onsite stage",
  inputs: ["CV of Amara Okafor", "job spec: Product Designer"],
  outputs: ["scorecard for Amara", "stage change"],
  identifiers: ["greenhouse 48213"],
  confidence: 0.9,
};

class NamedCaptioner implements Captioner {
  readonly kind = "stub" as const;
  readonly model = "named";
  readonly id = "named";
  async caption(): Promise<CaptionFields> {
    return structuredClone(NAMED);
  }
  async health() {
    return { ok: true, detail: "named" };
  }
}

describe("s18 frame notes", () => {
  test("NOTES: maskFields masks names in activity, step, inputs and outputs; counterpart is <name>; identifiers stay", () => {
    const m = maskFields(NAMED);
    expect(m.activity).toBe("Writing a scorecard for <name> in Greenhouse");
    expect(m.step).toBe("moving <name> to the onsite stage");
    expect(m.inputs).toEqual(["CV of <name>", "job spec: Product Designer"]);
    expect(m.outputs).toEqual(["scorecard for <name>", "stage change"]);
    expect(m.counterpart).toBe("<name>");
    expect(m.surface).toBe("Greenhouse candidate page");
    expect(m.identifiers).toEqual(["greenhouse <n>"]);
    expect(JSON.stringify(m)).not.toMatch(/Amara|Okafor/);
  });

  test("NOTES: organisations and roles in a note are kept", () => {
    const m = maskFields({ activity: "Keying a supplier bill from Brightline Couriers into Xero", counterpart: "Brightline Couriers", inputs: ["invoice number", "amount"], outputs: ["draft bill"], confidence: 0.8 });
    expect(m.activity).toBe("Keying a supplier bill from Brightline Couriers into Xero");
    expect(m.counterpart).toBe("Brightline Couriers");
  });

  test("NOTES: engine keyframe -> captioner that writes names -> sealed note on disk carries no name", async () => {
    const home = tmp();
    const now = Date.now();
    const day = localDay(now);
    const base = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate(), 0, 30).getTime();
    for (let i = 0; i < 3; i++) writeFrame(home, base + i * 60_000, Buffer.from(`jpeg-${i}`), { app: "com.google.Chrome", appName: "Google Chrome", host: "app.greenhouse.io" });
    const worker = new CaptionWorker({ home, source: new ObserverFrameSource(home, { ...process.env, OFFLOAD_KEYS: "file" }), captioner: new NamedCaptioner(), now: () => now, log: () => {} });
    while ((await worker.runOnce()) > 0);
    const notes = readFrameNotes(home, day, now);
    expect(notes.length).toBe(3);
    for (const n of notes) expect(JSON.stringify(n)).not.toMatch(/Amara|Okafor/);
    expect(notes[0]!.activity).toBe("Writing a scorecard for <name> in Greenhouse");
    expect(readFileSync(notesPath(home, day), "utf8")).not.toMatch(/Amara|Okafor/);
  });

  test("NOTES: the Claude captioner's note is masked the same way before it is stored", async () => {
    const home = tmp();
    const now = new Date(2026, 9, 25, 12).getTime();
    const ref: FrameRef = { frameId: "kf_1", ts: now - 60_000, day: localDay(now - 60_000), app: "com.google.Chrome", appName: "Google Chrome", host: "app.greenhouse.io", width: 1280, height: 800, bytes: 4, maskedRegions: 1 };
    const reply = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify({ ...NAMED, verb: "write" }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    const fetch = async () => new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    const source = { days: () => [ref.day], list: () => ({ frames: [ref] }), read: () => new Uint8Array([9]) } as unknown as ObserverFrameSource;
    const w = new CaptionWorker({ home, source, captioner: new ClaudeCaptioner({ env: { ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000" }, fetch, maxRetries: 0 }), now: () => now, log: () => {} });
    await w.runOnce();
    const notes = readFrameNotes(home, ref.day, now);
    expect(notes.length).toBe(1);
    expect(JSON.stringify(notes[0])).not.toMatch(/Amara|Okafor/);
  });

  test("NOTES: the caption prompt's onboarding hint carries no person name", () => {
    const p = userPrompt({ frameId: "kf", ts: 1, day: "2026-10-25", width: 1, height: 1, bytes: 1, maskedRegions: 0 }, { role: "Recruiter for Kofi Larsen", industry: "Staffing" });
    expect(p).not.toMatch(/Kofi|Larsen/);
    expect(p).toContain("Recruiter for <name>");
  });
});

describe("s18 span descriptions", () => {
  const span = (id: string, title: string, start: number): Span => ({ id, day: "2026-10-12", start, end: start + 60_000, activeMs: 60_000, app: "com.apple.Preview", appName: "Preview", host: "", url: "", title, keys: 0, clicks: 2, eventIds: [`e${id}`], ocr: [] }) as unknown as Span;

  test("SPANS: a rules-only description of a CV title keeps no name in any field or in its embedded text", () => {
    const [d] = describeSpans([span("1", "CV - Siobhan Kowalczyk.pdf", 0)], new Map());
    for (const k of ["activity", "object", "surface", "step", "text", "counterpart"] as const) expect({ k, v: d![k] }).not.toEqual({ k, v: expect.stringMatching(/Siobhan|Kowalczyk/) });
    expect(d!.title).toBe("CV - Siobhan Kowalczyk.pdf");
  });

  test("SPANS: a name in a frame note's step is masked using the names learned from the run's titles", () => {
    const s = span("1", "CV - Siobhan Kowalczyk.pdf", 0);
    const frames = new Map([["1", [{ id: "f1", ts: 10_000, kind: "frame" as const, frameId: "kf1", model: "stub", activity: "Reviewing Kowalczyk's CV", verb: "review", object: "CV", step: "reading Kowalczyk's experience", surface: "Preview PDF viewer", confidence: 0.9 }]]]);
    const [d] = describeSpans([s], frames);
    expect(d!.activity).toBe("Reviewing <name>'s CV");
    expect(d!.step).toBe("reading <name>'s experience");
    expect(d!.text).not.toMatch(/Kowalczyk/);
  });

  for (const p of ["recruiter", "bookkeeper", "support", "salesops"] as PersonaId[]) {
    test(`SPANS: the ${p} week's v2 descriptions carry no fixture person name`, async () => {
      const home = tmp(`offload-s18-${p}-`);
      writePersona(home, generatePersona(p, { seed: 7, startDay: REPORT_START }), { encrypted: false, seed: 7 });
      const a = await analyzeHome(home, { now: reportNow, understanding: "v2" });
      const descs = a.understanding!.descriptions;
      expect(descs.length).toBeGreaterThan(50);
      const leaks: string[] = [];
      for (const d of descs) for (const v of [d.activity, d.object, d.surface, d.step, d.text, d.counterpart]) if (readable(v, [...FIXTURE_FIRST, ...FIXTURE_LAST])) leaks.push(v);
      expect(leaks.slice(0, 5)).toEqual([]);
    });
  }
});
