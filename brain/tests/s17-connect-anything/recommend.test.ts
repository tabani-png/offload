// s17 RECOMMEND + RESOLVE: universe tools in the s14 tool recommendations (always after the hand-verified catalog
// candidates), the generic commit preview of a dry run, and `tk-<toolkit>` targets in the s13 chain.
import { describe, expect, test } from "bun:test";
import type { OutputDTO, PlanVariantDTO } from "../../src/api/s14-types.ts";
import { chainDeps, chainOrder, ChainResolver, knownTarget } from "../../src/connectors/chain.ts";
import { ComposioProbe } from "../../src/connectors/composio.ts";
import { resolutionMethods } from "../../src/connectors/link.ts";
import { GENERIC_COMMIT, GENERIC_READ, isUniverseId, universeTargetId } from "../../src/connectors/targets.ts";
import { fetchSchema, readUniverse } from "../../src/connectors/universe.ts";
import { commitFor } from "../../src/plan/commit-fields.ts";
import { optionsFor, recommendTools } from "../../src/plan/tools.ts";
import { genericPreview } from "../../src/workflows/generic.ts";
import { LINEAR_RECORD, NOW, STRIPE_RECORD, syncedHome, universeCli } from "./setup.ts";

const ours = (fields: Array<[string, string | null]>, text: string | null = null): OutputDTO => ({ kind: "record", summary: "s", fields: fields.map(([label, value]) => ({ label, value })), text, actions: [] }) as unknown as OutputDTO;

function variant(target: string, targetName: string, family: "ticket" | "unknown"): PlanVariantDTO {
  return {
    id: "a",
    label: "A",
    summary: "",
    steps: [
      { id: "s1", type: "read", title: "Read", detail: "", capability: { need: "read the ticket", target, targetName, capability: "screen.read", role: "read", via: "computer_use" }, gated: false, when: null, writesText: false, sourceSteps: [] },
      { id: "s2", type: "commit", title: family === "ticket" ? "Reply" : "Save", detail: "", capability: { need: "save it", target, targetName, capability: "ui.commit", role: "send", via: "computer_use" }, gated: true, when: null, writesText: false, sourceSteps: [] },
    ],
  } as unknown as PlanVariantDTO;
}

