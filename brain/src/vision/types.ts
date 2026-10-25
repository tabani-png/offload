// Perception types (ADR 0007, slices/s11-perception/SPEC.md). A Frame note is what a LOCAL vision model saw on one
// masked keyframe; its shape is schemas/frame-note.schema.json. Images are masked by the engine first; they stay on
// the Mac with the local captioner, or go only to the user's own Anthropic account with the Claude captioner (s14).

/** One keyframe the observer kept: a line of `frames/DAY/index.jsonl.enc` (docs/store-contract.md "Keyframes"). */
export interface FrameRef {
  frameId: string;
  /** ms since epoch of the capture. */
  ts: number;
  /** Local capture day, YYYY-MM-DD (the folder the blob lives in). */
  day: string;
  app?: string;
  appName?: string;
  host?: string;
  /** 64-bit dHash, 16 hex chars. */
  phash?: string;
  width: number;
  height: number;
  bytes: number;
  /** Regions the observer blacked out before encoding (masked OCR lines + secure fields). */
  maskedRegions: number;
}

/** The fields a captioner fills (the model-written part of a Frame note). */
export interface CaptionFields {
  activity: string;
  verb?: string;
  object?: string;
  counterpart?: string;
  surface?: string;
  step?: string;
  inputs?: string[];
  outputs?: string[];
  identifiers?: string[];
  confidence: number;
}

/** schemas/frame-note.schema.json. */
export interface FrameNote extends CaptionFields {
  id: string;
  ts: number;
  kind: "frame";
  frameId: string;
  phash?: string;
  app?: string;
  host?: string;
  /** Captioner id, e.g. "ollama:qwen3-vl:8b-instruct" or "stub". */
  model: string;
}

/** Optional user context from onboarding (ADR 0007 point 5). Passed as hints, never required. */
export interface UserContext {
  role?: string;
  industry?: string;
}

export interface CaptionInput {
  /** JPEG bytes of the masked, downscaled keyframe. */
  image: Uint8Array;
  ref: FrameRef;
  context?: UserContext;
}

export interface CaptionerHealth {
  ok: boolean;
  /** Short reason when not ok ("ollama unreachable", "model qwen3-vl:8b-instruct is not pulled"). Never note text. */
  detail: string;
}

/** s14: tokens a paid captioner used (Claude). Counts only: never note text or image data. */
export interface CaptionUsage {
  frames: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  lastFrame: { inputTokens: number; outputTokens: number } | null;
  refusals: number;
  /** $ at the router's prices, when known. */
  costUsd?: number;
}

export interface Captioner {
  /** "stub", "ollama" or (s14) "claude". */
  readonly kind: "stub" | "ollama" | "claude";
  /** The model tag ("stub" for the stub). */
  readonly model: string;
  /** The `model` value written into notes. */
  readonly id: string;
  caption(input: CaptionInput, signal?: AbortSignal): Promise<CaptionFields>;
  health(): Promise<CaptionerHealth>;
  /** s14: token usage so far (paid captioners). */
  usage?(): CaptionUsage;
  /** s14: the captioner actually used for the next frame, when it switches (budget, no key). */
  active?(): "stub" | "ollama" | "claude";
}
