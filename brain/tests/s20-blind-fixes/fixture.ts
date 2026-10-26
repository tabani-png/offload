// s20 synthetic blind week: what the 7-day blind test fed the brain, reproduced. A screenwatch archive has screenshots
// only (no app, window or URL), so the importer (brain/tools/import-screenwatch.ts, used here read-only through its
// buildEvents) puts every span on ONE synthetic app and a small vision model's captions carry all the meaning: about
// three in four say "reviewing", products are named inconsistently (Instagram / instagram.com, Terminal / terminal,
// Chrome / Google Chrome), and writes come as gerunds (writing, typing, updating).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEvents, SYNTH_APP, type Candidate, type Run } from "../../tools/import-screenwatch.ts";
import type { FrameNote } from "../../src/understanding/frames.ts";

export interface Profile {
  key: string;
  /** Surface names the captioner uses for it, alternated. */
  surfaces: readonly string[];
  verbs: readonly string[];
  /** Objects alternated; a small model mostly says "content" or "page" whatever the product. */
  objects: readonly string[];
  activities: readonly string[];
  weight: number;
}

/** 12 kinds of screen across 11 products; weights make "reviewing" about 3 in 4 captions, like the real week. */
export const PROFILES: readonly Profile[] = [
  { key: "agent", surfaces: ["Terminal", "terminal"], verbs: ["reviewing"], objects: ["content", "code", "page"], activities: ["Reviewing content on the screen", "Reviewing code changes"], weight: 5 },
  { key: "mail", surfaces: ["Gmail", "mail.google.com"], verbs: ["reviewing"], objects: ["content", "email", "page"], activities: ["Reviewing content on the screen", "Reviewing an email"], weight: 3 },
  { key: "docs", surfaces: ["Google Docs", "docs.google.com"], verbs: ["reviewing"], objects: ["content", "document", "page"], activities: ["Reviewing content on the screen", "Reviewing a document"], weight: 2 },
  { key: "chatgpt", surfaces: ["ChatGPT", "chatgpt.com"], verbs: ["reviewing"], objects: ["content", "conversation", "page"], activities: ["Reviewing content on the screen", "Reviewing an answer"], weight: 2 },
  { key: "linkedin", surfaces: ["LinkedIn", "linkedin.com"], verbs: ["reviewing"], objects: ["content", "post", "page"], activities: ["Reviewing content on the screen", "Reviewing posts"], weight: 2 },
  { key: "youtube", surfaces: ["YouTube", "youtube.com"], verbs: ["reviewing", "watching"], objects: ["content", "video", "page"], activities: ["Reviewing content on the screen", "Watching a video"], weight: 2 },
  { key: "instagram", surfaces: ["Instagram", "instagram.com"], verbs: ["reviewing"], objects: ["content", "post", "page"], activities: ["Reviewing content on the screen", "Reviewing a reel"], weight: 2 },
  { key: "browser", surfaces: ["Chrome", "Google Chrome"], verbs: ["reviewing"], objects: ["content", "web page", "page"], activities: ["Reviewing content on the screen", "Reviewing search results"], weight: 1 },
  { key: "meeting", surfaces: ["Google Meet"], verbs: ["attending"], objects: ["meeting"], activities: ["Attending a video meeting"], weight: 1 },
  { key: "granola", surfaces: ["Granola"], verbs: ["writing"], objects: ["note"], activities: ["Writing a note in Granola", "Writing meeting notes"], weight: 1 },
  { key: "compose", surfaces: ["Gmail"], verbs: ["typing"], objects: ["message"], activities: ["Typing a message in Gmail", "Typing a reply"], weight: 1 },
  { key: "linear", surfaces: ["Linear", "linear.app"], verbs: ["updating"], objects: ["issue"], activities: ["Updating an issue in Linear", "Updating issue status"], weight: 1 },
];

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WEEK_START = "2026-10-12";
export const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
/** Read at noon the day after the week. */
export const NOW = new Date(2026, 9, 19, 12).getTime();

