// s32 (PR #39 review): the 30-day window reaches every retained thing, and /status reports what is retained, not
// only the 7-day analysis week.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { APP_TARGET_RETAIN_MS, knownTarget, rememberTargets } from "../../src/connectors/chain.ts";
import type { StatusResponse } from "../../src/api/types.ts";
import { createBrain, type Brain } from "../../src/api/server.ts";
import { KEEP_DAYS } from "../../src/store/vault.ts";
import { targetForProfile } from "../../src/connectors/targets.ts";
import { profile, tempHome } from "../helpers.ts";

const DAY_MS = 86_400_000;

describe("s32: connector chain app targets follow the retention window", () => {
  test("APP_TARGET_RETAIN_MS is KEEP_DAYS days; a target seen 8 days ago is still known", () => {
    expect(APP_TARGET_RETAIN_MS).toBe(KEEP_DAYS * DAY_MS);
    const { home, cleanup } = tempHome();
    try {
      const now = Date.UTC(2026, 9, 20, 12);
      const qb = targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks Online", host: "" }));
      rememberTargets(home, [qb], now);
      expect(knownTarget(home, qb.id, now)).not.toBeNull();
      expect(knownTarget(home, qb.id, now + 8 * DAY_MS)).not.toBeNull();
      expect(knownTarget(home, qb.id, now + KEEP_DAYS * DAY_MS)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("s32: /status reports retained days separately from the analysis week", () => {
  const TOKEN = "t".repeat(48);
  const fx = tempHome();
  let brain: Brain;
  // The fixture week is 2026-10-12..18; five older plain days inside 30 days are retained but not analysed.
  const older = ["2026-09-25", "2026-09-28", "2026-10-01", "2026-10-05", "2026-10-08"];
  beforeAll(() => {
    writeFixture(fx.home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
    mkdirSync(join(fx.home, "days"), { recursive: true });
    for (const d of older) writeFileSync(join(fx.home, "days", `${d}.jsonl`), "");
    // Older than 30 days on 2026-10-18: neither retained nor analysed.
    writeFileSync(join(fx.home, "days", "2026-09-10.jsonl"), "");
    brain = createBrain({ home: fx.home, token: TOKEN, now: () => Date.UTC(2026, 9, 18, 20, 0), env: { OFFLOAD_OBSERVER_BIN: join(fx.home, "no-observer") } } as never);
  });
  afterAll(() => fx.cleanup());

  test("store.days stays the 7-day analysis week; retention.days lists every retained day; nextPurgeDay is the oldest retained", async () => {
    const res = await brain.handle(new Request("http://127.0.0.1:4545/status", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    const s = (await res.json()) as StatusResponse;
    expect(s.store.days.length).toBe(7);
    expect(s.analysis.windowDays.length).toBe(7);
    expect(s.retention.keepDays).toBe(30);
    expect(s.retention.days).toEqual([...older, "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(s.retention.nextPurgeDay).toBe("2026-09-25");
  });
});
