// HELDOUT (review wave B, PR #7 item 3): the false-negative rate on names the masker was not tuned on (outside the
// lexicons, no cue) is measured and reported apart from the tuned corpus, so the known limit is a number, not a guess.
import { describe, expect, test } from "bun:test";
import { AMBIGUOUS_GIVEN, CLOSINGS, FAMILY, GIVEN, GREETING_CUES, HONORIFICS, ROLE_CUES, WEAK_CUES } from "../../src/privacy/lexicon.ts";
import { NAME_CASES } from "./corpus.ts";
import { HELD_OUT } from "./heldout.ts";
import { measure, measureHeldOut } from "./rates.ts";

describe("s18 held-out names", () => {
  test("HELDOUT: every held-out name is outside the lexicons and appears with no cue", () => {
    expect(HELD_OUT.length).toBeGreaterThanOrEqual(30);
    for (const c of HELD_OUT) {
      for (const n of c.names) {
        for (const part of n.toLowerCase().split(" ")) expect({ n, part, inLexicon: GIVEN.has(part) || FAMILY.has(part) || AMBIGUOUS_GIVEN.has(part) }).toEqual({ n, part, inLexicon: false });
        const lines = c.text.split("\n");
        const at = lines.findIndex((l) => l.includes(n));
        const before = lines[at]!.slice(0, lines[at]!.indexOf(n)).trim().split(/\s+/).pop()?.toLowerCase().replace(/[,:!]$/, "") ?? "";
        expect({ n, before, cue: GREETING_CUES.has(before) || ROLE_CUES.has(before) || WEAK_CUES.has(before) || HONORIFICS.has(before.replace(/\.$/, "")) }).toEqual({ n, before, cue: false });
        expect(at > 0 && CLOSINGS.test(lines[at - 1]!.trim())).toBe(false);
      }
    }
  });

  test("HELDOUT: the held-out set is disjoint from the tuned corpus", () => {
    const tuned = NAME_CASES.flatMap((c) => c.names.flatMap((n) => n.toLowerCase().split(/[\s.]+/)));
    for (const c of HELD_OUT) for (const n of c.names) for (const part of n.toLowerCase().split(" ")) expect(tuned).not.toContain(part);
  });

  test("HELDOUT: its false-negative rate is measured over every held-out name and reported apart from the tuned rate", () => {
    const h = measureHeldOut();
    const r = measure();
    expect(h.total).toBe(HELD_OUT.reduce((a, c) => a + c.names.length, 0));
    expect(h.count).toBe(h.examples.length);
    expect(h.pct).toBe(Math.round((h.count / h.total) * 10000) / 100);
    expect(r.heldOut).toEqual(h);
    // The tuned rate is computed over the tuned corpus only.
    expect(r.fn.total).toBe(NAME_CASES.reduce((a, c) => a + c.names.length, 0));
  });
});
