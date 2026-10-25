// AC-2 DESCRIBE: span descriptions from frame notes (weighted vote) or rules; identifiers; masked text; refiner limits.
import { describe, expect, test } from "bun:test";
import { describeSpans, refineDescriptions, type SpanDescription } from "../../src/understanding/describe.ts";
import type { FrameNote } from "../../src/understanding/frames.ts";
import { span } from "./setup.ts";

const f = (id: string, ts: number, over: Partial<FrameNote>): FrameNote => ({ id, ts, kind: "frame", frameId: `kf_${id}`, model: "stub", activity: "Doing something", confidence: 0.8, ...over });

const preview = span({ id: "sp_p", start: 0, end: 60_000, app: "com.apple.Preview", appName: "Preview", title: "INV-20481 Acme Office Supply.pdf" });
const frames = new Map<string, FrameNote[]>([
  [
    "sp_p",
    [
      f("1", 1000, { verb: "read", object: "supplier invoice", surface: "Preview PDF viewer", step: "reading the amount", activity: "Reading a supplier invoice from Acme Office Supply", counterpart: "Acme Office Supply", identifiers: ["INV-20481", "Acme Office Supply"], confidence: 0.9 }),
      f("2", 2000, { verb: "check", object: "invoice", confidence: 0.4 }),
      f("3", 3000, { verb: "check", object: "invoice", confidence: 0.3 }),
    ],
  ],
]);

describe("DESCRIBE", () => {
  test("frame fields win by confidence-weighted vote", () => {
    const [d] = describeSpans([preview], frames);
    expect(d!.verb).toBe("read");
    expect(d!.object).toBe("supplier invoice");
    expect(d!.surface).toBe("Preview PDF viewer");
    expect(d!.source).toBe("frames");
    expect(d!.frameIds).toEqual(["1", "2", "3"]);
    expect(d!.confidence).toBe(0.9);
  });

  test("identifiers come from frames and the title, normalised; the user's own address never appears", () => {
    const mail = span({ id: "sp_m", start: 100_000, end: 160_000, title: "Re: invoice - me@ledgerly.co - Gmail", host: "mail.google.com", url: "https://mail.google.com/mail/u/0/", ocr: [{ eventId: "o1", ts: 101_000, text: "From supplier@acme.com to me@ledgerly.co" }] });
    const ticket = span({ id: "sp_t", start: 200_000, end: 260_000, title: "Ticket #48213: Refund - Zendesk", host: "acme.zendesk.com", url: "https://acme.zendesk.com/agent/tickets/48213" });
    const [p, m, t] = describeSpans([preview, mail, ticket], frames, { ownEmails: ["me@ledgerly.co"] });
    expect(p!.identifiers).toEqual(expect.arrayContaining(["inv-20481", "acme office supply", "inv-20481 acme office supply.pdf"]));
    expect(m!.identifiers).toContain("supplier@acme.com");
    expect(m!.identifiers.join(" ")).not.toContain("me@ledgerly.co");
    expect(t!.identifiers).toEqual(expect.arrayContaining(["#48213", "acme.zendesk.com/agent/tickets/48213"]));
  });

  test("without frames the description is composed from category, title template and input counts", () => {
    const compose = span({ id: "sp_c", start: 0, end: 120_000, title: "New Message", host: "mail.google.com", url: "https://mail.google.com/mail/u/0/", keys: 300 });
    const inbox = span({ id: "sp_i", start: 200_000, end: 260_000, title: "Inbox (3) - me@x.io - Gmail", host: "mail.google.com", url: "https://mail.google.com/mail/u/0/", keys: 2 });
    const [c, i] = describeSpans([compose, inbox], new Map());
    expect([c!.verb, c!.object, c!.source, c!.category]).toEqual(["write", "email", "rules", "email"]);
    expect([i!.verb, i!.object]).toEqual(["read", "email"]);
    expect(c!.confidence).toBe(0.5);
  });

  test("the embedded text is masked and carries no identifiers or counterpart", () => {
    const [d] = describeSpans([preview], frames);
    expect(d!.text).not.toMatch(/acme/i);
    expect(d!.text).not.toMatch(/20481/);
    expect(d!.text).toContain("supplier invoice");
  });

  test("deterministic: the same input gives the same descriptions", () => {
    expect(describeSpans([preview], frames)).toEqual(describeSpans([preview], frames));
  });

  test("a refiner may reword text fields only; malformed or failing refiners change nothing", async () => {
    const [d] = describeSpans([preview], frames);
    const base = d as SpanDescription;
    const [r] = await refineDescriptions([base], { refine: () => ({ verb: "Transcribe", identifiers: ["x"], start: 0 } as never) });
    expect(r!.verb).toBe("transcribe");
    expect(r!.identifiers).toEqual(base.identifiers);
    expect(r!.start).toBe(base.start);
    expect(r!.text).toContain("transcribe");
    const [bad] = await refineDescriptions([base], { refine: () => ({ verb: "", object: "y".repeat(81), step: 5 } as never) });
    expect([bad!.verb, bad!.object, bad!.step]).toEqual([base.verb, base.object, base.step]);
    const [threw] = await refineDescriptions([base], {
      refine: () => {
        throw new Error("model down");
      },
    });
    expect(threw!.activity).toBe(base.activity);
  });
});
