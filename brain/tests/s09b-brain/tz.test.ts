// s09b: timeline hours shift. Root cause: fixtures/gen.ts built each day from Date.UTC midnight (+8.5 h), so the
// fixture's "08:30" morning was 08:30 UTC: 04:30 in Toronto, 13:30 in Karachi. The reader and the timeline were right
// (a 09:00 local span already rendered at 09:00); the fix is in the generator, which now builds local days.
// Each zone runs in its own process so TZ applies from the first Date.
import { describe, expect, test } from "bun:test";
import { generateFixture } from "../../fixtures/gen.ts";

const PROBE = new URL("./tz-probe.ts", import.meta.url).pathname;

interface Probe {
  tz: string;
  fixtureEventsOffDay: number;
  fixtureFirstEvent: Array<{ day: string; at: string }>;
  fixtureFirstSpan: string;
  fixtureLastSpanEnd: string;
  fixtureSpansOffDay: number;
  handSpan: string | null;
}

function probe(tz: string): Probe {
  const r = Bun.spawnSync(["bun", "run", PROBE], { env: { ...process.env, TZ: tz, OFFLOAD_KEYS: "file" } });
  if (r.exitCode !== 0) throw new Error(`probe ${tz} failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as Probe;
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

describe("s09b timeline time zones", () => {
  for (const tz of ["America/Toronto", "Asia/Karachi", "UTC"]) {
    test(`TZ: in ${tz} a 09:00 local span renders at 09:00 and the fixture morning starts at 08:30 local`, () => {
      const p = probe(tz);
      expect(p.tz).toBe(tz === "UTC" ? "UTC" : tz);
      expect(p.handSpan).toBe("09:00");
      // Weekdays start 08:30 + 0..10 min; weekends 9..11 h after local midnight.
      for (const f of p.fixtureFirstEvent.slice(0, 5)) expect(minutes(f.at)).toBeGreaterThanOrEqual(8 * 60 + 30), expect(minutes(f.at)).toBeLessThanOrEqual(8 * 60 + 40);
      for (const f of p.fixtureFirstEvent.slice(5)) expect(minutes(f.at)).toBeGreaterThanOrEqual(9 * 60), expect(minutes(f.at)).toBeLessThanOrEqual(11 * 60);
      expect(minutes(p.fixtureFirstSpan)).toBeGreaterThanOrEqual(8 * 60 + 30);
      expect(minutes(p.fixtureFirstSpan)).toBeLessThan(9 * 60);
      // The working day ends in the evening, on the same local day.
      expect(minutes(p.fixtureLastSpanEnd)).toBeGreaterThan(15 * 60);
      expect(p.fixtureEventsOffDay).toBe(0);
      expect(p.fixtureSpansOffDay).toBe(0);
    });
  }

  test("TZ: the fixture week is the same activity in every zone: same day labels, same local clock times", () => {
    const here = generateFixture({ seed: 42 });
    expect(here.map((d) => d.day)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    const tor = probe("America/Toronto");
    const kar = probe("Asia/Karachi");
    expect(tor.fixtureFirstEvent).toEqual(kar.fixtureFirstEvent);
    expect(tor.fixtureFirstSpan).toBe(kar.fixtureFirstSpan);
    expect(tor.fixtureLastSpanEnd).toBe(kar.fixtureLastSpanEnd);
    // Monday and Tuesday are weekdays, Saturday and Sunday the weekend, by the local calendar.
    const first = (d: string) => new Date(here.find((x) => x.day === d)!.events[0]!.ts);
    expect(first("2026-10-12").getDay()).toBe(1);
    expect(first("2026-10-17").getDay()).toBe(6);
    expect(first("2026-10-18").getDay()).toBe(0);
  });
});
