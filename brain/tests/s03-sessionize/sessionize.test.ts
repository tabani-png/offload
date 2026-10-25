import { describe, expect, test } from "bun:test";
import { sessionize, totalActiveMs } from "../../src/sessionize.ts";
import { EventBuilder } from "../helpers.ts";

const DAY = "2026-10-12";

describe("sessionize", () => {
  test("each focus change starts a new span on app + title + host", () => {
    const b = new EventBuilder();
    b.focus(0, "Inbox");
    b.focus(60, "New Message");
    b.focus(240, "Inbox");
    b.at(300, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(spans.map((s) => [s.title, s.activeMs / 1000])).toEqual([
      ["Inbox", 60],
      ["New Message", 180],
      ["Inbox", 60],
    ]);
    expect(spans.every((s) => s.day === DAY)).toBe(true);
  });

  test("idle time is removed from active minutes", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    b.at(100, "idle_start");
    b.at(400, "idle_end");
    b.at(460, "idle_start");
    const [span] = sessionize(b.events, DAY);
    expect(span?.activeMs).toBe(160_000);
    expect(span?.end).toBe(EventBuilder.BASE + 460_000);
  });

  test("a span resumed after idle on the same focus is one span with idle excluded", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    b.at(60, "idle_start");
    const back = b.at(200, "idle_end");
    b.focus(260, "Inbox");
    b.at(300, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(spans.length).toBe(2);
    expect(spans[0]?.activeMs).toBe(120_000);
    expect(spans[0]?.eventIds).toContain(back);
  });

  test("a blip under 10 s between two spans of the same key merges them into one", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    const blip = b.focus(100, "#general - Slack", "com.tinyspeck.slackmacgap", "");
    b.focus(105, "New Message");
    b.at(200, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(spans.length).toBe(1);
    expect(spans[0]?.activeMs).toBe(200_000);
    expect(spans[0]?.eventIds).toContain(blip);
  });

  test("a blip under 10 s before a different key is absorbed by the previous span", () => {
    const b = new EventBuilder();
    b.focus(0, "Inbox");
    b.focus(50, "Calendar", "com.google.Chrome", "calendar.google.com");
    b.focus(55, "Zoom Meeting", "us.zoom.xos", "");
    b.at(155, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(spans.map((s) => [s.title, s.activeMs / 1000])).toEqual([
      ["Inbox", 55],
      ["Zoom Meeting", 100],
    ]);
  });

  test("a blip at the very start is absorbed by the next span", () => {
    const b = new EventBuilder();
    b.focus(0, "Calendar", "com.google.Chrome", "calendar.google.com");
    b.focus(4, "Inbox");
    b.at(64, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(spans.length).toBe(1);
    expect(spans[0]?.title).toBe("Inbox");
    expect(spans[0]?.activeMs).toBe(64_000);
  });

  test("input counts and OCR snapshots are attached to the span they fall in", () => {
    const b = new EventBuilder();
    b.focus(0, "New Message");
    const ocr = b.at(5, "ocr", { text: "To: jane@fund.vc", textHash: "h1" });
    b.at(60, "input", { keys: 120, clicks: 4 });
    b.at(120, "input", { keys: 80, clicks: 1 });
    b.at(130, "idle_start");
    const [span] = sessionize(b.events, DAY);
    expect(span?.keys).toBe(200);
    expect(span?.clicks).toBe(5);
    expect(span?.ocr.map((o) => o.eventId)).toEqual([ocr]);
    expect(span?.eventIds.length).toBe(4);
  });

  test("nothing is recorded between pause and the next focus after resume", () => {
    const b = new EventBuilder();
    b.focus(0, "Inbox");
    b.at(60, "pause");
    b.at(600, "resume");
    b.focus(660, "New Message");
    b.at(720, "idle_start");
    const spans = sessionize(b.events, DAY);
    expect(spans.map((s) => [s.title, s.activeMs / 1000])).toEqual([
      ["Inbox", 60],
      ["New Message", 60],
    ]);
  });

  test("events are processed in timestamp order even when given out of order", () => {
    const b = new EventBuilder();
    b.focus(0, "Inbox");
    b.focus(60, "New Message");
    b.at(120, "idle_start");
    const spans = sessionize([...b.events].reverse(), DAY);
    expect(spans.map((s) => s.title)).toEqual(["Inbox", "New Message"]);
  });

  test("totalActiveMs sums active time across spans", () => {
    const b = new EventBuilder();
    b.focus(0, "Inbox");
    b.focus(60, "New Message");
    b.at(90, "idle_start");
    expect(totalActiveMs(sessionize(b.events, DAY))).toBe(90_000);
  });

  test("span ids are stable and derived from the first event", () => {
    const b = new EventBuilder();
    const first = b.focus(0, "Inbox");
    b.at(30, "idle_start");
    expect(sessionize(b.events, DAY)[0]?.id).toBe(`sp_${first}`);
  });
});
