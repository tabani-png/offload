// Shared s12 fixtures: each persona week written once (plain), analysed with v1 and v2, cached per test process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePersona, writePersona, type PersonaId, type PersonaWeek } from "../../fixtures/gen-domains.ts";
import { REPORT_START, reportNow } from "../../fixtures/domains-report.ts";
import { analyzeHome, type Analysis } from "../../src/analyze.ts";
import type { DayLabel, Span } from "../../src/types.ts";
import type { SpanDescription } from "../../src/understanding/describe.ts";

export const SEED = 7;
export { REPORT_START, reportNow };

export interface PersonaRun {
  home: string;
  week: PersonaWeek;
  v1: Analysis;
  v2: Analysis;
}

const cache = new Map<PersonaId, Promise<PersonaRun>>();
const homes: string[] = [];

export function personaRun(p: PersonaId): Promise<PersonaRun> {
  let hit = cache.get(p);
  if (hit === undefined) {
    hit = (async () => {
      const home = mkdtempSync(join(tmpdir(), `offload-s12t-${p}-`));
      homes.push(home);
      const week = generatePersona(p, { seed: SEED, startDay: REPORT_START });
      writePersona(home, week, { encrypted: false, seed: SEED });
      const v1 = await analyzeHome(home, { now: reportNow });
      const v2 = await analyzeHome(home, { now: reportNow, understanding: "v2" });
      return { home, week, v1, v2 };
    })();
    cache.set(p, hit);
  }
  return hit;
}

// Several test files share the cache, so temp homes go when the test process exits.
process.on("exit", () => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

let n = 0;
/** A synthetic span description for induction unit tests. Times are seconds from 09:00 on `day`. */
export function desc(over: Partial<SpanDescription> & { at: number; dur?: number }): SpanDescription {
  n += 1;
  const day: DayLabel = over.day ?? "2026-10-12";
  const base = new Date(`${day}T09:00:00`).getTime();
  const start = base + over.at * 1000;
  const dur = (over.dur ?? 60) * 1000;
  const app = over.app ?? "com.google.Chrome";
  const host = over.host ?? "app.example.com";
  const urlPattern = over.urlPattern ?? "/x";
  const template = over.template ?? "Screen";
  const d: SpanDescription = {
    spanId: `sp_${String(n).padStart(6, "0")}`,
    day,
    start,
    end: start + dur,
    activeMs: dur,
    app,
    appName: over.appName ?? app,
    host,
    urlPattern,
    title: over.title ?? template,
    template,
    surfaceKey: `${app}|${host}|${urlPattern}|${template}`,
    category: over.category ?? "browse",
    activity: over.activity ?? `${over.verb ?? "view"} ${over.object ?? "thing"}`,
    verb: over.verb ?? "view",
    object: over.object ?? "thing",
    counterpart: over.counterpart ?? "",
    surface: over.surface ?? template,
    step: over.step ?? `${over.verb ?? "view"} ${over.object ?? "thing"}`,
    identifiers: over.identifiers ?? [],
    source: over.source ?? "frames",
    frameIds: over.frameIds ?? [],
    eventIds: over.eventIds ?? [`e_${n}`],
    keysPerMinute: over.keysPerMinute ?? 0,
    confidence: over.confidence ?? 0.9,
    frameVerbs: over.frameVerbs ?? [over.verb ?? "view"],
    text: "",
  };
  d.text = over.text ?? `${d.activity}. ${d.verb} ${d.object} on ${d.surface}. ${d.step}`;
  return d;
}

/** A Span for describe/attach tests. */
export function span(over: Partial<Span> & { id: string; start: number; end: number }): Span {
  return {
    day: "2026-10-12",
    key: "k",
    app: "com.google.Chrome",
    appName: "Google Chrome",
    title: "",
    host: "",
    url: "",
    activeMs: over.end - over.start,
    eventIds: [over.id.replace(/^sp_/, "")],
    ocr: [],
    keys: 0,
    clicks: 0,
    ...over,
  };
}
