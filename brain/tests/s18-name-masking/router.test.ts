// ROUTER, SELF: the model router masks every request before any backend sees it and handles the reply on the Mac:
// drafts the user reviews are restored, stored outputs keep <name>. The user's own name is masked by default.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, StubModel, type ModelRole } from "../../src/models/model.ts";
import { ModelRouter, RESTORE_ROLES, RoutedModel, type Backend, type BackendReply, type BackendRequest } from "../../src/models/router.ts";
import { draftTextStep } from "../../src/plan/text-step.ts";
import { NameMap } from "../../src/privacy/names.ts";
import { readNamePolicy, signNames } from "../../src/privacy/policy.ts";
import { draftInTone } from "../../src/tone/draft.ts";
import { readableNames } from "./names.ts";

const homes: string[] = [];
const tmp = () => {
  const h = mkdtempSync(join(tmpdir(), "offload-s18r-"));
  homes.push(h);
  return h;
};
process.on("exit", () => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** Records every request; answers with `answer(req)` (default: echoes the user turn). */
export class CaptureBackend implements Backend {
  readonly kind = "stub" as const;
  readonly metered = false;
  readonly calls: BackendRequest[] = [];
  constructor(private readonly answer: (r: BackendRequest) => string | Promise<string> = (r) => r.prompt) {}
  async complete(r: BackendRequest): Promise<BackendReply> {
    this.calls.push(r);
    return { text: await this.answer(r), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, model: r.model };
  }
}

const ROLES: ModelRole[] = ["draft", "bucket", "style_card", "workflow_design", "step", "label", "refine", "explain"];
const TEXT = "Hi Amara Okafor,\nIvan Petrov (ivan.petrov@bluefin.io) asked about the Product Designer role.\nBest,\nKeiko";
const router = (backend: Backend, home = tmp()) => new ModelRouter({ home, backend, monthlyBudgetUsd: null });

describe("s18 router", () => {
  test("ROUTER: every route's backend request (system and user turn) is masked", async () => {
    const b = new CaptureBackend();
    const r = router(b);
    for (const role of ROLES) await r.complete({ role, model: "m", system: `Write for Amara Okafor. ${role}`, prompt: TEXT });
    expect(b.calls.length).toBe(ROLES.length);
    for (const c of b.calls) {
      expect(readableNames(`${c.system}\n${c.prompt}`, ["Amara", "Okafor", "Ivan", "Petrov", "Keiko", "ivan.petrov"])).toEqual([]);
      expect(c.prompt).toContain("Product Designer");
      expect(c.prompt).toContain("bluefin.io");
    }
    expect(new Set(b.calls.map((c) => c.route))).toEqual(new Set(["draft", "classify", "design", "item_step", "understand", "refine", "explain"]));
  });

  test("ROUTER: replies the user reviews (draft, step, style card, explain) come back with the real names", async () => {
    const r = router(new CaptureBackend());
    for (const role of ROLES.filter((x) => RESTORE_ROLES.has(x))) expect(await r.complete({ role, model: "m", system: "", prompt: TEXT })).toBe(TEXT);
  });

  test("ROUTER: stored outputs (label, refine, design, bucket) keep <name>, never a placeholder or a real name", async () => {
    const r = router(new CaptureBackend());
    for (const role of ROLES.filter((x) => !RESTORE_ROLES.has(x))) {
      const out = await r.complete({ role, model: "m", system: "", prompt: TEXT });
      expect(out).toBe("Hi <name>,\n<name> (<name>@bluefin.io) asked about the Product Designer role.\nBest,\n<name>");
    }
  });

  test("ROUTER: the validate check sees the restored text, so a placeholder's digits never escalate a draft", async () => {
    const b = new CaptureBackend();
    const r = router(b);
    const seen: string[] = [];
    await r.complete({ role: "step", model: "m", system: "", prompt: "Hi Keiko, order shipped.", validate: (t) => (seen.push(t), /\d/.test(t) ? "digit" : null) });
    expect(seen).toEqual(["Hi Keiko, order shipped."]);
    expect(b.calls.length).toBe(1);
  });

  test("ROUTER: one run map keeps the same placeholder for the same person across calls", async () => {
    const b = new CaptureBackend();
    const r = router(b);
    const names = new NameMap();
    await r.complete({ role: "step", model: "m", system: "", prompt: "Ticket from Rosa Silva", names });
    await r.complete({ role: "step", model: "m", system: "", prompt: "Hi Jonas, Rosa Silva again", names });
    expect(b.calls.map((c) => c.prompt)).toEqual(["Ticket from <person:1>", "Hi <person:2>, <person:1> again"]);
  });

  test("ROUTER: a text step's source goes out masked and the draft comes back real; an invented name is reported", async () => {
    const b = new CaptureBackend((req) => (req.prompt.includes("<person:1>") ? "Hi <person:1>,\nThanks. <person:9> will follow up.\nThe team" : "x"));
    const model = new RoutedModel(router(b));
    const d = await draftTextStep({ what: "reply", source: "Customer: Rosa Silva\nMy order has not arrived", pack: null, model, models: DEFAULT_MODELS });
    expect(b.calls[0]!.prompt).not.toMatch(/Rosa|Silva/);
    expect(d.text).toBe("Hi Rosa Silva,\nThanks. <person:9> will follow up.\nThe team");
    expect(d.warnings).toContain("a name Offload could not fill in: check the names before you approve");
  });

  test("ROUTER: an email draft through the router names the recipient in the reviewed text and nowhere in the request", async () => {
    const b = new CaptureBackend((req) => new StubModel().complete({ role: req.role, model: req.model, system: req.system, prompt: req.prompt }));
    const model = new RoutedModel(router(b));
    const d = await draftInTone({ pack: { corpus: [], cards: {} }, bucket: "investor_outreach", recipient: { email: "anna.berg@northzone.com", firstName: "Anna", lastName: "Berg", org: "Northzone" }, subject: "Offload <> Northzone", facts: "sign: Muhammad\npitch: Offload automates repeat work", model, models: DEFAULT_MODELS });
    expect(d.body.startsWith("Hi Anna,")).toBe(true);
    expect(d.body.trimEnd().endsWith("Muhammad")).toBe(true);
    expect(readableNames(b.calls[0]!.prompt, ["Anna", "Berg", "Muhammad", "anna.berg"])).toEqual([]);
    expect(d.warnings.filter((w) => w.includes("could not fill in"))).toEqual([]);
  });

  test("ROUTER: contacts in a workflow's recipient list are masked in any case, even with no cue", async () => {
    const home = tmp();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "workflows", "wf_abcd1234"), { recursive: true });
    writeFileSync(join(home, "workflows", "wf_abcd1234", "recipients.csv"), "email,first_name,last_name,org,notes\nx@quist.vc,Bartholomew,Quist,Quist VC,\n");
    const b = new CaptureBackend();
    await router(b, home).complete({ role: "label", model: "m", system: "", prompt: "profile: bartholomew quist deck review" });
    expect(b.calls[0]!.prompt).toBe("profile: <person:1> deck review");
  });
});

