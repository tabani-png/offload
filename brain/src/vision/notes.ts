// Frame notes in the brain's store (SPEC C7). One sealed file per capture day:
//   $OFFLOAD_HOME/frame-notes/YYYY-MM-DD.jsonl.enc  (vault.ts format: "OBV1 DAY" + one AES-GCM line of JSON lines)
// sealed with the brain key of the frame's CAPTURE day (keychain-wrapped via `offload-observer wrap-key`; raw file
// under OFFLOAD_KEYS=file), so the note goes when the frame's day goes. The brain purge deletes expired files
// (vault.ts artefacts), and the observer deletes the brain key of an expired day. s12 reads notes with
// `readFrameNotes(home, day)`. Text fields are masked with grouping/normalize.ts maskText before they are stored.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { maskText } from "../grouping/normalize.ts";
import { isExpired, openText, sealText } from "../store/vault.ts";
import type { ObserverEnv } from "../store/observer.ts";
import { clip, limits, validateFrameNote } from "./schema.ts";
import type { CaptionFields, FrameNote, FrameRef } from "./types.ts";

export const notesDir = (home: string) => join(home, "frame-notes");
export const notesPath = (home: string, day: string) => join(notesDir(home), `${day}.jsonl.enc`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic ULID: the frame's time + 80 bits of sha256(frameId, model). Same frame + model = same note id. */
export function noteId(ts: number, frameId: string, model: string): string {
  let t = Math.max(0, Math.floor(ts));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const h = createHash("sha256").update(`${frameId}\u0000${model}`).digest();
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[h[i]! % 32]!;
  return time + rand;
}

const maskOne = (s: string, max: number) => clip(maskText(s), max);

const ORG_WORD = /\b(ltd|limited|inc|llc|llp|plc|corp|corporation|co|company|group|bank|foods|logistics|energy|clinics?|studios?|labs?|systems|partners|capital|ventures|university|college|school|agency|health|services|solutions|supplies|technologies|holdings|team|department|council|fund|hospital|associates)\b\.?/i;
const PERSON_NAME = /^[A-Z][a-z'’-]+(?: [A-Z]\.?| [A-Z][a-z'’.-]+){0,2}$/;

/** The schema says counterpart is "masked if personal": a bare person-like name (1-3 capitalised words, no
 * organisation word) becomes the grouping code's <name> token. The prompt already asks for roles, not names; this
 * catches the model ignoring that (BENCH.md: 2 of 11 with qwen3-vl:2b). Organisations and roles pass through. */
export function maskCounterpart(s: string): string {
  const t = s.trim();
  return PERSON_NAME.test(t) && !ORG_WORD.test(t) ? "<name>" : t;
}

/** maskText over every text field, then back within the schema limits (a mask token can be longer than a digit). */
export function maskFields(f: CaptionFields): CaptionFields {
  const out: CaptionFields = { activity: maskOne(f.activity, limits("activity").maxLength ?? 200), confidence: f.confidence };
  for (const k of ["verb", "object", "counterpart", "surface", "step"] as const) {
    const v = f[k];
    if (v === undefined) continue;
    const m = maskOne(k === "counterpart" ? maskCounterpart(v) : v, limits(k).maxLength ?? 80);
    if (m !== "") out[k] = m;
  }
  for (const k of ["inputs", "outputs", "identifiers"] as const) {
    const v = f[k];
    if (v === undefined) continue;
    const max = limits(k).items?.maxLength ?? 80;
    const items = [...new Set(v.map((x) => maskOne(x, max)).filter((x) => x !== ""))];
    if (items.length > 0) out[k] = items;
  }
  if (out.activity === "") out.activity = "Working in an app";
  return out;
}

/** A schema-valid Frame note from a frame and MASKED caption fields. Throws when the result does not validate. */
export function buildNote(ref: FrameRef, fields: CaptionFields, model: string): FrameNote {
  const note: FrameNote = {
    id: noteId(ref.ts, ref.frameId, model),
    ts: ref.ts,
    kind: "frame",
    frameId: ref.frameId,
    ...(ref.phash === undefined ? {} : { phash: ref.phash }),
    ...(ref.app === undefined ? {} : { app: ref.app }),
    ...(ref.host === undefined ? {} : { host: ref.host }),
    model,
    ...fields,
  };
  const v = validateFrameNote(note);
  if (!v.ok) throw new Error(`frame note does not match the schema: ${v.error}`);
  return v.note;
}

export interface ReadNotes {
  notes: FrameNote[];
  /** Lines that were not valid notes (count only). */
  bad: number;
}

/** Valid notes of one capture day, by ts. Empty for an expired, missing or unreadable day. */
export function readFrameNotesDetailed(home: string, day: string, now = Date.now(), env: ObserverEnv = process.env): ReadNotes {
  if (!DAY_RE.test(day) || isExpired(day, now)) return { notes: [], bad: 0 };
  const text = openText(home, notesPath(home, day), now, env);
  if (text === null) return { notes: [], bad: 0 };
  const notes: FrameNote[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = validateFrameNote(JSON.parse(line));
      if (v.ok) notes.push(v.note);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  notes.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return { notes, bad };
}

/** s12 entry point: the valid Frame notes of a capture day, oldest first. */
export function readFrameNotes(home: string, day: string, now = Date.now(), env: ObserverEnv = process.env): FrameNote[] {
  return readFrameNotesDetailed(home, day, now, env).notes;
}

/** Capture days that have a notes file (not checked for expiry). */
export function listNoteDays(home: string): string[] {
  const dir = notesDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.jsonl\.enc$/.exec(n)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort();
}

/** Adds notes (replacing any with the same frameId) and reseals each touched day. Returns the days written. */
export function appendNotes(home: string, notes: readonly FrameNote[], now = Date.now(), env: ObserverEnv = process.env, dayOf: (n: FrameNote) => string): string[] {
  const byDay = new Map<string, FrameNote[]>();
  for (const n of notes) {
    const d = dayOf(n);
    if (!DAY_RE.test(d) || isExpired(d, now)) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), n]);
  }
  mkdirSync(notesDir(home), { recursive: true, mode: 0o700 });
  for (const [day, add] of byDay) {
    const existing = readFrameNotes(home, day, now, env);
    const merged = new Map(existing.map((n) => [n.frameId, n]));
    for (const n of add) merged.set(n.frameId, n);
    const lines = [...merged.values()].sort((a, b) => a.ts - b.ts).map((n) => JSON.stringify(n));
    sealText(home, notesPath(home, day), lines.join("\n") + "\n", day, env);
  }
  return [...byDay.keys()].sort();
}