describe("s17 recommend", () => {
  test("RECOMMEND: universe tools come after every catalog candidate and never above a verified tool", async () => {
    const { index } = await syncedHome();
    const { options } = optionsFor("ticket.reply", "Zendesk", new Set(), 10, { universe: index });
    const ids = options.map((o) => o.id);
    expect(ids.slice(0, 2)).toEqual(["zendesk", "intercom"]);
    const u = options.findIndex((o) => o.id.startsWith("composio:"));
    expect(u).toBeGreaterThanOrEqual(2);
    expect(options[u]).toMatchObject({ id: "composio:FRESHDESK_CREATE_TICKET", via: "composio", connectorId: "tk-freshdesk", verified: false });
    expect(options.length).toBeLessThanOrEqual(3);
    for (const o of options.slice(0, u)) expect(o.verified).not.toBe(false);
  });

  test("RECOMMEND: without an index the options are exactly the s14 ones (on-screen last resort kept)", () => {
    const a = optionsFor("ticket.reply", "Zendesk", new Set(), 10);
    expect(a.options.map((o) => o.id)).toEqual(["zendesk", "intercom", "screen:zendesk"]);
  });

  test("RECOMMEND: a universe option is never the default pick over a verified one, even when it is connected", async () => {
    const { index } = await syncedHome();
    const r = optionsFor("ticket.reply", "Zendesk", new Set(["tk-freshdesk"]), 10, { universe: index });
    expect(r.chosen).toBe("zendesk");
  });

  test("RECOMMEND: an unconnected universe option says it needs a one-time setup in plain words", async () => {
    const { index } = await syncedHome();
    const o = optionsFor("ticket.reply", "Zendesk", new Set(), 10, { universe: index }).options.find((x) => x.id.startsWith("composio:"))!;
    expect(o.needsYou).toMatch(/Set up Freshdesk once in Connections/);
    expect(o.needsYou).not.toMatch(/key|token|mcp|gate|json|env/i);
  });

  test("RECOMMEND: a commit step in an app the catalog does not know gets that app's universe tool", async () => {
    const { index } = await syncedHome();
    const tools = recommendTools({ plan: { outputType: "record", variant: variant("app-linear", "Linear", "unknown") }, perDay: 5, connected: new Set(), universe: index });
    const step = tools.find((t) => t.stepId === "s2")!;
    expect(step).toBeDefined();
    expect(step.options[0]!.id).toBe("composio:LINEAR_CREATE_LINEAR_ISSUE");
    expect(step.options.some((o) => o.via === "computer")).toBe(true);
  });

  test("RECOMMEND: without an index a step in an unknown app gets no universe step (s14 unchanged)", () => {
    const tools = recommendTools({ plan: { outputType: "record", variant: variant("app-linear", "Linear", "unknown") }, perDay: 5, connected: new Set() });
    expect(tools.find((t) => t.stepId === "s2")).toBeUndefined();
  });

  test("RECOMMEND: denied and read-only tools are never recommended for a commit", async () => {
    const { index } = await syncedHome();
    const tools = recommendTools({ plan: { outputType: "record", variant: variant("app-gmail-ish", "Gmail", "unknown") }, perDay: 5, connected: new Set(), universe: index });
    for (const t of tools) for (const o of t.options) expect(["GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"].map((s) => `composio:${s}`)).not.toContain(o.id);
  });

  test("RECOMMEND: the dry run's generic preview maps output fields to schema properties and lists missing required ones", () => {
    const p = genericPreview(LINEAR_RECORD, ours([["Title", "Refund for order 1042"], ["Priority", "2"], ["Customer", "Ana"]], "Customer asked for a refund."));
    expect(p.args).toEqual({ title: "Refund for order 1042", priority: 2, description: "Customer asked for a refund." });
    expect(p.missing).toEqual(["team_id"]);
    expect(p.fields).toEqual([["description", "Customer asked for a refund."], ["priority", "2"], ["title", "Refund for order 1042"]]);
    const s = genericPreview(STRIPE_RECORD, ours([["Amount", "42.00"], ["Charge", "ch_1"]]));
    // "42.00" is not a whole number of the smallest currency unit: it is left for the person, never guessed.
    expect(s.args).toEqual({ charge: "ch_1" });
    expect(s.missing).toEqual([]);
  });

  test("RECOMMEND: commitFor with a universe tool gives the generic preview, its verb and the review rows", () => {
    const spec = commitFor("composio:LINEAR_CREATE_LINEAR_ISSUE", "save", ours([["Title", "Bug"]], "Steps"), { bySteps: new Map() } as never, (slug) => (slug === "LINEAR_CREATE_LINEAR_ISSUE" ? LINEAR_RECORD : null));
    expect(spec.tool).toBe("composio:LINEAR_CREATE_LINEAR_ISSUE");
    expect(spec.verb).toBe("composio:LINEAR_CREATE_LINEAR_ISSUE");
    expect(spec.missing).toEqual(["team_id"]);
    expect(spec.review!.rows.map((r) => r.path)).toEqual(["description", "title"]);
    const none = commitFor("composio:NOPE_TOOL", "save", ours([["Title", "Bug"]]), { bySteps: new Map() } as never, () => null);
    expect(none.missing).toEqual(["the tool's fields (not fetched yet)"]);
  });
});

