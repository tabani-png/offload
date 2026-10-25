// DETECT, NONNAME, PERSONAS, ROUNDTRIP: the deterministic name masker (brain/src/privacy/names.ts) on known answers.
import { describe, expect, test } from "bun:test";
import { maskText } from "../../src/grouping/normalize.ts";
import { collapsePlaceholders, maskNamesForStorage, NameMap, PERSON_PLACEHOLDER_RE, unrestoredPlaceholders } from "../../src/privacy/names.ts";
import { NAME_CASES, NON_NAMES, type NameCase } from "./corpus.ts";
import { measure } from "./rates.ts";

const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
const masked = (text: string, o?: ConstructorParameters<typeof NameMap>[0]) => new NameMap(o).mask(text);

describe("s18 masker: rule kinds", () => {
  test("DETECT: a given + family pair becomes one placeholder", () => {
    expect(masked("CV - Amara Okafor.pdf")).toBe("CV - <person:1>.pdf");
  });

  test("DETECT: an honorific keeps its title and masks the name after it (with or without a dot)", () => {
    expect(masked("Dear Ms Novak,")).toBe("Dear Ms <person:1>,");
    expect(masked("Dr. Helen Fischer will review it")).toBe("Dr. <person:1> will review it");
  });

  test("DETECT: greeting and role cues mask a name that is in no word list", () => {
    expect(masked("Dear Xochitl,")).toBe("Dear <person:1>,");
    expect(masked("Candidate: Wen Tanaka")).toBe("Candidate: <person:1>");
    expect(masked("Approved by Krzysztof Wiśniewski")).toBe("Approved by <person:1>");
  });

  test("DETECT: a weak cue needs a given name or a pair (from Kofi, not from Gmail)", () => {
    expect(masked("a message from Kofi")).toBe("a message from <person:1>");
    expect(masked("a message from Gmail")).toBe("a message from Gmail");
    expect(masked("from Acme")).toBe("from Acme");
  });

  test("DETECT: the line after a closing is a signature", () => {
    expect(masked("Cheers,\nTomoko")).toBe("Cheers,\n<person:1>");
    expect(masked("Thanks,\nThe Support Team")).toBe("Thanks,\nThe Support Team");
  });

  test("DETECT: a lone given name is masked; a given name that is also a word needs a family name or a cue", () => {
    expect(masked("Priya will call back")).toBe("<person:1> will call back");
    expect(masked("Will Smith and May Chen joined")).toBe("<person:1> and <person:2> joined");
    expect(masked("Mark as Read")).toBe("Mark as Read");
    expect(masked("Invoice due May 30")).toBe("Invoice due May 30");
  });

  test("DETECT: email local parts that equal a name are masked; role mailboxes are not", () => {
    expect(masked("write to goran.varga@falconit.com")).toBe("write to <person:1>@falconit.com");
    expect(masked("write to support@falconit.com")).toBe("write to support@falconit.com");
    expect(masked("billing@acme.com")).toBe("billing@acme.com");
  });

  test("DETECT: a known contact is masked in any case and across . - _ (identifiers, slugs)", () => {
    const m = new NameMap({ known: ["Bartholomew Quist"] });
    const out = m.mask("bartholomew quist sent the file; see /in/bartholomew-quist");
    expect(out).not.toMatch(/bartholomew|quist/i);
    expect(m.unmask(out)).toBe("bartholomew quist sent the file; see /in/bartholomew-quist");
  });

  test("DETECT: a name learned once is masked everywhere in the run, and its first and family names alone too", () => {
    const m = new NameMap();
    expect(m.mask("Amara Okafor - Product Designer - Greenhouse")).toBe("<person:1> - Product Designer - Greenhouse");
    expect(m.mask("Okafor's portfolio; Amara replied")).toBe("<person:1.last>'s portfolio; <person:1.first> replied");
    expect(m.mask("cv - amara okafor.pdf")).toBe("cv - <person:1.full>.pdf");
  });

  test("DETECT: placeholders are stable per run: the same person keeps the same number across calls", () => {
    const m = new NameMap();
    const a = m.mask("Hi Keiko, Ivan Petrov is in copy.");
    const b = m.mask("Ivan Petrov and Keiko again; now Rosa Silva.");
    expect(a).toBe("Hi <person:1>, <person:2> is in copy.");
    expect(b).toBe("<person:2> and <person:1> again; now <person:3>.");
    expect(m.size).toBe(3);
  });

  test("DETECT: organisations, products and protected company names are never people", () => {
    for (const t of ["Felix Capital", "Chen Logistics", "Morgan Stanley", "Google Chrome", "Mateo Analytics Ltd"]) expect(masked(t)).toBe(t);
  });

  test("DETECT: placeholders already in a text stay as they are (idempotent)", () => {
    const m = new NameMap();
    const once = m.mask("Hi Keiko, order #12 for <email>");
    expect(m.mask(once)).toBe(once);
  });

  test("DETECT: maskText keeps person placeholders whole (their numbers are not <n>)", () => {
    expect(maskText("<person:12> paid 40.00 to <person:me.first> on 2026-10-01")).toBe("<person:12> paid <n> to <person:me.first> on <date>");
    expect(maskText("order 42 <person:x>")).toBe("order <n> <person:x>");
  });

  test("DETECT: storage masking collapses every person to <name> and keeps no numbering", () => {
    expect(maskNamesForStorage("Writing a scorecard for Amara Okafor and Ivan Petrov")).toBe("Writing a scorecard for <name> and <name>");
    expect(collapsePlaceholders("<person:1> <person:2.last> met")).toBe("<name> met");
    expect(maskNamesForStorage("Writing a scorecard for Amara Okafor")).not.toMatch(PERSON_PLACEHOLDER_RE);
  });
});

