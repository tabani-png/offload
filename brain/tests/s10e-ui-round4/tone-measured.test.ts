// s10e work item 3: "Your voice" measured in code from the sent mail. GET/PUT /workflows/:id/tone carries `measured`
// (null without a tone pack), computed with measureStyle over the workflow's bucket; `sample` is one real sentence.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SENT_MAIL } from "../../fixtures/sent-mail.ts";
import type { ToneCardDTO } from "../../src/api/types.ts";
import { cleanEmail } from "../../src/tone/clean.ts";
import { loadTonePack } from "../../src/tone/pack.ts";
import { measureStyle, sampleSentence, toneMeasured } from "../../src/tone/style.ts";
import type { SentEmail } from "../../src/tone/types.ts";
import { linkWorld, type LinkWorld } from "./setup.ts";

let x: LinkWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

const mail = (id: string, body: string): SentEmail => ({ id, to: ["a@b.vc"], subject: "s", body, sentAt: 1 });
const SMALL = [
  mail("m1", "Hi Ana,\n\nOne two three four five six.\n\nCall?\n\nMuhammad"),
  mail("m2", "Hi Bo,\n\nSeven words are in this one sentence here. Second sentence is short!\n\nMuhammad"),
  mail("m3", "Hello Cy,\n\nTiny.\n\nThanks,\nMuhammad"),
].map(cleanEmail);

describe("s10e tone measured", () => {
  test("a small corpus: counts, greeting, sign-off, shares, sample and source", () => {
    const m = toneMeasured("investor_outreach", SMALL)!;
    const st = measureStyle(SMALL);
    expect(m).toEqual({
      emails: 3,
      medianWords: st.medianWords,
      p90Words: st.p90Words,
      medianSentences: st.medianSentences,
      greeting: { form: "Hi {first},", count: 2 },
      sign: { form: "Muhammad", count: 2 },
      askShare: 0.33,
      exclamationShare: 0.33,
      sample: "One two three four five six.",
      source: "3 sent investor emails",
    });
    expect(m.medianWords).toBe(7);
  });

  test("no emails -> null; one email -> singular source; the sample is never the greeting or sign-off", () => {
    expect(toneMeasured("scheduling", [])).toBeNull();
    const one = toneMeasured("follow_up", [SMALL[2]!])!;
    expect(one.source).toBe("1 sent follow-up email");
    expect(one.sample).toBe("Tiny.");
    expect(toneMeasured("other", SMALL)!.source).toBe("3 sent emails");
    for (const e of SENT_MAIL.map(cleanEmail)) {
      const s = sampleSentence([e]);
      if (s === null) continue;
      expect(s).not.toMatch(/^(Hi|Hello|Hey|Dear) /);
      expect(s).not.toBe("Muhammad");
      expect(s.length).toBeLessThanOrEqual(140);
      expect(e.core).toContain(s);
    }
  });

  test("the sample is deterministic and comes from the corpus", () => {
    const fixture = SENT_MAIL.slice(0, 18).map(cleanEmail);
    const a = sampleSentence(fixture);
    expect(sampleSentence([...fixture].reverse())).toBe(a);
    expect(fixture.some((e) => e.core.includes(a!))).toBe(true);
  });

  test("GET /workflows/:id/tone returns the card text and the measured voice of the workflow's bucket", async () => {
    x = await linkWorld();
    const r = await x.call<ToneCardDTO>(`/workflows/${x.outreach.id}/tone`);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe("investor_outreach");
    expect(r.body.text).toContain("## Voice");
    const bucket = loadTonePack(x.home, x.clock.now)!.corpus.filter((e) => e.bucket === "investor_outreach");
    expect(r.body.measured).toMatchObject({ emails: bucket.length, greeting: { form: "Hi {first},", count: bucket.length }, sign: { form: "Muhammad", count: bucket.length }, exclamationShare: 0, source: `${bucket.length} sent investor emails` });
    expect(r.body.measured!.askShare).toBeGreaterThan(0.8);
    expect(r.body.measured!.medianWords).toBeGreaterThan(20);
    expect(bucket.some((e) => e.core.includes(r.body.measured!.sample!))).toBe(true);
    // PUT answers with the same measured block.
    const put = await x.call<ToneCardDTO>(`/workflows/${x.outreach.id}/tone`, { method: "PUT", body: { text: "- Short.\n- Direct." } });
    expect(put.body.measured).toEqual(r.body.measured);
  });

  test("without a tone pack, measured is null", async () => {
    x = await linkWorld();
    rmSync(join(x.home, "tone"), { recursive: true, force: true });
    const r = await x.call<ToneCardDTO>(`/workflows/${x.outreach.id}/tone`);
    expect(r.body.text).toBeNull();
    expect(r.body.measured).toBeNull();
  });
});
