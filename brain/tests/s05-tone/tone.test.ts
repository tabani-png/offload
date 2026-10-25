// s05 AC-2: tone pack. Clean -> bucket -> style card (measured in code + voice from the cheap model) -> BM25 retrieval.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SENT_MAIL } from "../../fixtures/sent-mail.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { Bm25, tokenize } from "../../src/tone/bm25.ts";
import { modelBucketer, ruleBucket } from "../../src/tone/bucket.ts";
import { cleanEmail } from "../../src/tone/clean.ts";
import { FixtureMailSource, McpMailSource, parseMailToolResult } from "../../src/tone/mail-source.ts";
import { buildTonePack, loadTonePack, retrieveExamples } from "../../src/tone/pack.ts";
import { measureStyle } from "../../src/tone/style.ts";
import { runBlindTest, readBlindFile } from "../../src/tone/blind.ts";
import type { SentEmail } from "../../src/tone/types.ts";
import { tempHome } from "../helpers.ts";

const mail = (body: string, subject = "Hello"): SentEmail => ({ id: "m1", to: ["a@x.com"], subject, body, sentAt: 0 });

let home = "";
let cleanup = () => {};
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

describe("s05 tone: clean", () => {
  test("drops a quoted reply after 'On ... wrote:'", () => {
    const c = cleanEmail(mail("Hi Anna,\n\nTuesday works.\n\nMuhammad\n\nOn Mon, 7 Sep 2026 at 16:02, Anna <anna@x.com> wrote:\n> What times work?"));
    expect(c.text).toBe("Hi Anna,\n\nTuesday works.\n\nMuhammad");
  });

  test("drops '>' lines and a '--' signature block", () => {
    const c = cleanEmail(mail("Hi Tom,\n\nShort one.\n> old text\n\nMuhammad\n\n--\nMuhammad Ali\nFounder, Offload\n+44 7700 900123"));
    expect(c.text).toBe("Hi Tom,\n\nShort one.\n\nMuhammad");
  });

  test("drops a forwarded message", () => {
    const c = cleanEmail(mail("Hi Peter,\n\nComments attached.\n\nMuhammad\n\n---------- Forwarded message ---------\nFrom: Nina <n@x.com>\n> See attached."));
    expect(c.text).toBe("Hi Peter,\n\nComments attached.\n\nMuhammad");
  });

  test("finds greeting, close and sign name; core is the middle", () => {
    const c = cleanEmail(mail("Team,\n\nBoard pack is in the drive.\n\nThanks,\nMuhammad"));
    expect(c.greeting).toBe("Team,");
    expect(c.close).toBe("Thanks,");
    expect(c.signName).toBe("Muhammad");
    expect(c.core).toBe("Board pack is in the drive.");
    const d = cleanEmail(mail("Hi Anna,\n\nTuesday works.\n\nMuhammad"));
    expect(d.close).toBeNull();
    expect(d.signName).toBe("Muhammad");
  });

  test("drops title and phone lines after the sign name", () => {
    const c = cleanEmail(mail("Hi Jo,\n\nYes.\n\nBest,\nMuhammad\nFounder, Offload\n+44 7700 900123"));
    expect(c.text).toBe("Hi Jo,\n\nYes.\n\nBest,\nMuhammad");
  });
});

describe("s05 tone: buckets", () => {
  test("rules put the fixture mail in its four kinds", () => {
    const counts: Record<string, number> = {};
    for (const m of SENT_MAIL) {
      const b = ruleBucket(cleanEmail(m));
      counts[b] = (counts[b] ?? 0) + 1;
    }
    expect(counts).toEqual({ investor_outreach: 18, scheduling: 12, follow_up: 6, other: 4 });
  });

  test("the model bucketer uses the cheap model and only accepts a known bucket", async () => {
    const stub = new StubModel({ bucket: (r) => (r.prompt.includes("Board pack") ? "nonsense" : "scheduling") });
    const b = modelBucketer(stub, DEFAULT_MODELS);
    expect(await b.bucket(cleanEmail(SENT_MAIL[0]!))).toBe("scheduling");
    expect(await b.bucket(cleanEmail(SENT_MAIL.find((m) => m.subject === "Board pack")!))).toBe("other"); // invalid -> rules
    expect(stub.calls.every((c) => c.model === "claude-sonnet-5-5" && c.role === "bucket")).toBe(true);
  });
});

