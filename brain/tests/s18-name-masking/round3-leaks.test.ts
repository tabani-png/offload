// Review round 3: a table of leak cases run through the real router egress (ModelRouter.complete with a home that has a
// recipients.csv and a privacy.json), not only NameMap. Every case except the documented limit must reach the backend
// with no readable form of the name: the check folds case, drops zero-width characters, composes accents (NFC) and
// also tries the accent-free spelling. Each draft reply must also restore to exactly what was sent in.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { ModelRouter, RoutedModel, type Backend, type BackendReply, type BackendRequest } from "../../src/models/router.ts";
import { NameMap } from "../../src/privacy/names.ts";
import { draftInTone } from "../../src/tone/draft.ts";

class CaptureBackend implements Backend {
  readonly kind = "stub" as const;
  readonly metered = false;
  readonly calls: BackendRequest[] = [];
  constructor(private readonly answer: (r: BackendRequest) => string | Promise<string> = (r) => r.prompt) {}
  async complete(r: BackendRequest): Promise<BackendReply> {
    this.calls.push(r);
    return { text: await this.answer(r), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, model: r.model };
  }
}

const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A home with one contact in a workflow's recipients.csv and the user's own name in privacy.json. */
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "offload-s18r3-"));
  homes.push(h);
  mkdirSync(join(h, "workflows", "wf_r3leaks1"), { recursive: true });
  writeFileSync(join(h, "workflows", "wf_r3leaks1", "recipients.csv"), "email,first_name,last_name,org,notes\nzquellin@kestrel.io,Zorblax,Quéllin,Kestrel,\n");
  writeFileSync(join(h, "privacy.json"), JSON.stringify({ ownName: "Xantippe Dovrél" }));
  return h;
}

const ZW = /[​-‍⁠﻿­᠎]/g;
const fold = (s: string) => s.replace(ZW, "").normalize("NFC").toLowerCase();
const bare = (s: string) => fold(s).normalize("NFD").replace(/\p{M}/gu, "");
const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "u");

/** The forbidden forms of `names` readable in `sent`. `exact`: everyday words ("Will") are checked as written only. */
function leaks(sent: string, names: readonly string[], exact = false): string[] {
  if (exact) return names.filter((n) => word(n).test(sent.replace(ZW, "").normalize("NFC")));
  return names.filter((n) => word(fold(n)).test(fold(sent)) || word(bare(n)).test(bare(sent)));
}

const CONTACT = ["Zorblax", "Quéllin", "zquellin"];
const SELF = ["Xantippe", "Dovrél"];

interface Case {
  group: string;
  name: string;
  text: string;
  forbidden: readonly string[];
  exact?: boolean;
}

const forms = (group: string, first: string, last: string, email: string, forbidden: readonly string[]): Case[] => {
  const nfd = (s: string) => s.normalize("NFD");
  const zw = (s: string) => `${s.slice(0, 3)}​${s.slice(3, 5)}‍${s.slice(5)}`;
  return [
    { group, name: "full name", text: `Please ask ${first} ${last} about the deck.`, forbidden },
    { group, name: "first only", text: `Ask ${first} about it`, forbidden },
    { group, name: "last only", text: `the ${last} account is late`, forbidden },
    { group, name: "ALL CAPS", text: `CALL ${first.toUpperCase()} ${last.toUpperCase()} TODAY. ${first.toUpperCase()} AGREED.`, forbidden },
    { group, name: "lowercase", text: `ping ${first.toLowerCase()} re the deck, ${last.toLowerCase()} too`, forbidden },
    { group, name: "possessive '", text: `${first}'s notes and ${last}'s`, forbidden },
    { group, name: "possessive ’", text: `${first}’s notes and ${last}’s`, forbidden },
    { group, name: "inside an email", text: `cc ${email} and ${first.toLowerCase()}@gmail.com`, forbidden },
    { group, name: "JSON fields", text: JSON.stringify({ firstName: first.toLowerCase(), lastName: last.toLowerCase(), name: `${first} ${last}` }), forbidden },
    { group, name: "brackets [] {} ()", text: `[${first}] {${last}} (${first.toLowerCase()} ${last.toLowerCase()})`, forbidden },
    { group, name: "zero-width characters", text: `Ask ${zw(first)} ${zw(last)} and ${zw(first)}`, forbidden },
    { group, name: "NFD-decomposed", text: `Ask ${nfd(first)} ${nfd(last)} and ${nfd(last)}`, forbidden },
  ];
};