describe("s17 resolve", () => {
  test("RESOLVE: tk-<toolkit> ids resolve through the index for every toolkit (catalog ones too), never for the meta toolkit", async () => {
    const { home } = await syncedHome();
    expect(isUniverseId("tk-linear")).toBe(true);
    expect(isUniverseId("linear")).toBe(false);
    expect(universeTargetId("linear")).toBe("tk-linear");
    const t = knownTarget(home, "tk-linear", NOW)!;
    expect(t).toMatchObject({ id: "tk-linear", name: "Linear", catalog: false, toolkit: "linear", reads: [GENERIC_READ], sends: [GENERIC_COMMIT], logs: [] });
    expect(knownTarget(home, "tk-notion", NOW)!.toolkit).toBe("notion");
    expect(knownTarget(home, "tk-composio", NOW)).toBeNull();
    expect(knownTarget(home, "tk-unknownapp", NOW)).toBeNull();
  });

  test("RESOLVE: a universe target is tried through Composio, then a direct connection, then the screen", async () => {
    const { home } = await syncedHome();
    const t = knownTarget(home, "tk-linear", NOW)!;
    expect(chainOrder(t, home)).toEqual(["composio", "api", "computer"]);
    expect(resolutionMethods("tk-linear", null)).toEqual(["composio", "api", "computer"]);
  });

  test("RESOLVE: the Composio probe gives a signed-in universe target the generic read and commit capabilities", async () => {
    const { home, runner } = await syncedHome();
    const deps = chainDeps({ home, env: {}, now: () => NOW, simulated: false, runner });
    const r = await new ComposioProbe().probe(knownTarget(home, "tk-linear", NOW)!, deps);
    expect(r.health).toBe("ok");
    expect(r.reads).toEqual([GENERIC_READ]);
    expect(r.writes).toEqual([GENERIC_COMMIT]);
    expect(r.info).toMatchObject({ toolkit: "linear", account: "linear_live-one" });
    // The index answers the tool list: no `tools list` call for a universe target.
    expect(runner.calls.filter((c) => c.argv[1] === "tools").length).toBe(Object.keys(readUniverse(home)!.toolkits).length);
  });

  test("RESOLVE: an account that asks before every call is used for reads only", async () => {
    const { home } = await syncedHome();
    const runner = universeCli({ askEveryCall: true });
    const r = await new ComposioProbe().probe(knownTarget(home, "tk-linear", NOW)!, chainDeps({ home, env: {}, now: () => NOW, simulated: false, runner }));
    expect(r.health).toBe("ok");
    expect(r.code).toBe("reads_only");
    expect(r.writes).toEqual([]);
  });

  test("RESOLVE: not signed in to Composio yet is skipped with plain words", async () => {
    const { home } = await syncedHome();
    const runner = universeCli({ over: { "connections list": { code: 0, stdout: "{}", stderr: "", timedOut: false } } });
    const r = await new ComposioProbe().probe(knownTarget(home, "tk-linear", NOW)!, chainDeps({ home, env: {}, now: () => NOW, simulated: false, runner }));
    expect(r.health).toBe("skipped");
    expect(r.code).toBe("not_signed_in");
    expect(r.reason).toBe("Linear is not signed in to Composio yet.");
  });

  test("RESOLVE: the chain plans the composio method for a universe commit", async () => {
    const { home, runner } = await syncedHome();
    const resolver = new ChainResolver(chainDeps({ home, env: {}, now: () => NOW, simulated: false, runner, fetch: async () => new Response("{}") }));
    const plan = await resolver.plan(knownTarget(home, "tk-linear", NOW)!, [GENERIC_COMMIT]);
    expect(plan.map((m) => m.method)).toEqual(["composio"]);
  });

  test("RESOLVE: catalog and app targets keep their s13 capabilities", async () => {
    const { home } = await syncedHome();
    expect(knownTarget(home, "gmail", NOW)!.sends).toEqual(["mail.send"]);
    expect(knownTarget(home, "slack", NOW)!.sends).toEqual(["chat.post"]);
  });

  test("RESOLVE: the stub model's demo probe answers a universe target without spawning", async () => {
    const { home } = await syncedHome();
    const runner = universeCli();
    const resolver = new ChainResolver(chainDeps({ home, env: {}, now: () => NOW, simulated: true, runner }));
    const d = await resolver.resolve(knownTarget(home, "tk-linear", NOW)!);
    expect(d.methods.map((m) => m.method)).toEqual(["composio", "api", "computer"]);
    expect(runner.calls.length).toBe(0);
    void fetchSchema;
  });
});
