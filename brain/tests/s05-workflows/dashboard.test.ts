// s05 AC-7: dashboard data. Measured = observed time on the task after activation vs before, from the store.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dashboard, localDay, measuredSaving } from "../../src/workflows/service.ts";
import { updateWorkflow } from "../../src/workflows/store.ts";
import { world, type World } from "./setup.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.cleanup());

// Local noon on a fixture day.
const noon = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12).getTime();
};

describe("s05 dashboard", () => {
  test("measured saving is null without activation or without days on both sides", () => {
    const days = w.analysis.windowDays;
    expect(measuredSaving(w.analysis, w.outreach.taskId, null)).toBeNull();
    expect(measuredSaving(w.analysis, w.outreach.taskId, noon(days[0]!))).toBeNull();
    expect(measuredSaving(w.analysis, w.outreach.taskId, noon(days[days.length - 1]!))).toBeNull();
  });

  test("measured saving compares full days before and after activation, activation day excluded", () => {
    const days = w.analysis.windowDays; // Mon..Sun, outreach on weekdays only
    const m = measuredSaving(w.analysis, w.outreach.taskId, noon(days[2]!))!;
    expect(localDay(noon(days[2]!))).toBe(days[2]!);
    expect(m.daysBefore).toBe(2);
    expect(m.daysAfter).toBe(4);
    expect(m.hoursPerWeekBefore).toBeGreaterThan(m.hoursPerWeekAfter); // the weekend has no outreach
    expect(m.hoursSavedPerWeek).toBeCloseTo(m.hoursPerWeekBefore - m.hoursPerWeekAfter, 1);
    expect(m.arithmetic).toMatch(/^before: [\d.]+ h over 2 days = [\d.]+ h\/wk; after: [\d.]+ h over 4 days = [\d.]+ h\/wk → saves -?[\d.]+ h\/wk$/);
  });

  test("automations carry state, legacy status, estimate and measured; suggestions skip automated insights", () => {
    let d = dashboard(w.analysis, w.home, {});
    const a = d.automations.find((x) => x.id === w.outreach.id)!;
    expect(a).toMatchObject({ state: "ready_for_review", status: "draft", measuredHoursSavedPerWeek: null, measured: null, workflowId: w.outreach.id });
    expect(a.estimatedHoursSavedPerWeek).toBe(w.analysis.insights[0]!.saving.weeklyHoursSaved);
    expect(d.totals).toEqual({ estimatedHoursSavedPerWeek: 0, measuredHoursSavedPerWeek: null });
    expect(d.suggestions.map((s) => s.insightId)).not.toContain(w.outreach.insightId);

    updateWorkflow(w.home, w.outreach.id, (x) => {
      x.status = "active";
      x.activatedAt = noon(w.analysis.windowDays[2]!);
    }, 0);
    d = dashboard(w.analysis, w.home, { GMAIL_OAUTH_PATH: "/x" });
    const b = d.automations.find((x) => x.id === w.outreach.id)!;
    expect(b.state).toBe("needs_you"); // Gmail is not connected (no connectors.json)
    expect(b.status).toBe("approved");
    expect(b.needsYou).toEqual(["connect Gmail"]);
    expect(b.measured?.daysAfter).toBe(4);
    expect(d.totals.estimatedHoursSavedPerWeek).toBeCloseTo(b.estimatedHoursSavedPerWeek, 1);
    expect(d.totals.measuredHoursSavedPerWeek).toBe(b.measuredHoursSavedPerWeek);
  });
});