describe("s18 masker: no false positives on non-names", () => {
  test("NONNAME: UI labels, months, days, products, companies, job titles and headings stay unmasked", () => {
    const changed = NON_NAMES.filter((l) => maskNamesForStorage(l) !== l);
    expect(changed).toEqual([]);
  });

  test("NONNAME: the words each persona case must keep survive masking", () => {
    for (const c of NAME_CASES) {
      const m = maskNamesForStorage(c.text);
      for (const k of c.keep ?? []) expect({ text: c.text, keep: k, ok: m.includes(k) }).toEqual({ text: c.text, keep: k, ok: true });
    }
  });

  test("NONNAME: measured false-positive rate is at most 2%", () => {
    const r = measure();
    expect(r.fp.total).toBeGreaterThanOrEqual(250);
    expect(r.fp.pct).toBeLessThanOrEqual(2);
  });
});

describe("s18 masker: the five s12 personas and founder outreach", () => {
  const check = (persona: NameCase["persona"]) => {
    const cases = NAME_CASES.filter((c) => c.persona === persona);
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const m = maskNamesForStorage(c.text);
      for (const n of c.names) expect({ text: c.text, name: n, readable: word(n).test(m) }).toEqual({ text: c.text, name: n, readable: false });
    }
  };
  test("PERSONAS: recruiter CVs, Greenhouse titles and cover letters", () => check("recruiter"));
  test("PERSONAS: bookkeeper invoices with contact names", () => check("bookkeeper"));
  test("PERSONAS: support tickets (customers, agents, sign-offs, requester addresses)", () => check("support"));
  test("PERSONAS: sales-ops rows (names, slugs, work addresses)", () => check("salesops"));
  test("PERSONAS: founder outreach (recipients, replies, the founder's own signature)", () => check("founder"));
  test("PERSONAS: measured false-negative rate is at most 5% over every listed name", () => {
    const r = measure();
    expect(r.fn.total).toBeGreaterThanOrEqual(80);
    expect(r.fn.pct).toBeLessThanOrEqual(5);
  });
});

describe("s18 masker: round trip", () => {
  test("ROUNDTRIP: unmask(mask(x)) === x for every corpus text, in one run-wide map", () => {
    const m = new NameMap({ self: ["Muhammad Ali"], known: ["Kofi Larsen"] });
    for (const t of [...NAME_CASES.map((c) => c.text), ...NON_NAMES]) expect(m.unmask(m.mask(t))).toBe(t);
  });

  test("ROUNDTRIP: casing variants of one person get their own placeholder, so the round trip stays exact", () => {
    const m = new NameMap();
    const t = "Amara Okafor / AMARA OKAFOR / amara.okafor@x.io / amara-okafor";
    const out = m.mask(t);
    expect(out).not.toMatch(/amara|okafor/i);
    expect(m.unmask(out)).toBe(t);
  });

  test("ROUNDTRIP: the map serialises to a count only, never a name", () => {
    const m = new NameMap({ self: ["Muhammad Ali"] });
    m.mask("Hi Anna, Ivan Petrov and Muhammad Ali");
    const json = JSON.stringify({ map: m });
    expect(json).toBe('{"map":{"people":3}}');
    expect(json).not.toMatch(/Anna|Ivan|Petrov|Muhammad/);
  });

  test("ROUNDTRIP: a placeholder the map never wrote is left visible and reported", () => {
    const m = new NameMap();
    m.mask("Hi Keiko");
    const back = m.unmask("Hi <person:1>, cc <person:7>");
    expect(back).toBe("Hi Keiko, cc <person:7>");
    expect(unrestoredPlaceholders(back)).toEqual(["<person:7>"]);
  });
});
