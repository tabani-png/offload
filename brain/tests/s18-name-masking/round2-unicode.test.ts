// Review round 2 item 3: Unicode variants of a name (NFD, zero-width characters) are masked and restore as written.
import { describe, expect, test } from "bun:test";
import { NameMap } from "../../src/privacy/names.ts";
import { untag } from "./names.ts";

const roundTrip = (m: NameMap, t: string) => {
  const out = m.mask(t);
  expect(m.unmask(out)).toBe(t);
  return out;
};

describe("s18 round 2: Unicode variants of a name", () => {
  test("ROUNDTRIP: a decomposed (NFD) name is masked whole and restores to the exact input bytes", () => {
    const nfd = "Contract for José García".normalize("NFD");
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    const m = new NameMap();
    const out = roundTrip(m, nfd);
    expect(untag(out)).toBe("Contract for <person:1>");
    expect(out).not.toMatch(/\p{M}|Garc/u);
  });

  test("ROUNDTRIP: a zero-width character inside a name does not hide it, and restores as written", () => {
    for (const zw of ["​", "‌", "‍", "⁠", "﻿", "­"]) {
      const t = `Am${zw}ara Okafor sent it`;
      const m = new NameMap();
      const out = roundTrip(m, t);
      expect(untag(out)).toBe("<person:1> sent it");
    }
  });

  test("ROUNDTRIP: a composed and a decomposed spelling of one person are the same person, each restored as written", () => {
    const m = new NameMap();
    // "for" is the cue: "José" and "García" are outside the lexicon (an uncued pair of them is the documented recall gap).
    const t = `for José García; for ${"José García".normalize("NFD")}; José`;
    const out = roundTrip(m, t);
    expect(untag(out)).toMatch(/^for <person:1>; for <person:1\.full(?:~\d+)?>; <person:1\.first>$/);
  });
});
