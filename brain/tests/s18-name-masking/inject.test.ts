// INJECT (review wave B, PR #7 item 1): placeholder-shaped text that arrives in the input (a recipient's notes cell, an
// inbound message) can never be restored to a real name: each run's placeholders carry a random tag, and anything else
// shaped like a placeholder becomes <name> before it is masked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskText } from "../../src/grouping/normalize.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { ModelRouter, RoutedModel } from "../../src/models/router.ts";
import { NameMap } from "../../src/privacy/names.ts";
import { draftInTone } from "../../src/tone/draft.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { approveBatch, prepareLiveBatch } from "../../src/workflows/runner.ts";
import { tempHome } from "../helpers.ts";
import { NOW, world, writeRecipients, type World } from "../s05-workflows/setup.ts";
import { ECHO, echoLine, EchoNotesBackend, UNFILLED } from "./echo.ts";

describe("s18 placeholder injection", () => {
  test("INJECT: a placeholder already in the input is neutralised, so unmask never turns it into a known name", () => {
    const m = new NameMap({ self: ["Muhammad Ali"] });
    const a = m.mask("Hi Anna Berg, thanks. Muhammad");
    expect(m.unmask(a)).toBe("Hi Anna Berg, thanks. Muhammad");
    // Every placeholder shape the map could have written, typed into a later input.
    const injected = "notes: <person:1> <person:1.first> <person:2> <person:me> <person:me.first> <person:1~2>";
    const out = m.mask(injected);
    // The model echoes what it saw: nothing in it may restore to Anna or to the user's own name.
    const back = m.unmask(out);
    expect(back).not.toMatch(/Anna|Berg|Muhammad|Ali/);
    expect(back).toBe("notes: <name> <name> <name> <name> <name> <name>");
  });

  test("INJECT: a placeholder the map wrote cannot be guessed from the input (each run has its own)", () => {
    const a = new NameMap();
    const b = new NameMap();
    const pa = a.mask("Hi Anna Berg");
    const pb = b.mask("Hi Anna Berg");
    expect(pa).not.toBe(pb);
    // b's placeholder typed into a's input is foreign to a.
    expect(a.unmask(a.mask(pb))).not.toContain("Anna");
    // A map's own placeholders stay as they are when masked again (idempotent).
    expect(a.mask(pa)).toBe(pa);
    expect(a.unmask(a.mask(pa))).toBe("Hi Anna Berg");
  });

  test("INJECT: maskText then names (the text-step and note path) neutralises an injected placeholder too", () => {
    const m = new NameMap();
    m.mask("Hi Anna Berg");
    expect(m.unmask(m.mask(maskText("ticket from <person:1>")))).not.toContain("Anna");
  });

  test("INJECT: recipient B's notes carry <person:N>; the model echoes them; B's draft never names recipient A", async () => {
    const home = tempHome();
    try {
      writeFileSync(join(home.home, "privacy.json"), JSON.stringify({ ownName: "Muhammad Ali" }));
      const backend = new EchoNotesBackend();
      const model = new RoutedModel(new ModelRouter({ home: home.home, backend, monthlyBudgetUsd: null }));
      const names = new NameMap({ self: ["Muhammad Ali"] });
      const pack = { corpus: [], cards: {} };
      const a = await draftInTone({ pack, bucket: "investor_outreach", recipient: { email: "anna@northzone.com", firstName: "Anna", lastName: "Berg", org: "Northzone", notes: "" }, subject: "Hello", facts: "company: Offload", model, models: DEFAULT_MODELS, names });
      expect(a.body).toContain("Anna");
      const notes = "met via <person:1>, <person:2>, <person:3> and <person:me>";
      const b = await draftInTone({ pack, bucket: "investor_outreach", recipient: { email: "tom@seedcamp.com", firstName: "Tom", lastName: "Reid", org: "Seedcamp", notes }, subject: "Hello", facts: "company: Offload", model, models: DEFAULT_MODELS, names });
      const echoed = echoLine(b.body);
      expect(echoed).not.toBe("");
      expect(echoed).not.toMatch(/Anna|Berg|Muhammad|Ali/);
      // The backend never saw a placeholder that could restore to a real name.
      for (const c of backend.calls.filter((x) => x.role === "draft")) expect(names.unmask(/"notes":"([^"]*)"/.exec(c.prompt)?.[1] ?? "")).not.toMatch(/Anna|Berg|Muhammad/);
      // What came back unfilled is reported on the draft.
      expect(b.warnings).toContain(UNFILLED);
    } finally {
      home.cleanup();
    }
  });
});

describe("s18 live run: an injected placeholder", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.cleanup());

  test("INJECT: a live run with a placeholder in one recipient's notes never puts another recipient's name in it", async () => {
    writeRecipients(w.home, w.outreach.id, ["anna@northzone.com,Anna,Berg,Northzone,", "tom@seedcamp.com,Tom,Reid,Seedcamp,met via <person:1> <person:2> <person:3> <person:me>"]);
    const model = new RoutedModel(new ModelRouter({ home: w.home, backend: new EchoNotesBackend(), monthlyBudgetUsd: null }));
    const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model, limit: 1, now: () => NOW });
    approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 1);
    const live = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model, now: () => NOW + 10 });
    const tom = live.items.find((i) => i.to === "tom@seedcamp.com")!;
    expect(tom.body.startsWith(ECHO)).toBe(true);
    expect(echoLine(tom.body)).not.toMatch(/Anna|Berg|Muhammad/);
    expect(tom.warnings).toContain(UNFILLED);
  }, 120_000);
});