const CASES: Case[] = [
  ...forms("known contact", "Zorblax", "Quéllin", "zquellin@kestrel.io", CONTACT),
  ...forms("self name", "Xantippe", "Dovrél", "xantippe.dovrel@offload.ai", SELF),
  { group: "greeting cue", name: "Dear Will", text: "Dear Will,\nthe deck is attached.", forbidden: ["Will"], exact: true },
  { group: "greeting cue", name: "Hi May", text: "Hi May,\nthe deck is attached.", forbidden: ["May"], exact: true },
  { group: "greeting cue", name: "Thanks Bill", text: "Thanks Bill, the deck is attached.", forbidden: ["Bill"], exact: true },
];

/** Documented limit (names.ts header): an unknown name with no cue, no contact entry and no earlier sighting. */
const LIMIT: Case = { group: "documented limit", name: "cue-less unknown name", text: "Grimwald Pettigrew sent the file.", forbidden: ["Grimwald", "Pettigrew"] };

const results: string[] = [];

async function egress(c: Case): Promise<{ sent: string; out: string; leaked: string[] }> {
  const b = new CaptureBackend();
  const r = new ModelRouter({ home: home(), backend: b, monthlyBudgetUsd: null });
  const out = await r.complete({ role: "draft", model: "m", system: `Context: ${c.text}`, prompt: c.text });
  const sent = b.calls.map((x) => `${x.system}\n${x.prompt}`).join("\n");
  return { sent, out, leaked: leaks(sent, c.forbidden, c.exact) };
}

describe("s18 round 3: leak table through the real router egress", () => {
  for (const c of CASES) {
    test(`EGRESS: ${c.group} / ${c.name} reaches the backend masked and restores exactly`, async () => {
      const { sent, out, leaked } = await egress(c);
      results.push(`| ${c.group} | ${c.name} | ${leaked.length === 0 ? "masked" : `LEAK: ${leaked.join(", ")}`} | ${out === c.text ? "exact" : "DIFFERS"} |`);
      expect({ leaked, sent: leaked.length === 0 ? "" : sent }).toEqual({ leaked: [], sent: "" });
      expect(out).toBe(c.text);
    });
  }

  test("HELDOUT: documented limit, a cue-less unknown name, is reported as reaching the backend (not hidden)", async () => {
    const { leaked } = await egress(LIMIT);
    results.push(`| ${LIMIT.group} | ${LIMIT.name} | reaches backend (documented): ${leaked.join(", ")} | n/a |`);
    expect(leaked).toEqual(["Grimwald", "Pettigrew"]);
  });

  test("EGRESS: the real drafting path (draftInTone) masks a contact given as lowercase recipient JSON", async () => {
    const b = new CaptureBackend((req) => new StubModel().complete({ role: req.role, model: req.model, system: req.system, prompt: req.prompt }));
    const model = new RoutedModel(new ModelRouter({ home: home(), backend: b, monthlyBudgetUsd: null }));
    const d = await draftInTone({ pack: { corpus: [], cards: {} }, bucket: "investor_outreach", recipient: { email: "zquellin@kestrel.io", firstName: "zorblax", lastName: "quéllin", org: "Kestrel" }, subject: "Offload <> Kestrel", facts: "sign: Xantippe\npitch: Offload automates repeat work", model, models: DEFAULT_MODELS });
    const sent = b.calls.map((x) => `${x.system}\n${x.prompt}`).join("\n");
    const leaked = leaks(sent, [...CONTACT, ...SELF]);
    results.push(`| real drafting path | draftInTone, lowercase recipient JSON | ${leaked.length === 0 ? "masked" : `LEAK: ${leaked.join(", ")}`} | ${d.body.includes("zorblax") || d.body.includes("Zorblax") ? "name restored" : "no name"} |`);
    expect(leaked).toEqual([]);
  });

  test("DETECT: a known contact's first name alone is masked by NameMap (Codex P1 repro)", () => {
    expect(new NameMap({ known: ["Zorblax Quux"] }).mask("Ask Zorblax about it")).not.toContain("Zorblax");
    expect(new NameMap({ known: ["Zorblax Quux"] }).mask("the quux file")).not.toContain("quux");
  });

  afterAll(() => {
    console.log(["", "| group | case | egress | round trip |", "|---|---|---|---|", ...results].join("\n"));
  });
});
