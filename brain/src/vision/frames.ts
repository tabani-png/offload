// Reads the observer's keyframes (docs/store-contract.md "Keyframes", SPEC C6).
// Keychain mode (default): the observer is the only process that can unwrap day keys, so frames come through
// `offload-observer list-frames DAY` and `export-frame ID` (observer child env only, REVIEW-2 N6).
// OFFLOAD_KEYS=file (tests, fixtures): raw 32-byte day keys, decrypted in process with the same format.
// A day older than 7 local days is never read (the observer exits 3 and purges it).
import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptLine, KEY_BYTES, NONCE_BYTES, TAG_BYTES } from "../store/crypto.ts";
import { missingBinMessage, observerBin, observerChildEnv, type ObserverEnv } from "../store/observer.ts";
import { isExpired } from "../store/vault.ts";
import type { FrameRef } from "./types.ts";

export const FRAME_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface FrameListing {
  frames: FrameRef[];
  /** The day is past the 7-day window (nothing is read). */
  expired: boolean;
  /** Why the day could not be read (no text from the store). */
  error?: string;
}

export interface FrameSource {
  /** Local days that have a frames folder, oldest first. */
  days(): string[];
  list(day: string, now: number): FrameListing;
  /** The JPEG bytes, or null when the frame is gone or expired. Throws on other failures. */
  read(ref: FrameRef, now: number): Uint8Array | null;
}

export class FrameReadError extends Error {}

/** One index line -> FrameRef, or null when it is not a valid line. */
export function parseFrameMeta(line: string, day: string): FrameRef | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const int = (k: string) => (typeof o[k] === "number" && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : null);
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const frameId = str("frameId");
  const ts = int("ts");
  const width = int("width");
  const height = int("height");
  const bytes = int("bytes");
  const masked = int("maskedRegions");
  if (frameId === undefined || !FRAME_ID_RE.test(frameId) || ts === null || width === null || height === null || bytes === null || masked === null) return null;
  const ref: FrameRef = { frameId, ts, day, width, height, bytes, maskedRegions: masked };
  const app = str("app");
  const appName = str("appName");
  const host = str("host");
  const phash = str("phash");
  if (app !== undefined) ref.app = app;
  if (appName !== undefined) ref.appName = appName;
  if (host !== undefined) ref.host = host;
  if (phash !== undefined && /^[0-9a-f]{16}$/.test(phash)) ref.phash = phash;
  return ref;
}

/** AES-256-GCM combined (nonce | ct | tag) with associated data "offload/frame/v1/<id>" (engine FrameStore). */
export function openFrameBlob(key: Uint8Array, frameId: string, sealed: Uint8Array): Buffer {
  if (key.length !== KEY_BYTES) throw new FrameReadError("bad key length");
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new FrameReadError("frame blob too short");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(Buffer.from(`offload/frame/v1/${frameId}`, "utf8"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new FrameReadError(`frame ${frameId} does not open with its day key`);
  }
}

export class ObserverFrameSource implements FrameSource {
  constructor(
    readonly home: string,
    readonly env: ObserverEnv = process.env,
    /** inProcess: decrypt raw day keys here (default: only under OFFLOAD_KEYS=file); false forces the observer CLI. */
    readonly opts: { inProcess?: boolean } = {},
  ) {}

  private get fileMode(): boolean {
    return this.opts.inProcess ?? this.env.OFFLOAD_KEYS === "file";
  }

  days(): string[] {
    const dir = join(this.home, "frames");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => DAY_RE.test(d)).sort();
  }

  private rawKey(day: string): Buffer {
    const p = join(this.home, "keys", `${day}.key`);
    if (!existsSync(p)) throw new FrameReadError(`no day key for ${day}`);
    const k = readFileSync(p);
    if (k.length !== KEY_BYTES) throw new FrameReadError(`day key ${day} is wrapped; OFFLOAD_KEYS=file reads raw keys only`);
    return k;
  }

  list(day: string, now: number): FrameListing {
    if (!DAY_RE.test(day)) return { frames: [], expired: false, error: "bad day" };
    if (isExpired(day, now)) return { frames: [], expired: true };
    let lines: string[];
    if (this.fileMode) {
      const index = join(this.home, "frames", day, "index.jsonl.enc");
      if (!existsSync(index)) return { frames: [], expired: false };
      try {
        const key = this.rawKey(day);
        lines = readFileSync(index, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => decryptLine(key, l));
      } catch (err) {
        return { frames: [], expired: false, error: err instanceof Error ? err.message : "cannot read index" };
      }
    } else {
      const bin = observerBin(this.env);
      if (!existsSync(bin)) return { frames: [], expired: false, error: missingBinMessage(bin, "list-frames") };
      const r = spawnSync(bin, ["list-frames", day, "--home", this.home], { env: observerChildEnv(this.home, this.env), encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
      if (r.status === 3) return { frames: [], expired: true };
      if (r.error !== undefined || r.status !== 0) return { frames: [], expired: false, error: `list-frames ${day} exited ${r.status ?? r.signal ?? "?"}` };
      lines = (r.stdout ?? "").split("\n").filter((l) => l.trim() !== "");
    }
    const frames: FrameRef[] = [];
    for (const l of lines) {
      const ref = parseFrameMeta(l, day);
      if (ref !== null) frames.push(ref);
    }
    frames.sort((a, b) => a.ts - b.ts);
    return { frames, expired: false };
  }

  read(ref: FrameRef, now: number): Uint8Array | null {
    if (!FRAME_ID_RE.test(ref.frameId)) throw new FrameReadError("bad frame id");
    if (isExpired(ref.day, now)) return null;
    if (this.fileMode) {
      const p = join(this.home, "frames", ref.day, `${ref.frameId}.enc`);
      if (!existsSync(p)) return null;
      return openFrameBlob(this.rawKey(ref.day), ref.frameId, readFileSync(p));
    }
    const bin = observerBin(this.env);
    if (!existsSync(bin)) throw new FrameReadError(missingBinMessage(bin, "export-frame"));
    const r = spawnSync(bin, ["export-frame", ref.frameId, "--home", this.home], { env: observerChildEnv(this.home, this.env), timeout: 30_000, maxBuffer: MAX_FRAME_BYTES });
    if (r.status === 3) return null;
    if (r.status === 1 && !existsSync(join(this.home, "frames", ref.day, `${ref.frameId}.enc`))) return null;
    if (r.error !== undefined || r.status !== 0) throw new FrameReadError(`export-frame exited ${r.status ?? r.signal ?? "?"}`);
    return r.stdout as Buffer;
  }
}