describe("s05 tone: BM25", () => {
  test("tokenize lowercases, splits and drops stopwords", () => {
    expect(tokenize("Hi Anna, the Seed round!")).toEqual(["anna", "seed", "round"]);
  });

  test("ranks the closest document first and breaks ties by id", () => {
    const idx = new Bm25([
      { id: "a", text: "seed round accel partner" },
      { id: "b", text: "tuesday call works" },
      { id: "c", text: "seed round northzone" },
    ]);
    const hits = idx.search("accel seed", 3);
    expect(hits[0]?.id).toBe("a");
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
    const tie = new Bm25([{ id: "z", text: "xx yy" }, { id: "y", text: "xx yy" }]).search("xx", 2);
    expect(tie.map((h) => h.id)).toEqual(["y", "z"]);
  });

  test("a rare term outweighs a common one", () => {
    const idx = new Bm25([
      { id: "1", text: "call call call" },
      { id: "2", text: "call zoom" },
      { id: "3", text: "call" },
    ]);
    expect(idx.search("zoom call", 1)[0]?.id).toBe("2");
    expect(idx.search("", 3)).toEqual([]);
  });
});

describe("s05 tone: style card and pack", () => {
  test("measured style is computed in code", () => {
    const s = measureStyle(SENT_MAIL.slice(0, 18).map(cleanEmail));
    expect(s.emails).toBe(18);
    expect(s.topGreeting).toEqual({ form: "Hi {first},", count: 18 });
    expect(s.topSign).toEqual({ form: "Muhammad", count: 18 });
    expect(s.medianWords).toBeGreaterThan(25);
    expect(s.medianWords).toBeLessThan(70);
    expect(s.askShare).toBeGreaterThan(0.8);
    expect(s.exclamationShare).toBe(0);
  });

  test("build writes a card per bucket, an index and a local corpus; cards use the cheap model", async () => {
    const stub = new StubModel();
    const r = await buildTonePack({ home, source: new FixtureMailSource(), model: stub, models: DEFAULT_MODELS, now: () => 1 });
    expect(r.buckets.map((b) => b.bucket).sort()).toEqual(["follow_up", "investor_outreach", "other", "scheduling"]);
    const card = readFileSync(join(home, "tone", "investor_outreach.md"), "utf8");
    expect(card).toContain("bucket: investor_outreach");
    expect(card).toContain("## Measured");
    expect(card).toContain("## Voice");
    expect(card).toContain("Short and direct");
    expect(existsSync(join(home, "tone", "index.json"))).toBe(true);
    expect(loadTonePack(home, 1)?.corpus).toHaveLength(40);
    expect(stub.calls.some((c) => c.role === "draft")).toBe(false);
    expect(stub.calls.filter((c) => c.role === "style_card").every((c) => c.model === "claude-sonnet-5-5")).toBe(true);
  });

  test("a card the user edited is kept on rebuild unless forced", async () => {
    const opts = { home, source: new FixtureMailSource(), model: new StubModel(), models: DEFAULT_MODELS };
    await buildTonePack(opts);
    const path = join(home, "tone", "scheduling.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n- Always offer two times.\n");
    const again = await buildTonePack(opts);
    expect(again.buckets.find((b) => b.bucket === "scheduling")?.action).toBe("kept_edited");
    expect(readFileSync(path, "utf8")).toContain("Always offer two times.");
    const forced = await buildTonePack({ ...opts, force: true });
    expect(forced.buckets.find((b) => b.bucket === "scheduling")?.action).toBe("written");
    expect(readFileSync(path, "utf8")).not.toContain("Always offer two times.");
  });

  test("retrieval returns 3-5 examples of the bucket, closest first", async () => {
    await buildTonePack({ home, source: new FixtureMailSource(), model: new StubModel(), models: DEFAULT_MODELS });
    const pack = loadTonePack(home)!;
    const hits = retrieveExamples(pack, "Accel seed round partner", { bucket: "investor_outreach", k: 4 });
    expect(hits).toHaveLength(4);
    expect(hits[0]?.to).toEqual(["james.chen@accel.com"]);
    expect(hits.every((h) => h.bucket === "investor_outreach")).toBe(true);
    expect(retrieveExamples(pack, "x", { bucket: "investor_outreach", k: 10 })).toHaveLength(5);
    expect(retrieveExamples(pack, "zzzz unmatched", { bucket: "investor_outreach", k: 1 })).toHaveLength(3);
  });
});

