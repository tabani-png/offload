// s05b (REVIEW-1 L3, L4): the saving arithmetic adds up by hand, dry-run savings never go negative, and work after
// local midnight is counted without waiting for the next focus change.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { estimateSaving } from "../../src/insights/saving.ts";
import { sessionizeDays } from "../../src/sessionize.ts";
import type { OffloadEvent } from "../../src/types.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { updateWorkflow } from "../../src/workflows/store.ts";
import { NOW, world, type World } from "../s05-workflows/setup.ts";

const r1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;

describe("s05b arithmetic", () => {
  test("L3: 'now → review → saves' adds up by hand for every input on a grid", () => {
    let checked = 0;
    for (const instances of [3, 7, 11, 23, 54, 101, 497])
      for (const daysActive of [1, 2, 3, 4, 5, 7])
        for (const median of [0.4, 1.17, 2.04, 3.05, 7.33])
          for (const review of [5, 20, 45, 90]) {
            const s = estimateSaving({ instances, daysActive, windowDays: 7, medianMinutes: median, eventIds: [] }, { reviewSeconds: review });
            const m = /= ([\d.]+) h\/wk → review .* = ([\d.]+) h\/wk → saves ([\d.]+) h\/wk/.exec(s.arithmetic);
            expect(m).not.toBeNull();
            const [now, after, saves] = [Number(m![1]), Number(m![2]), Number(m![3])];
            expect(r1(now - after)).toBe(saves);
            checked++;
          }
    expect(checked).toBeGreaterThan(800);
  });

  describe("dry run", () => {
    let w: World;
    beforeEach(async () => (w = await world()));
    afterEach(() => w.cleanup());
    test("L3: dry-run minutes saved never go negative, per instance or in total", async () => {
      updateWorkflow(w.home, w.outreach.id, (x) => void (x.reviewSecondsPerItem = 3600), NOW);
      const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 3, now: () => NOW });
      expect(r.instances.every((i) => i.estimate.savedMinutes >= 0)).toBe(true);
      expect(r.totals.savedMinutes).toBe(0);
      expect(r.totals.arithmetic).toContain("saves 0.0 min");
    });
  });
});

describe("s05b midnight", () => {
  const midnight = new Date(2026, 9, 13, 0, 0, 0).getTime();
  const ev = (id: string, ts: number, kind: OffloadEvent["kind"], extra: Partial<OffloadEvent> = {}): OffloadEvent => ({ id, ts, kind, ...extra });
  const compose = { app: "com.google.Chrome", appName: "Google Chrome", title: "New Message", host: "mail.google.com", url: "https://mail.google.com/mail/u/0/" };

  test("L4: input and OCR after midnight continue the last focus of the day before", () => {
    const day1 = [ev("a1", midnight - 10 * 60_000, "focus", compose), ev("a2", midnight - 5 * 60_000, "input", { keys: 120, clicks: 2 })];
    const day2 = [
      ev("b1", midnight + 60_000, "input", { keys: 90, clicks: 1 }),
      ev("b2", midnight + 150_000, "ocr", { text: "To: x@y.com\nSubject: Hi\n\nHello" }),
      ev("b3", midnight + 240_000, "input", { keys: 80, clicks: 0 }),
      ev("b4", midnight + 600_000, "focus", { ...compose, title: "Inbox" }),
      ev("b5", midnight + 660_000, "input", { keys: 3, clicks: 4 }),
    ];
    const spans = sessionizeDays([
      { day: "2026-10-12", events: day1 },
      { day: "2026-10-13", events: day2 },
    ]);
    const carried = spans.find((s) => s.day === "2026-10-13" && s.title === "New Message");
    expect(carried).toBeDefined();
    expect(carried!.start).toBeLessThanOrEqual(midnight + 60_000);
    expect(carried!.end).toBe(midnight + 600_000);
    expect(carried!.keys).toBe(170);
    expect(carried!.ocr).toHaveLength(1);
    expect(new Set(spans.map((s) => s.id)).size).toBe(spans.length);
  });

  test("L4: nothing is carried across a pause, or into a day that does not follow", () => {
    const paused = [ev("a1", midnight - 10 * 60_000, "focus", compose), ev("a2", midnight - 60_000, "pause")];
    const day2 = [ev("b1", midnight + 60_000, "input", { keys: 90 }), ev("b2", midnight + 600_000, "focus", { ...compose, title: "Inbox" })];
    expect(sessionizeDays([{ day: "2026-10-12", events: paused }, { day: "2026-10-13", events: day2 }]).filter((s) => s.title === "New Message" && s.day === "2026-10-13")).toEqual([]);
    const gap = [ev("a1", midnight - 2 * 86_400_000, "focus", compose)];
    expect(sessionizeDays([{ day: "2026-10-11", events: gap }, { day: "2026-10-13", events: day2 }]).filter((s) => s.title === "New Message" && s.day === "2026-10-13")).toEqual([]);
  });
});