export interface Shot {
  ts: number;
  day: string;
  profile: string;
  surface: string;
}

export interface BlindWeek {
  /** Store events per day (the importer's format). */
  events: Map<string, ReturnType<typeof buildEvents>>;
  frames: FrameNote[];
  shots: Shot[];
}

const FRAME_MS = 60_000;

/**
 * A week of sessions: per day 14 sessions of 4-9 screens a minute apart; sessions 30 s apart inside an activity run,
 * with an idle break (> 2 min) every few sessions. One captioned frame per screen, as the importer keeps them.
 */
export function blindWeek(seed = 20): BlindWeek {
  const r = rng(seed);
  const total = PROFILES.reduce((n, p) => n + p.weight, 0);
  const pick = () => {
    let x = r() * total;
    for (const p of PROFILES) {
      x -= p.weight;
      if (x < 0) return p;
    }
    return PROFILES[PROFILES.length - 1]!;
  };
  const events = new Map<string, ReturnType<typeof buildEvents>>();
  const frames: FrameNote[] = [];
  const shots: Shot[] = [];
  let n = 0;
  for (const day of DAYS) {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    let t = new Date(y, m - 1, d, 9, 0, 0).getTime();
    const runs: Run[] = [];
    const kept: Candidate[] = [];
    let run: Run | null = null;
    let last: string | null = null;
    for (let s = 0; s < 14; s++) {
      let p = pick();
      // A session never repeats the one before it (that would just be a longer session).
      while (p.key === last) p = pick();
      last = p.key;
      if (run === null) run = { start: t, end: t, rows: 0 };
      const screens = 4 + Math.floor(r() * 6);
      for (let k = 0; k < screens; k++) {
        const ts = t;
        const hh = new Date(ts);
        const stem = `${String(hh.getHours()).padStart(2, "0")}-${String(hh.getMinutes()).padStart(2, "0")}-${String(hh.getSeconds()).padStart(2, "0")}`;
        kept.push({ ts, t: stem, hashes: { phash: "0".repeat(16), change: "0".repeat(68) } });
        run.end = ts;
        run.rows += 1;
        n += 1;
        const surface = p.surfaces[(k + s) % p.surfaces.length]!;
        frames.push({
          id: `fn_${day}_${String(n).padStart(5, "0")}`,
          ts: ts + 1000,
          kind: "frame",
          frameId: `kf_${day}_${n}`,
          model: "stub",
          activity: p.activities[(k + s) % p.activities.length]!,
          verb: p.verbs[(k + s) % p.verbs.length]!,
          object: p.objects[(k * 7 + s) % p.objects.length]!,
          surface,
          confidence: 0.8,
        });
        shots.push({ ts: ts + 1000, day, profile: p.key, surface });
        t += FRAME_MS;
      }
      // Every 3rd session ends the activity run with a coffee break; otherwise the next app follows 30 s later.
      if (s % 3 === 2) {
        runs.push(run);
        run = null;
        t += 20 * 60_000;
      } else t += 30_000 - FRAME_MS;
      t += FRAME_MS;
    }
    if (run !== null) runs.push(run);
    events.set(day, buildEvents(day, runs, kept));
  }
  return { events, frames, shots };
}

/** Writes the week as the importer does: a plain-mode home (days/<day>.jsonl) and the frame sidecar frames/<day>.jsonl. */
export function writeBlindWeek(home: string, w: BlindWeek): void {
  mkdirSync(join(home, "days"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "frames"), { recursive: true, mode: 0o700 });
  for (const [day, evs] of w.events) {
    writeFileSync(join(home, "days", `${day}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    const notes = w.frames.filter((f) => f.id.startsWith(`fn_${day}_`));
    writeFileSync(join(home, "frames", `${day}.jsonl`), notes.map((f) => JSON.stringify(f)).join("\n") + "\n", { mode: 0o600 });
  }
}

export { SYNTH_APP };