describe("s05 tone: blind test", () => {
  test("holds back N emails, drafts them from the rest, and writes a shuffled A/B file with a separate key", async () => {
    const r = await runBlindTest({ home, emails: SENT_MAIL, holdBack: 6, model: new StubModel(), models: DEFAULT_MODELS, now: () => 1_700_000_000_000 });
    expect(r.items).toHaveLength(6);
    expect(new Set(r.items.map((i) => i.id)).size).toBe(6);
    for (const i of r.items) expect(r.trainedOn).not.toContain(i.id);
    const ab = readBlindFile(home, r.abFile, 1_700_000_000_000) ?? "";
    expect(ab).not.toMatch(/\b(real|draft|generated)\b/i);
    const key = JSON.parse(readBlindFile(home, r.keyFile, 1_700_000_000_000) ?? "[]") as Array<{ pair: number; real: "A" | "B" }>;
    expect(key).toHaveLength(6);
    expect(r.summary.signMatch).toBeGreaterThanOrEqual(0);
    expect(r.summary.signMatch).toBeLessThanOrEqual(1);
    const again = await runBlindTest({ home, emails: SENT_MAIL, holdBack: 6, model: new StubModel(), models: DEFAULT_MODELS, now: () => 1_700_000_000_001 });
    expect(again.items.map((i) => i.id)).toEqual(r.items.map((i) => i.id));
  });
});

describe("s05 tone: mail sources", () => {
  test("the fixture source returns the 40 sent emails, newest first, limited", async () => {
    const all = await new FixtureMailSource().listSent({ limit: 100 });
    expect(all).toHaveLength(40);
    expect(all[0]!.sentAt).toBeGreaterThanOrEqual(all[39]!.sentAt);
    expect(await new FixtureMailSource().listSent({ limit: 5 })).toHaveLength(5);
  });

  test("the MCP source calls the configured read tool and parses a Composio-style result", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const src = new McpMailSource({
      caller: {
        async callTool(name, args) {
          calls.push([name, args]);
          return { data: { messages: [{ messageId: "g1", subject: "Hi", to: "a@x.com", messageText: "Hi A,\n\nYes.\n\nMuhammad", messageTimestamp: "2026-10-01T09:00:00Z" }] } };
        },
      },
      tool: "GMAIL_FETCH_EMAILS",
      args: { query: "in:sent" },
    });
    const got = await src.listSent({ limit: 10 });
    expect(calls[0]?.[0]).toBe("GMAIL_FETCH_EMAILS");
    expect(calls[0]?.[1]).toMatchObject({ query: "in:sent", max_results: 10 });
    expect(got).toEqual([{ id: "g1", to: ["a@x.com"], subject: "Hi", body: "Hi A,\n\nYes.\n\nMuhammad", sentAt: Date.parse("2026-10-01T09:00:00Z") }]);
  });

  test("an MCP text-content result with JSON inside is parsed; junk is an error", () => {
    const r = parseMailToolResult({ content: [{ type: "text", text: JSON.stringify([{ id: "x", to: ["b@y.com"], subject: "S", body: "B", date: "2026-10-02T00:00:00Z" }]) }] });
    expect(r[0]).toMatchObject({ id: "x", to: ["b@y.com"], subject: "S", body: "B" });
    expect(() => parseMailToolResult({ nothing: true })).toThrow();
  });
});
