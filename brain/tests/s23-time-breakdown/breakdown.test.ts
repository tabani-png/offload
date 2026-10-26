// s23 TOTAL, SUMS, REFS, KINDS: where the time went, by task, by app and by kind of work, tied to the events.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { kindOfSpan, WORK_KINDS } from "../../src/time/kinds.ts";
import type { Brain } from "../../src/api/server.ts";
import type { Span } from "../../src/types.ts";
import { allEventIds, brainOn, call, KIND_IDS, KIND_NAMES, minutesOf, neutralHome, spansOf } from "./setup.ts";

const fx = neutralHome();
let brain: Brain;
let week: any;
let spans: Span[];
let events: Set<string>;
const EPS = 1e-6;

beforeAll(async () => {
  brain = brainOn(fx.home);
  const r = await call(brain, "/time");
  expect(r.status).toBe(200);
  week = r.body;
  spans = spansOf(fx.home);
  events = allEventIds(fx.home);
});
afterAll(() => fx.cleanup());

const DIMENSIONS = ["byTask", "byApp", "byKind"] as const;

describe("s23 window total", () => {
  test("TOTAL: the week total is the active minutes of every span in the store, recomputed from the events", () => {
    expect(spans.length).toBeGreaterThan(50);
    const expected = minutesOf(spans);
    expect(expected).toBeGreaterThan(600); // a real week, not an empty store
    expect(week.total.unit).toBe("minutes");
    expect(Math.abs(week.total.value - expected)).toBeLessThan(EPS);
  });

  test("TOTAL: the total's event ids are exactly the events behind the spans, and every one is in the store", () => {
    const behind = new Set(spans.flatMap((s) => s.eventIds));
    const ids = new Set<string>(week.total.eventIds);
    expect(ids.size).toBe(behind.size);
    for (const id of behind) expect(ids.has(id)).toBe(true);
    for (const id of ids) expect(events.has(id)).toBe(true);
  });

  test("TOTAL: the window says which days it covers; the week is the store's 7 days", () => {
    expect(week.version).toBe(1);
    expect(week.window.kind).toBe("week");
    expect(week.window.days).toEqual([...new Set(spans.map((s) => s.day))].sort());
    expect(week.window.days.length).toBe(7);
  });

  test("TOTAL: a day window is that day's spans only, and the 7 day totals add up to the week", async () => {
    let sum = 0;
    for (const day of week.window.days as string[]) {
      const r = await call(brain, `/time?day=${day}`);
      expect(r.status).toBe(200);
      expect(r.body.window.kind).toBe("day");
      expect(r.body.window.days).toEqual([day]);
      const expected = minutesOf(spans.filter((s) => s.day === day));
      expect(Math.abs(r.body.total.value - expected)).toBeLessThan(EPS);
      for (const d of DIMENSIONS) {
        const rowSum = (r.body[d] as any[]).reduce((s, row) => s + row.minutes.value, 0);
        expect(Math.abs(rowSum - r.body.total.value)).toBeLessThan(EPS);
      }
      sum += r.body.total.value;
    }
    expect(Math.abs(sum - week.total.value)).toBeLessThan(EPS);
  });
});

describe("s23 breakdown sums", () => {
  test("SUMS: by task, by app and by kind each add up to the window total (unrounded minutes)", () => {
    for (const d of DIMENSIONS) {
      const rows = week[d] as any[];
      expect(rows.length).toBeGreaterThanOrEqual(d === "byKind" ? 6 : 5);
      const rowSum = rows.reduce((s, row) => s + row.minutes.value, 0);
      expect(Math.abs(rowSum - week.total.value)).toBeLessThan(EPS);
    }
  });

  test("SUMS: every span is in exactly one row of each dimension (no double count, nothing dropped)", () => {
    const all = new Set(spans.map((s) => s.id));
    for (const d of DIMENSIONS) {
      const seen = new Map<string, number>();
      for (const row of week[d] as any[]) for (const id of row.spanIds as string[]) seen.set(id, (seen.get(id) ?? 0) + 1);
      expect(seen.size).toBe(all.size);
      for (const id of all) expect(seen.get(id)).toBe(1);
    }
  });

  test("SUMS: each row's minutes are recomputed from its own spans; shares are minutes / total", () => {
    const byId = new Map(spans.map((s) => [s.id, s]));
    for (const d of DIMENSIONS) {
      for (const row of week[d] as any[]) {
        const own = (row.spanIds as string[]).map((id) => byId.get(id)!);
        expect(own.every((s) => s !== undefined)).toBe(true);
        expect(Math.abs(row.minutes.value - minutesOf(own))).toBeLessThan(EPS);
        expect(Math.abs(row.share - row.minutes.value / week.total.value)).toBeLessThan(1e-9);
      }
    }
  });

  test("SUMS: rows are sorted by minutes, most first (ties by id), and have a plain name", () => {
    for (const d of DIMENSIONS) {
      const rows = week[d] as any[];
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        expect(a.minutes.value > b.minutes.value || (a.minutes.value === b.minutes.value && a.id < b.id)).toBe(true);
      }
      for (const r of rows) expect(typeof r.name === "string" && r.name.trim().length > 0).toBe(true);
    }
  });

  test("SUMS: by app groups by the app's bundle id; spans with no task land in the one 'unsorted' task row", () => {
    const apps = new Set(spans.map((s) => s.app));
    expect(new Set((week.byApp as any[]).map((r) => r.id))).toEqual(apps);
    const ids = (week.byTask as any[]).map((r) => r.id as string);
    for (const id of ids) expect(id === "unsorted" || id.startsWith("t_")).toBe(true);
  });
});

