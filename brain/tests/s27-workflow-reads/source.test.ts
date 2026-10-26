// s27: finding the read source is code over the recordings (ADR 0005). It must not invent a source: a site seen before
// only a few instances, or one whose screen never showed the typed values, is not a source; values match as whole
// tokens; only plain-word labels are kept.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { findReadSource, parseCommitValues, readValues, tokenIn } from "../../src/plan/read-source.ts";
import type { FixtureDay } from "../../fixtures/gen.ts";
import { DASHBOARD_TITLE, dashboardDays, neutralDays, SEED, WED_EVENING } from "./setup.ts";

let home = "";
afterEach(() => {
  if (home !== "") rmSync(home, { recursive: true, force: true });
  home = "";
});

async function sourceOf(days: FixtureDay[]) {
  home = mkdtempSync(join(tmpdir(), "offload-s27-src-"));
  writeFixture(home, days, { encrypted: false, seed: SEED });
  const a = await analyzeHome(home, { now: () => WED_EVENING });
  const task = a.insights.find((i) => /Team metrics/.test(i.label.name))!;
  expect(task).toBeDefined();
  return findReadSource(a, task.taskId);
}

/** Keep the dashboard visit only before the first `keep` metrics visits. */
function onlyFirst(days: FixtureDay[], keep: number): FixtureDay[] {
  let seen = 0;
  return days.map((d) => {
    const events = [];
    let drop = false;
    for (const e of d.events) {
      if (e.kind === "focus") {
        drop = e.title === DASHBOARD_TITLE && ++seen > keep;
        if (drop) continue;
      }
      if (drop && e.kind === "ocr") continue;
      events.push(e);
    }
    return { day: d.day, events };
  });
}

/** Test view of the explicit outcome (round 6): fields of whichever kind it is. */
const rv = (...a: Parameters<typeof readValues>): any => readValues(...a);

describe("s27 read source", () => {
  test("SOURCE: the plain neutral week has no source: no site before the sheet shows the typed numbers", async () => {
    expect(await sourceOf(neutralDays().slice(0, 3))).toBeNull();
  });

  test("SOURCE: a dashboard seen before only one of nine sheet updates is not a source", async () => {
    expect(await sourceOf(onlyFirst(dashboardDays().slice(0, 3), 1))).toBeNull();
  });

  test("SOURCE: a dashboard before every update whose screen never shows the typed numbers is not a source", async () => {
    const days = dashboardDays()
      .slice(0, 3)
      .map((d) => ({ day: d.day, events: d.events.map((e) => (e.kind === "ocr" && (e.text ?? "").startsWith("Weekly metrics") ? { ...e, text: "Weekly metrics\nRetention cohort\nNo data for this range" } : e)) }));
    expect(await sourceOf(days)).toBeNull();
  });

  test("SOURCE: with the dashboard before every update it is the source; its fields are the sheet's columns with the dashboard's labels", async () => {
    const s = (await sourceOf(dashboardDays().slice(0, 3)))!;
    expect(s).not.toBeNull();
    expect(s.targetName).toBe("PostHog");
    expect(s.fields.map((f) => [f.label, f.sourceLabel])).toEqual([
      ["Week", "Week"],
      ["Signups", "Signups"],
      ["Active", "Active users"],
      ["Churn", "Churn"],
    ]);
    for (const f of s.fields) expect(f.label + f.sourceLabel).toMatch(/^[A-Za-z ]+$/);
  });

  test("SOURCE: values match as whole tokens, the commit screen is read as a table or as label lines, and fetched text becomes rows by code", () => {
    expect(tokenIn("Week 43\nChurn 2", "3")).toBe(false);
    expect(tokenIn("Week 43\nChurn 3", "3")).toBe(true);
    expect(tokenIn("Revenue 1,240.00", "240")).toBe(false);
    expect(parseCommitValues(["Week | Signups | Active | Churn\n42 | 350 | 2400 | 3"])).toEqual([["Week", "42"], ["Signups", "350"], ["Active", "2400"], ["Churn", "3"]]);
    expect(parseCommitValues(["Bill\nReference: INV-104\nAmount: 1,240.00"])).toEqual([["Reference", "INV-104"], ["Amount", "1,240.00"]]);
    const fields = [
      { label: "Week", sourceLabel: "Week", support: 9 },
      { label: "Active", sourceLabel: "Active users", support: 9 },
    ];
    expect(rv('{"week": 43, "active_users": "2410", "other": 1}', fields)).toEqual({ kind: "ok", rows: [[["Week", "43"], ["Active", "2410"]]], skipped: [] });
    expect(rv('[{"week": 43, "active_users": 2410}, {"week": 44, "active_users": 2455}]', fields).rows).toHaveLength(2);
    expect(rv('AXStaticText "Week 43"\nAXStaticText "Active users 2410"', fields)).toEqual({ kind: "ok", rows: [[["Week", "43"], ["Active", "2410"]]], skipped: [] });
    // Round 7: text goes through the same pipeline: a partial row is skipped (named); text with none of the fields is unreadable.
    expect(rv("Week 43", fields)).toEqual({ kind: "ok", rows: [], skipped: [{ missing: ["Active"] }] });
    expect(rv("Nothing here\nat all", fields)).toEqual({ kind: "unreadable", reason: "did not show Week, Active", missing: ["Week", "Active"] });
  });
});
