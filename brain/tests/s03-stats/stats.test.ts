import { describe, expect, test } from "bun:test";
import { groupTasks, indexSpans } from "../../src/grouping/group.ts";
import { sessionize, totalActiveMs, DEFAULT_SESSION_OPTIONS } from "../../src/sessionize.ts";
import { computeSameness, computeTaskStats, jaccard, median, percentile } from "../../src/stats.ts";
import type { Span } from "../../src/types.ts";
import { EventBuilder } from "../helpers.ts";

// s03 tests use raw idle timestamps (idle_start = the moment input stopped); s05 tests cover the observer backdate.
const RAW = { ...DEFAULT_SESSION_OPTIONS, idleBackdateMs: 0 };

describe("pure maths", () => {
  test("median of odd and even lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test("p90 uses nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });

  test("jaccard of sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  test("identical instances have sameness 1", () => {
    const s = computeSameness([
      { titleTokens: ["New", "Message"], stepTokens: new Set(["hi", "seed"]), activeMs: 1000 },
      { titleTokens: ["New", "Message"], stepTokens: new Set(["hi", "seed"]), activeMs: 1000 },
    ]);
    expect(s.score).toBe(1);
    expect(s.stepMethod).toBe("ocr");
  });

  test("dissimilar instances have low sameness", () => {
    const s = computeSameness([
      { titleTokens: ["alpha", "beta"], stepTokens: new Set(["x"]), activeMs: 1000 },
      { titleTokens: ["gamma"], stepTokens: new Set(["y"]), activeMs: 9000 },
    ]);
    expect(s.score).toBeLessThan(0.2);
  });

  test("without OCR the step part falls back to duration regularity", () => {
    const s = computeSameness([
      { titleTokens: ["Zoom"], stepTokens: new Set(), activeMs: 1000 },
      { titleTokens: ["Zoom"], stepTokens: new Set(), activeMs: 1000 },
    ]);
    expect(s.stepMethod).toBe("duration");
    expect(s.score).toBe(1);
  });
});

function twoDays(): Span[] {
  const out: Span[] = [];
  for (const [dayIdx, day] of ["2026-10-12", "2026-10-13"].entries()) {
    const b = new EventBuilder();
    let t = dayIdx * 86_400;
    for (let i = 0; i < 5; i++) {
      b.focus(t, "New Message");
      b.at(t + 2, "ocr", { text: `To: p${i}@fund${i}.vc\nHi, we are raising`, textHash: `h${i}` });
      t += 60 * (i + 1);
      b.focus(t, "Inbox (1) - sam@acme.io - Gmail");
      t += 60;
    }
    b.at(t, "idle_start");
    out.push(...sessionize(b.events, day, RAW));
  }
  return out;
}

describe("task stats", () => {
  test("instances, per day, median, p90 and share are computed from instances", async () => {
    const spans = twoDays();
    const tasks = await groupTasks(spans);
    const compose = tasks.find((t) => t.profile.template === "New Message")!;
    const stats = computeTaskStats(compose, { totalActiveMs: totalActiveMs(spans), windowDays: ["2026-10-12", "2026-10-13"], spansById: indexSpans(spans) });
    expect(stats.instances.value).toBe(10);
    expect(stats.daysActive.value).toBe(2);
    expect(stats.instancesPerDay.value).toBe(5);
    expect(stats.medianMinutes.value).toBe(3);
    expect(stats.p90Minutes.value).toBe(5);
    expect(stats.activeMinutes.value).toBe(30);
    expect(stats.share.value).toBeCloseTo(30 / 40, 10);
  });

  test("every figure carries event ids that exist in the input", async () => {
    const spans = twoDays();
    const known = new Set(spans.flatMap((s) => s.eventIds));
    const tasks = await groupTasks(spans);
    for (const task of tasks) {
      const stats = computeTaskStats(task, { totalActiveMs: totalActiveMs(spans), windowDays: ["2026-10-12", "2026-10-13"], spansById: indexSpans(spans) });
      for (const fig of [stats.instances, stats.daysActive, stats.instancesPerDay, stats.medianMinutes, stats.p90Minutes, stats.activeMinutes, stats.share, stats.sameness]) {
        expect(fig.eventIds.length).toBeGreaterThan(0);
        for (const id of fig.eventIds) expect(known.has(id)).toBe(true);
      }
    }
  });

  test("the median figure points at the median instance only", async () => {
    const spans = twoDays();
    const tasks = await groupTasks(spans);
    const compose = tasks.find((t) => t.profile.template === "New Message")!;
    const stats = computeTaskStats(compose, { totalActiveMs: totalActiveMs(spans), windowDays: ["2026-10-12", "2026-10-13"], spansById: indexSpans(spans) });
    expect(stats.medianMinutes.eventIds.length).toBeLessThan(stats.instances.eventIds.length);
  });
});