describe("s23 every number carries its events", () => {
  test("REFS: a row's event ids are exactly the union of its spans' event ids", () => {
    const byId = new Map(spans.map((s) => [s.id, s]));
    for (const d of DIMENSIONS) {
      for (const row of week[d] as any[]) {
        const expected = new Set((row.spanIds as string[]).flatMap((id) => byId.get(id)!.eventIds));
        const got = new Set<string>(row.minutes.eventIds);
        expect(got.size).toBe(expected.size);
        for (const id of expected) expect(got.has(id)).toBe(true);
      }
    }
  });

  test("REFS: every number in the response with a value above zero has event ids, all in the store", () => {
    const found: number[] = [];
    const walk = (v: unknown, p: string) => {
      if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${p}[${i}]`));
      else if (v !== null && typeof v === "object") {
        const o = v as Record<string, any>;
        if (typeof o.value === "number" && typeof o.display === "string") {
          found.push(o.value);
          expect({ p, isArray: Array.isArray(o.eventIds) }).toEqual({ p, isArray: true });
          if (o.value > 0) expect({ p, n: o.eventIds.length > 0 }).toEqual({ p, n: true });
          for (const id of o.eventIds as string[]) expect(events.has(id)).toBe(true);
        }
        for (const [k, e] of Object.entries(o)) walk(e, `${p}.${k}`);
      }
    };
    walk(week, "$");
    expect(found.length).toBeGreaterThan(20); // the walk saw the rows and findings, not an empty body
  });

  test("REFS: a finding's numbers point at its own task's events only", () => {
    const task = new Map((week.byTask as any[]).map((r) => [r.id, new Set<string>(r.minutes.eventIds)]));
    expect(week.findings.length).toBeGreaterThan(0);
    for (const f of week.findings as any[]) {
      const own = task.get(f.taskId)!;
      expect(own).toBeDefined();
      for (const key of ["taskMinutes", "observedHoursPerWeek", "hoursFreed"]) {
        for (const id of f[key].eventIds as string[]) expect(own.has(id)).toBe(true);
      }
    }
  });
});

describe("s23 kind of work", () => {
  const span = (over: Partial<Span>): Span => ({
    id: "sp", day: "2026-10-12", key: "k", app: "com.google.Chrome", appName: "Google Chrome", title: "", host: "", url: "",
    start: 0, end: 1, activeMs: 1, eventIds: [], ocr: [], keys: 0, clicks: 0, ...over,
  });

  test("KINDS: the kinds are a fixed list, in this order", () => {
    expect([...WORK_KINDS]).toEqual([...KIND_IDS]);
  });

  test("KINDS: known answers per app and site (deterministic, no model)", () => {
    const cases: Array<[Partial<Span>, string]> = [
      [{ app: "com.apple.Terminal", appName: "Terminal", title: "claude — ~/code/api" }, "code"],
      [{ app: "com.microsoft.VSCode", appName: "Code", title: "router.ts — api" }, "code"],
      [{ app: "com.todesktop.230313mzl4w4u92", appName: "Cursor", title: "main.go" }, "code"],
      [{ host: "docs.google.com", url: "https://docs.google.com/document/d/abc/edit", title: "Q4 plan - Google Docs" }, "docs"],
      [{ app: "notion.id", appName: "Notion", title: "Team wiki" }, "docs"],
      [{ host: "docs.google.com", url: "https://docs.google.com/spreadsheets/d/abc/edit", title: "Budget - Google Sheets" }, "sheet"],
      [{ app: "com.microsoft.Excel", appName: "Microsoft Excel", title: "forecast.xlsx" }, "sheet"],
      [{ app: "us.zoom.xos", appName: "zoom.us", title: "Zoom Meeting" }, "meeting"],
      [{ host: "meet.google.com", url: "https://meet.google.com/abc-defg-hij", title: "Meet - Weekly sync" }, "meeting"],
      [{ host: "calendar.google.com", url: "https://calendar.google.com/calendar/r/week", title: "Google Calendar" }, "meeting"],
      [{ host: "mail.google.com", url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox (3)" }, "email"],
      [{ app: "com.apple.mail", appName: "Mail", title: "Inbox" }, "email"],
      [{ app: "com.tinyspeck.slackmacgap", appName: "Slack", title: "#eng - Slack" }, "chat"],
      [{ host: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Rust", title: "Rust - Wikipedia" }, "browse"],
      [{ host: "news.ycombinator.com", url: "https://news.ycombinator.com/", title: "Hacker News" }, "browse"],
      [{ app: "com.apple.finder", appName: "Finder", title: "Downloads" }, "other"],
    ];
    for (const [over, kind] of cases) expect({ title: over.title, kind: kindOfSpan(span(over)) }).toEqual({ title: over.title, kind });
  });

  test("KINDS: by kind rows use the fixed ids and their plain names, and each row holds only spans of its kind", () => {
    const byId = new Map(spans.map((s) => [s.id, s]));
    for (const row of week.byKind as any[]) {
      expect(KIND_IDS as readonly string[]).toContain(row.id);
      expect(row.name).toBe(KIND_NAMES[row.id as (typeof KIND_IDS)[number]]);
      for (const id of row.spanIds as string[]) expect(kindOfSpan(byId.get(id)!)).toBe(row.id);
    }
  });
});
