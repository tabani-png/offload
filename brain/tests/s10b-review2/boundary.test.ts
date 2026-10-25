// s10b N7 (REVIEW-2): the same-user trust boundary is written down in the slice SPEC.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const spec = () => readFileSync(new URL("../../../slices/s10b-review2-brain/SPEC.md", import.meta.url).pathname, "utf8");

describe("s10b N7: trust boundary", () => {
  test("N7: SPEC states that same-user process access is the macOS trust boundary", () => {
    const s = spec();
    expect(s).toMatch(/same[- ]user/i);
    expect(s).toMatch(/trust boundary/i);
  });

  test("N7: SPEC says what we defend and what we do not", () => {
    const s = spec();
    expect(s).toMatch(/we defend/i);
    expect(s).toMatch(/we do not defend/i);
  });
});
