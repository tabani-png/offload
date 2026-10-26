// s23 NEUTRAL: the screen's demo week is neutral mixed work, not the outreach-heavy s09 week.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kindOfSpan } from "../../src/time/kinds.ts";
import type { Span } from "../../src/types.ts";
import { minutesOf, neutralDays, neutralHome, OUTREACH_WORDS, spansOf } from "./setup.ts";

const fx = neutralHome();
let spans: Span[];
let byKind: Map<string, number>;
let total: number;

beforeAll(() => {
  spans = spansOf(fx.home);
  total = minutesOf(spans);
  byKind = new Map();
  for (const s of spans) byKind.set(kindOfSpan(s), (byKind.get(kindOfSpan(s)) ?? 0) + s.activeMs / 60_000);
});
afterAll(() => fx.cleanup());

const share = (k: string) => (byKind.get(k) ?? 0) / total;

describe("s23 neutral demo week", () => {
  test("NEUTRAL: 7 days from Mon 12 Oct 2026, deterministic for a seed, different for another seed", () => {
    const a = neutralDays(42), b = neutralDays(42), c = neutralDays(7);
    expect(a.map((d) => d.day)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(a.reduce((n, d) => n + d.events.length, 0)).toBeGreaterThan(1000);
  });

  test("NEUTRAL: a full working week: weekdays 5 to 9 active hours, the weekend lighter", () => {
    expect(total).toBeGreaterThan(25 * 60);
    for (const d of [...new Set(spans.map((s) => s.day))]) {
      const h = minutesOf(spans.filter((s) => s.day === d)) / 60;
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (wd === 0 || wd === 6) expect(h).toBeLessThan(3);
      else {
        expect(h).toBeGreaterThanOrEqual(5);
        expect(h).toBeLessThanOrEqual(9);
      }
    }
  });

  test("NEUTRAL: mixed work: coding, docs, meetings, spreadsheets and browsing each hold real time; email is a small part", () => {
    expect(share("code")).toBeGreaterThanOrEqual(0.15);
    expect(share("docs")).toBeGreaterThanOrEqual(0.08);
    expect(share("meeting")).toBeGreaterThanOrEqual(0.08);
    expect(share("sheet")).toBeGreaterThanOrEqual(0.05);
    expect(share("browse")).toBeGreaterThanOrEqual(0.05);
    expect(share("email")).toBeGreaterThan(0);
    expect(share("email")).toBeLessThanOrEqual(0.15);
    for (const [k, m] of byKind) expect({ k, over40: m / total > 0.4 }).toEqual({ k, over40: false });
  });

  test("NEUTRAL: coding-agent sessions are in it (Claude Code in a terminal)", () => {
    const agent = spans.filter((s) => kindOfSpan(s) === "code" && /claude/i.test(s.title));
    expect(minutesOf(agent) / total).toBeGreaterThanOrEqual(0.05);
  });

  test("NEUTRAL: no outreach: no title, host, URL or OCR text of the old demo's kind", () => {
    for (const d of neutralDays()) {
      for (const e of d.events) {
        const text = [e.title, e.host, e.url, (e as any).text, (e as any).appName].filter((x) => typeof x === "string").join(" ");
        expect({ id: e.id, hit: OUTREACH_WORDS.test(text) }).toEqual({ id: e.id, hit: false });
      }
    }
  });

  test("NEUTRAL: the generator has a CLI like gen.ts and the demo script can seed it", () => {
    const src = readFileSync(join(import.meta.dir, "../../fixtures/gen-neutral.ts"), "utf8");
    expect(src).toContain("--out");
    expect(src).toContain("--encrypted");
    const demo = readFileSync(join(import.meta.dir, "../../../scripts/demo.sh"), "utf8");
    expect(demo).toContain("gen-neutral.ts");
    expect(demo).toContain("--neutral");
  });
});
