// s05c: GET/PUT /workflows/:id/tone — the style card of the workflow's tone bucket, editable from the review window.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ErrorResponse, ToneCardDTO } from "../../src/api/types.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { FixtureMailSource } from "../../src/tone/mail-source.ts";
import { buildTonePack, MAX_TONE_CARD_BYTES } from "../../src/tone/pack.ts";
import { NOW } from "../s05-workflows/setup.ts";
import { routeWorld, type RouteWorld } from "./setup.ts";

let w: RouteWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});
const path = (x: RouteWorld) => `/workflows/${x.outreach.id}/tone`;

describe("s05c tone card route", () => {
  test("TONE: GET returns the card of the workflow's bucket as built, not edited", async () => {
    w = await routeWorld();
    const r = await w.call<ToneCardDTO>(path(w));
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe("investor_outreach");
    expect(r.body.text).toBe(readFileSync(join(w.home, "tone", "investor_outreach.md"), "utf8"));
    expect(r.body.edited).toBe(false);
    expect(r.body.path).toBe(join(w.home, "tone", "investor_outreach.md"));
    expect(r.body.maxBytes).toBe(MAX_TONE_CARD_BYTES);
    expect(typeof r.body.updatedAt).toBe("number");
  });

  test("TONE: PUT stores the card (0600), GET shows it as edited, and a rebuild keeps it", async () => {
    w = await routeWorld();
    const text = "# Investor outreach\n- Short, warm, first name only.\n- Sign off with Best, Sam\n";
    const r = await w.call<ToneCardDTO>(path(w), { method: "PUT", body: { text } });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe(text);
    expect(r.body.edited).toBe(true);
    const file = join(w.home, "tone", "investor_outreach.md");
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await w.call<ToneCardDTO>(path(w))).body).toMatchObject({ text, edited: true });
    const rebuilt = await buildTonePack({ home: w.home, source: new FixtureMailSource(), model: new StubModel(), models: DEFAULT_MODELS, now: () => NOW });
    expect(rebuilt.buckets.find((b) => b.bucket === "investor_outreach")?.action).toBe("kept_edited");
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("TONE: PUT validates the body: text required, a string, not blank, no control characters, no other keys", async () => {
    w = await routeWorld();
    const before = readFileSync(join(w.home, "tone", "investor_outreach.md"), "utf8");
    for (const body of [{}, { text: 5 }, { text: "   \n" }, { text: "a\u0000b" }, { text: "ok", bucket: "other" }]) {
      const r = await w.call<ErrorResponse>(path(w), { method: "PUT", body });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_request");
    }
    expect(readFileSync(join(w.home, "tone", "investor_outreach.md"), "utf8")).toBe(before);
  });

  test("TONE: a card over maxBytes is refused with 413 and nothing is written", async () => {
    w = await routeWorld();
    const before = readFileSync(join(w.home, "tone", "investor_outreach.md"), "utf8");
    const r = await w.call<ErrorResponse>(path(w), { method: "PUT", body: { text: "é".repeat(MAX_TONE_CARD_BYTES / 2 + 1) } });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("payload_too_large");
    expect(readFileSync(join(w.home, "tone", "investor_outreach.md"), "utf8")).toBe(before);
  });

  test("TONE: without a tone pack GET says text null; a PUT creates the card and a later build keeps it", async () => {
    w = await routeWorld({ tone: false });
    const g = await w.call<ToneCardDTO>(path(w));
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ text: null, edited: false, updatedAt: null });
    const text = "# Mine\n- Two lines at most.\n";
    expect((await w.call<ToneCardDTO>(path(w), { method: "PUT", body: { text } })).status).toBe(200);
    const built = await buildTonePack({ home: w.home, source: new FixtureMailSource(), model: new StubModel(), models: DEFAULT_MODELS, now: () => NOW });
    expect(built.buckets.find((b) => b.bucket === "investor_outreach")?.action).toBe("kept_edited");
    expect(readFileSync(join(w.home, "tone", "investor_outreach.md"), "utf8")).toBe(text);
  });

  test("TONE: unknown workflow 404, POST 405, no token 401", async () => {
    w = await routeWorld();
    expect((await w.call<ErrorResponse>("/workflows/wf_nope1234/tone")).status).toBe(404);
    expect((await w.call<ErrorResponse>(path(w), { method: "POST", body: { text: "x" } })).status).toBe(405);
    expect((await w.call<ErrorResponse>(path(w), { token: "wrong" })).status).toBe(401);
    expect(existsSync(join(w.home, "workflows", "wf_nope1234"))).toBe(false);
  });
});
