// Review round 2 item 2: every registered surface matches in any case.
import { describe, expect, test } from "bun:test";
import { NameMap } from "../../src/privacy/names.ts";

const roundTrip = (m: NameMap, t: string) => {
  const out = m.mask(t);
  expect(m.unmask(out)).toBe(t);
  return out;
};

describe("s18 round 2: every surface matches in any case", () => {
  test("DETECT: a known single-name contact is masked in lower case and all caps", () => {
    const m = new NameMap({ known: ["Zorblax"] });
    for (const t of ["zorblax", "ZORBLAX", "Zorblax"]) expect(roundTrip(m, t)).not.toMatch(/zorblax/i);
  });

  test("DETECT: a learned first and family name is masked in all caps, lower case and the possessive", () => {
    const m = new NameMap();
    m.mask("Tomasz Novak and Amara Okafor joined");
    const out = roundTrip(m, "TOMASZ, AMARA and NOVAK; amara's notes; okafor replied");
    expect(out).not.toMatch(/tomasz|amara|novak|okafor/i);
    expect(out).toContain("'s notes");
  });

  test("SELF: the user's own first and family names are masked in any case", () => {
    const m = new NameMap({ self: ["Muhammad Ali"] });
    expect(roundTrip(m, "MUHAMMAD here; ali signed")).not.toMatch(/muhammad|\bali\b/i);
  });
});
