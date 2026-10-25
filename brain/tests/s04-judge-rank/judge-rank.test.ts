import { describe, expect, test } from "bun:test";
import { heuristicJudge, type Judge } from "../../src/insights/judge.ts";
import { rankingScore, SCORE_FORMULA } from "../../src/insights/rank.ts";
import { profile } from "../helpers.ts";

const external = { counterparties: ["a@fund.vc", "b@other.vc"], domains: ["fund.vc", "other.vc"] };

describe("heuristic judge", () => {
  test("writing to external people is an external send and carries risk", () => {
    const r = heuristicJudge.judge({ profile: profile({ identifiers: external }), sameness: 0.9 });
    expect(r.risk).toBe(0.5);
    expect(r.reasons.join(" ")).toContain("external send");
  });

  test("templated writing has low judgement, free-form one-off writing has high judgement", () => {
    const templated = heuristicJudge.judge({ profile: profile({ identifiers: external }), sameness: 0.9 });
    const freeForm = heuristicJudge.judge({ profile: profile({ identifiers: external }), sameness: 0.2 });
    expect(templated.judgement).toBeLessThan(0.2);
    expect(freeForm.judgement).toBeGreaterThan(0.7);
    expect(freeForm.reasons.join(" ")).toContain("free-form");
  });

  test("reading mail without writing is triage: judgement, no send risk", () => {
    const r = heuristicJudge.judge({ profile: profile({ keysPerMinute: 2, template: "Inbox (<n>) - <email> - Gmail" }), sameness: 0.9 });
    expect(r.risk).toBe(0);
    expect(r.judgement).toBeGreaterThanOrEqual(0.5);
  });

  test("a mail list view is triage even when per-minute key counts are high", () => {
    const r = heuristicJudge.judge({ profile: profile({ keysPerMinute: 120, template: "Inbox (<n>) - <email> - Gmail" }), sameness: 0.7 });
    expect(r.risk).toBe(0);
    expect(r.reasons[0]).toContain("triage");
  });

  test("live calls and coding need high judgement", () => {
    expect(heuristicJudge.judge({ profile: profile({ category: "call", app: "us.zoom.xos" }), sameness: 1 }).judgement).toBeGreaterThanOrEqual(0.9);
    expect(heuristicJudge.judge({ profile: profile({ category: "code", app: "com.apple.Terminal" }), sameness: 1 }).judgement).toBeGreaterThanOrEqual(0.8);
  });

  test("spreadsheet updates are structured entry with low judgement", () => {
    expect(heuristicJudge.judge({ profile: profile({ category: "sheet" }), sameness: 0.8 }).judgement).toBeLessThan(0.3);
  });

  test("judge outputs stay inside 0..1", () => {
    for (const category of ["email", "chat", "call", "code", "sheet", "calendar", "social", "browse", "other"] as const) {
      for (const sameness of [0, 0.5, 1]) {
        const r = heuristicJudge.judge({ profile: profile({ category, identifiers: external }), sameness });
        expect(r.judgement).toBeGreaterThanOrEqual(0);
        expect(r.judgement).toBeLessThanOrEqual(1);
        expect(r.risk).toBeGreaterThanOrEqual(0);
        expect(r.risk).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a custom Judge satisfies the same interface", async () => {
    const j: Judge = { judge: async () => ({ judgement: 0.1, risk: 0.1, reasons: ["model"] }) };
    expect((await j.judge({ profile: profile(), sameness: 1 })).reasons).toEqual(["model"]);
  });
});

describe("ranking score", () => {
  test("score = volume x sameness x reachability x (1 - judgement) x (1 - risk/2)", () => {
    expect(rankingScore({ volume: 0.6, sameness: 0.9, reachability: 1, judgement: 0.1, risk: 0.5 })).toBeCloseTo(0.6 * 0.9 * 1 * 0.9 * 0.75, 12);
    expect(SCORE_FORMULA).toBe("volume × sameness × reachability × (1 − judgement) × (1 − risk/2)");
  });

  test("no connector means score 0", () => {
    expect(rankingScore({ volume: 0.5, sameness: 1, reachability: 0, judgement: 0, risk: 0 })).toBe(0);
  });

  test("inputs outside 0..1 are rejected", () => {
    expect(() => rankingScore({ volume: 1.2, sameness: 1, reachability: 1, judgement: 0, risk: 0 })).toThrow(/volume/);
  });
});
