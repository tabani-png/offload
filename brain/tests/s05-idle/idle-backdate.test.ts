// s05 AC-0: the observer stamps idle_start when it DETECTS idle, which is IDLE_THRESHOLD_MS after the last input
// (engine Observer.checkIdle, docs/store-contract.md). Sessionize backdates it so that time is not counted as active.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SESSION_OPTIONS, IDLE_THRESHOLD_MS, sessionize, totalActiveMs } from "../../src/sessionize.ts";
import { EventBuilder } from "../helpers.ts";

const DAY = "2026-10-12";

describe("s05 idle backdate", () => {
  test("the idle threshold is the observer's 120 s and is the default backdate", () => {
    expect(IDLE_THRESHOLD_MS).toBe(120_000);
    expect(DEFAULT_SESSION_OPTIONS.idleBackdateMs).toBe(IDLE_THRESHOLD_MS);
  });

  test("idle detected at 300 s means the user stopped at 180 s", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    b.at(300, "idle_start");
    b.at(900, "idle_end");
    b.at(960, "idle_start"); // detected at 960 -> stopped at 840, before idle_end: nothing more counts
    const spans = sessionize(b.events, DAY);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.activeMs).toBe(180_000);
  });

  test("resumed work after idle counts only up to the backdated stop", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    b.at(300, "idle_start");
    b.at(600, "idle_end");
    b.at(1000, "idle_start");
    expect(totalActiveMs(sessionize(b.events, DAY))).toBe(180_000 + 280_000);
  });

  test("a focus change inside the idle window is trimmed back too (no input happened after the cutoff)", () => {
    const b = new EventBuilder();
    b.focus(0, "Inbox");
    b.focus(200, "New Message"); // app switched without input at 200, idle detected at 260 -> last input at 140
    b.at(260, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(totalActiveMs(spans)).toBe(140_000);
    expect(spans.every((s) => s.end <= EventBuilder.BASE + 200_000)).toBe(true);
  });

  test("backdate 0 keeps raw timestamps (old behaviour, for synthetic tests)", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    b.at(300, "idle_start");
    expect(totalActiveMs(sessionize(b.events, DAY, { ...DEFAULT_SESSION_OPTIONS, idleBackdateMs: 0 }))).toBe(300_000);
  });

  test("pause is not backdated", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    b.at(300, "pause");
    expect(totalActiveMs(sessionize(b.events, DAY))).toBe(300_000);
  });
});
