// s14 glue s11 -> s12: every Frame note the v2 understanding can use for the analysis window, from three places:
//   1. store events of kind "frame" (the store contract allows them; none are written today),
//   2. the fixture sidecar frames/<day>.jsonl[.enc] (s12 fixtures and demos),
//   3. the s11 notes store frame-notes/<day>.jsonl.enc, written by the caption worker (vision/notes.ts).
// Merged unique by note id, oldest first. Expired days are refused by each reader; invalid notes are counted only.
import type { ObserverEnv } from "../store/observer.ts";
import type { DayLabel, OffloadEvent } from "../types.ts";
import { readFrameNotesDetailed } from "../vision/notes.ts";
import { framesFromEvents, mergeFrames, readFrameSidecars, type FrameNote } from "./frames.ts";

export interface WindowNotes {
  frames: FrameNote[];
  bySource: { events: number; sidecar: number; store: number };
  invalid: number;
  errors: string[];
}

export function windowFrameNotes(home: string, days: ReadonlyArray<{ day: DayLabel; events: readonly OffloadEvent[] }>, now: number, env: ObserverEnv = process.env): WindowNotes {
  const labels = days.map((d) => d.day);
  const fromEvents = framesFromEvents(days.flatMap((d) => d.events));
  const side = readFrameSidecars(home, labels, { now });
  const stored: FrameNote[] = [];
  let bad = 0;
  for (const day of labels) {
    const r = readFrameNotesDetailed(home, day, now, env);
    // vision/types.ts FrameNote and understanding/frames.ts FrameNote are the same schema (schemas/frame-note.schema.json).
    stored.push(...(r.notes as FrameNote[]));
    bad += r.bad;
  }
  return {
    frames: mergeFrames(fromEvents.frames, side.frames, stored),
    bySource: { events: fromEvents.frames.length, sidecar: side.frames.length, store: stored.length },
    // Invalid notes among the events are counted by analyzeStore.
    invalid: side.invalid + bad,
    errors: side.errors,
  };
}
