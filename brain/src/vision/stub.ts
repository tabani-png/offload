// Deterministic, offline captioner for tests, fixtures and demos (SPEC C2). Same frame bytes + metadata = same note.
import { createHash } from "node:crypto";
import type { Captioner, CaptionerHealth, CaptionFields, CaptionInput } from "./types.ts";

const VERBS = ["reviewing", "entering", "editing", "reading", "comparing", "updating"] as const;
const STEPS = ["reading the source", "filling a form", "checking a result", "editing a record"] as const;

export class StubCaptioner implements Captioner {
  readonly kind = "stub" as const;
  readonly model = "stub";
  readonly id = "stub";
  /** Number of caption calls (tests). */
  calls = 0;

  async caption(input: CaptionInput, signal?: AbortSignal): Promise<CaptionFields> {
    if (signal?.aborted === true) throw new Error("aborted");
    this.calls += 1;
    const h = createHash("sha256").update(input.image).update(`\u0000${input.ref.app ?? ""}\u0000${input.ref.host ?? ""}`).digest();
    const verb = VERBS[h[0]! % VERBS.length]!;
    const step = STEPS[h[1]! % STEPS.length]!;
    const where = input.ref.host ?? input.ref.appName ?? input.ref.app ?? "an app";
    const surface = [input.ref.appName ?? input.ref.app, input.ref.host].filter((x) => x !== undefined && x !== "").join(" ") || "unknown app";
    return {
      activity: `${verb[0]!.toUpperCase()}${verb.slice(1)} a record in ${where}`,
      verb,
      object: "record",
      surface,
      step,
      inputs: ["on-screen record"],
      outputs: [],
      identifiers: input.ref.host === undefined ? [] : [input.ref.host],
      confidence: 0.5,
    };
  }

  async health(): Promise<CaptionerHealth> {
    return { ok: true, detail: "stub" };
  }
}
