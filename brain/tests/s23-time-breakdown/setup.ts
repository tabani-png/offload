// s23 time breakdown: shared setup for the frozen contract (slices/s23-time-breakdown/SPEC.md).
// The neutral week (brain/fixtures/gen-neutral.ts) is the screen's demo data; the outreach week (gen.ts) is kept
// only to pin the rounding rule on the quantity that showed 24.7 h on one screen and 24.8 h on another.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateNeutralWeek } from "../../fixtures/gen-neutral.ts";
import { generateFixture, writeFixture, type FixtureDay } from "../../fixtures/gen.ts";
import { createBrain, type Brain } from "../../src/api/server.ts";
import { StubModel } from "../../src/models/model.ts";
import { DEFAULT_SESSION_OPTIONS, sessionizeDays } from "../../src/sessionize.ts";
import { readStore } from "../../src/store/reader.ts";
import type { Span } from "../../src/types.ts";
import { tempHome } from "../helpers.ts";

export const TOKEN = "t".repeat(48);
/** The fixture weeks start Mon 12 Oct 2026; the clock is Sun 18 Oct 20:00 UTC, so all 7 days are in the window. */
export const START = "2026-10-12";
export const NOW = Date.UTC(2026, 9, 18, 20, 0);
export const SEED = 42;

/** s22 (PR #17, solution designer) is merged when its service exists. The contract holds either way. */
export const S22_PRESENT = existsSync(join(import.meta.dir, "../../src/solutions/service.ts"));
export const FIX_KINDS = ["workflow", "tool", "setup", "remove_step", "leave_alone"] as const;

export const KIND_IDS = ["code", "docs", "meeting", "sheet", "email", "chat", "browse", "other"] as const;
export const KIND_NAMES: Record<(typeof KIND_IDS)[number], string> = {
  code: "Coding", docs: "Docs", meeting: "Meetings", sheet: "Spreadsheets", email: "Email", chat: "Chat", browse: "Browsing", other: "Other",
};

/** Words that mark the old outreach-heavy demo. None may appear in the neutral week or its findings. */
export const OUTREACH_WORDS = /outreach|investor|cold e-?mail|prospect|fundrais|seed round|instantly|apollo|smartlead|lemlist/i;

export function neutralDays(seed = SEED): FixtureDay[] {
  return generateNeutralWeek({ seed, startDay: START });
}

export function neutralHome(seed = SEED): { home: string; cleanup: () => void } {
  const h = tempHome();
  writeFixture(h.home, neutralDays(seed), { encrypted: false, seed });
  return h;
}

export function outreachHome(): { home: string; cleanup: () => void } {
  const h = tempHome();
  writeFixture(h.home, generateFixture({ seed: SEED, startDay: START }), { encrypted: false, seed: SEED });
  return h;
}

export function brainOn(home: string, model: StubModel = new StubModel()): Brain {
  return createBrain({ home, token: TOKEN, now: () => NOW, workflows: { model } });
}

export async function call(brain: Brain, path: string, method = "GET"): Promise<{ status: number; body: any }> {
  const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
  const res = await brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method, headers }));
  const text = await res.text();
  let body: any = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Independent of the code under test: the store read and sessionized the way analyze.ts does it. */
export function spansOf(home: string): Span[] {
  const store = readStore(home, { windowDays: 7, now: NOW });
  return sessionizeDays(store.days, DEFAULT_SESSION_OPTIONS);
}

export function allEventIds(home: string): Set<string> {
  const store = readStore(home, { windowDays: 7, now: NOW });
  return new Set(store.days.flatMap((d) => d.events.map((e) => e.id)));
}

export const minutesOf = (spans: readonly Span[]) => spans.reduce((s, x) => s + x.activeMs, 0) / 60_000;

/** The one rounding rule (SPEC "Rounding"): tenths of an hour, half up, with a 1e-9 guard for binary fractions. */
export const refTenths = (hours: number) => Math.floor(hours * 10 + 0.5 + 1e-9);
export const refHours = (hours: number) => `${(refTenths(hours) / 10).toFixed(1)} h`;

/** Honest savings (SPEC amendment, operator 2026-10-26): a fix never frees all of a task. The person keeps the s04
 * low case's share (review 1.5x slower, 10% of items by hand): freed = min(estimate, observed x lowPct), and the shown
 * freed figure is always at least one tenth below the shown observed figure. */
export function refFreed(observed: number, estimate: number, lowPct: number): number {
  let freed = Math.min(Math.max(0, observed * lowPct), Math.max(0, estimate));
  if (refTenths(freed) >= refTenths(observed)) freed = Math.max(0, refTenths(observed) - 1) / 10;
  return freed;
}

/** Every `{ value, display, eventIds }` object anywhere in a JSON value, with its path. */
export function metrics(x: unknown, path = "$"): Array<{ path: string; m: { value: number; unit?: string; display?: string; eventIds?: unknown } }> {
  const out: Array<{ path: string; m: any }> = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${p}[${i}]`));
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.value === "number" && ("display" in o || "unit" in o)) out.push({ path: p, m: o });
      for (const [k, e] of Object.entries(o)) walk(e, `${p}.${k}`);
    }
  };
  walk(x, path);
  return out;
}

/** Every string anywhere in a JSON value. */
export function strings(x: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(x);
  return out;
}
