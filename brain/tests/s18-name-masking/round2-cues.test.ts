// Review round 2 item 1: names a greeting or the user confirms, though the word filter would drop them.
import { describe, expect, test } from "bun:test";
import { NameMap } from "../../src/privacy/names.ts";
import { untag } from "./names.ts";

const masked = (text: string, o?: ConstructorParameters<typeof NameMap>[0]) => untag(new NameMap(o).mask(text));
const roundTrip = (m: NameMap, t: string) => {
  const out = m.mask(t);
  expect(m.unmask(out)).toBe(t);
  return out;
};

describe("s18 round 2: cue-confirmed and explicit names that are also words", () => {
  test("DETECT: a greeting confirms Will, May and Bill as names, so they are masked", () => {
    expect(masked("Dear Will,")).toBe("Dear <person:1>,");
    expect(masked("Dear May,")).toBe("Dear <person:1>,");
    expect(masked("Hi Bill, the invoice is attached.")).toBe("Hi <person:1>, the invoice is attached.");
  });

  test("SELF: the user's own name masks its first name even when the first name is a word (Will Smith -> Dear Will)", () => {
    const m = new NameMap({ self: ["Will Smith"] });
    const out = roundTrip(m, "Dear Will,\nthanks. Will Smith");
    expect(out).not.toMatch(/Will|Smith/);
    expect(untag(out)).toBe("Dear <person:me>,\nthanks. <person:me.full>");
  });

  test("DETECT: a known contact whose name is a word (Bill) is masked where written as a name", () => {
    const m = new NameMap({ known: ["Bill"] });
    expect(roundTrip(m, "Bill sent it")).not.toMatch(/Bill/);
  });

  test("NONNAME: uncued prose keeps the word filter, and a name that is a word never masks the lowercase word", () => {
    expect(masked("Will you send it in May?")).toBe("Will you send it in May?");
    const m = new NameMap();
    expect(untag(m.mask("Dear Will,"))).toBe("Dear <person:1>,");
    expect(untag(m.mask("I will pay the bill in may"))).toBe("I will pay the bill in may");
  });
});