describe("s18 the user's own name", () => {
  test("SELF: the own name in privacy.json is sent as <person:me> by default and restored in the draft", async () => {
    const home = tmp();
    writeFileSync(join(home, "privacy.json"), JSON.stringify({ ownName: "Jo Park" }));
    const b = new CaptureBackend();
    const out = await router(b, home).complete({ role: "draft", model: "m", system: "", prompt: "Thanks,\nJo Park\nJo" });
    expect(b.calls[0]!.prompt).toBe("Thanks,\n<person:me>\n<person:me.first>");
    expect(out).toBe("Thanks,\nJo Park\nJo");
  });

  test("SELF: ownNameToClaude \"keep\" sends the own name as written; other people stay masked", async () => {
    const home = tmp();
    writeFileSync(join(home, "privacy.json"), JSON.stringify({ ownName: "Jo Park", ownNameToClaude: "keep" }));
    const b = new CaptureBackend();
    await router(b, home).complete({ role: "draft", model: "m", system: "", prompt: "Hi Keiko,\nThanks,\nJo Park" });
    expect(b.calls[0]!.prompt).toBe("Hi <person:1>,\nThanks,\nJo Park");
  });

  test("SELF: a broken privacy.json masks (the safe default)", () => {
    const home = tmp();
    writeFileSync(join(home, "privacy.json"), "{not json");
    expect(readNamePolicy(home)).toMatchObject({ keepSelf: false, self: [] });
  });

  test("SELF: the facts.md sign line counts as the user's own name for that workflow's runs", () => {
    expect(signNames("company: Offload\nsign: Muhammad\n")).toEqual(["Muhammad"]);
    const m = new NameMap(readNamePolicy(tmp(), signNames("sign: Muhammad")));
    expect(m.mask("I'm Muhammad, founder of Offload.")).toBe("I'm <person:me>, founder of Offload.");
  });
});
