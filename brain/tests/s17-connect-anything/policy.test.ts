// s17 POLICY + REVIEW + EXEC: the generic exact-approval policy for any Composio commit tool without a hand-written
// s16 policy, the field-by-field review of what is approved, and the Composio CLI executor path for generic items.
import { describe, expect, test } from "bun:test";
import { chainDeps, ChainResolver } from "../../src/connectors/chain.ts";
import { ComposioCliExecutor } from "../../src/connectors/composio.ts";
import { schemaRecord, type SchemaRecord } from "../../src/connectors/universe.ts";
import { policyFor, TOOL_POLICIES } from "../../src/workflows/allowlist.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import { buildChain } from "../../src/workflows/chain-executor.ts";
import { canonicalGenericArgs, genericCommit, genericPolicy, genericReview, genericReviewOfItem, genericVerb, isGenericVerb, parseGenericCommit } from "../../src/workflows/generic.ts";
import { CLI, fail, genericGate, genericItem, ISSUE_ARGS, LINEAR_RECORD, NOW, ok, REFUND_ARGS, STRIPE_RECORD, syncedHome, tool, TOKEN, universeCli } from "./setup.ts";

const ISSUE = "LINEAR_CREATE_LINEAR_ISSUE";
const REFUND = "STRIPE_CREATE_REFUND";

/** Every leaf path of a plain JSON value, with a changed copy of the value at that path. */
function tampered(args: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  const walk = (v: unknown, path: Array<string | number>) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    else {
      const copy = structuredClone(args) as Record<string, unknown>;
      let o: Record<string | number, unknown> = copy as Record<string | number, unknown>;
      for (const p of path.slice(0, -1)) o = o[p] as Record<string | number, unknown>;
      const last = path.at(-1)!;
      o[last] = typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : `${String(v)}x`;
      out.push([path.join("."), copy]);
    }
  };
  walk(args, []);
  return out;
}

const NESTED_SCHEMA = schemaRecord("ACME_CREATE_CONTACT", { type: "object", properties: { name: { type: "string" }, contact: { type: "object", properties: { email: { type: "string" }, phone: { type: "string" } }, required: ["email"] } }, required: ["name"] }, NOW, "1");

describe("s17 generic policy", () => {
  test("POLICY: the exact approved arguments are allowed once; the same call again is denied", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const a = gate.check(tool(ISSUE), structuredClone(ISSUE_ARGS));
    expect(a.decision.allow).toBe(true);
    expect(a.decision.role).toBe("send");
    expect(a.decision.itemKey).toBe("issue-1");
    const b = gate.check(tool(ISSUE), structuredClone(ISSUE_ARGS));
    expect(b.decision.allow).toBe(false);
    expect(b.decision.reason).toMatch(/already done/);
  });

  test("POLICY: every changed leaf of the arguments is denied (tamper)", () => {
    const cases = tampered(ISSUE_ARGS);
    expect(cases.length).toBe(6);
    for (const [path, args] of cases) {
      const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
      const d = gate.check(tool(ISSUE), args).decision;
      expect({ path, allow: d.allow }).toEqual({ path, allow: false });
    }
  });

  test("POLICY: a dropped optional argument or a reordered list is a different call (denied)", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const { priority: _p, ...rest } = ISSUE_ARGS;
    expect(gate.check(tool(ISSUE), rest).decision.allow).toBe(false);
    expect(gate.check(tool(ISSUE), { ...ISSUE_ARGS, label_ids: ["l-2", "l-1"] }).decision.allow).toBe(false);
  });

  test("POLICY: key order, NFC and CRLF do not change the canonical arguments", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const reordered = { label_ids: ["l-1", "l-2"], priority: 2, description: "Customer asked for a refund.\nSee ticket.", title: "Refund for order 1042", team_id: ISSUE_ARGS.team_id };
    expect(gate.check(tool(ISSUE), reordered).decision.allow).toBe(true);
  });

  test("POLICY: an unknown or extra top-level argument is denied, by name", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const d = gate.check(tool(ISSUE), { ...ISSUE_ARGS, subscriber_ids: ["u-9"] }).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/unknown argument subscriber_ids/);
    expect("reason" in genericCommit(LINEAR_RECORD, { ...ISSUE_ARGS, cc: "x@y.com" })).toBe(true);
  });

  test("POLICY: an unknown nested key is denied where the schema declares the object's fields", () => {
    expect("commit" in genericCommit(NESTED_SCHEMA, { name: "Ana", contact: { email: "ana@fund.com" } })).toBe(true);
    const r = genericCommit(NESTED_SCHEMA, { name: "Ana", contact: { email: "ana@fund.com", bcc: "me@x.com" } });
    expect("reason" in r && r.reason).toMatch(/unknown argument contact\.bcc/);
    const missingNested = genericCommit(NESTED_SCHEMA, { name: "Ana", contact: {} });
    expect("reason" in missingNested && missingNested.reason).toMatch(/contact\.email is required/);
  });

  test("POLICY: free-form maps (additionalProperties) keep every key and check every value", () => {
    expect("commit" in genericCommit(STRIPE_RECORD, REFUND_ARGS)).toBe(true);
    const bad = genericCommit(STRIPE_RECORD, { ...REFUND_ARGS, metadata: { order: 1042 } });
    expect("reason" in bad).toBe(true);
    const proto = canonicalGenericArgs(STRIPE_RECORD.inputSchema, JSON.parse('{"charge":"ch_1","metadata":{"__proto__":"x"}}'));
    expect("reason" in proto).toBe(true);
  });

  test("POLICY: a missing required argument, a wrong type or a value outside the enum cannot be approved or called", () => {
    const { title: _t, ...noTitle } = ISSUE_ARGS;
    const r = genericCommit(LINEAR_RECORD, noTitle);
    expect("reason" in r && r.reason).toMatch(/title is required/);
    expect("reason" in genericCommit(LINEAR_RECORD, { ...ISSUE_ARGS, priority: "high" })).toBe(true);
    expect("reason" in genericCommit(STRIPE_RECORD, { ...REFUND_ARGS, reason: "because" })).toBe(true);
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    expect(gate.check(tool(ISSUE), noTitle).decision.allow).toBe(false);
  });

  test("POLICY: a dry run denies the call before anything else is looked at", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { mode: "dry_run" });
    const d = gate.check(tool(ISSUE), ISSUE_ARGS).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/dry run/);
  });

  test("POLICY: a dry-run batch can never be sent", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { kind: "dry_run" });
    expect(gate.check(tool(ISSUE), ISSUE_ARGS).decision.allow).toBe(false);
  });

  test("POLICY: schema drift since approval is denied in plain words", () => {
    const changed = schemaRecord(ISSUE, { ...LINEAR_RECORD.inputSchema, required: ["team_id", "title", "state_id"] }, NOW + 1000, "20261101_00");
    expect(changed.hash).not.toBe(LINEAR_RECORD.hash);
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { records: [changed, STRIPE_RECORD] });
    const d = gate.check(tool(ISSUE), ISSUE_ARGS).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/fields changed since you approved/);
  });

  test("POLICY: no schema for the tool means no policy (denied, unknown tool)", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { records: [STRIPE_RECORD] });
    const d = gate.check(tool(ISSUE), ISSUE_ARGS).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not on the allowlist/);
  });

  test("POLICY: without the approval token (and auto-run off) the call is denied", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { runToken: null });
    expect(gate.check(tool(ISSUE), ISSUE_ARGS).decision.reason).toMatch(/no approval/);
  });

  test("POLICY: a step that is not declared for the connection is denied", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { actions: [{ role: "send", connector: "tk-stripe" }] });
    expect(gate.check(tool(ISSUE), ISSUE_ARGS).decision.reason).toMatch(/declares no send step through tk-linear/);
  });

  test("POLICY: another server, or a server that does not cover the connection, is denied", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    expect(gate.check(`mcp__composio__${ISSUE}`, ISSUE_ARGS).decision.allow).toBe(false);
    const g2 = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { servers: { [CLI]: ["tk-stripe"] } });
    expect(g2.gate.check(tool(ISSUE), ISSUE_ARGS).decision.allow).toBe(false);
  });

  test("POLICY: an item approved for one tool cannot be used by another tool", () => {
    const { gate } = genericGate([genericItem(STRIPE_RECORD, REFUND_ARGS)]);
    expect(gate.check(tool(ISSUE), ISSUE_ARGS).decision.allow).toBe(false);
    expect(gate.check(tool(REFUND), REFUND_ARGS).decision.allow).toBe(true);
  });

  test("POLICY: an item that already went out (sending, sent, unknown) is never sent again (replay across runs)", () => {
    for (const state of ["sending", "sent", "unknown", "failed_before_send"] as const) {
      const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { itemState: () => state });
      expect(gate.check(tool(ISSUE), ISSUE_ARGS).decision.allow).toBe(false);
    }
  });

  test("POLICY: changing the approved item after the batch was sealed breaks the batch hash (denied)", () => {
    const item = genericItem(LINEAR_RECORD, ISSUE_ARGS);
    const w = genericGate([item]);
    w.batch.items[0]!.commit!.fields = [["schema", LINEAR_RECORD.hash], ["args", JSON.stringify({ ...ISSUE_ARGS, title: "x" })]];
    const { gate } = genericGate([item], { batch: w.batch });
    expect(gate.check(tool(ISSUE), { ...ISSUE_ARGS, title: "x" }).decision.reason).toMatch(/does not match its hash/);
  });

  test("POLICY: meta and shell tools are denied even when a policy for them is offered", () => {
    const meta = schemaRecord("COMPOSIO_MULTI_EXECUTE_TOOL", { type: "object", properties: { tools: { type: "array" } } }, NOW, "1");
    const { gate } = genericGate([], { policies: [genericPolicy(meta, "tk-linear")] });
    const d = gate.check(tool("COMPOSIO_MULTI_EXECUTE_TOOL"), { tools: [] }).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/never allowed/);
    expect(policyFor(tool("SLACK_REMOTE_BASH"), { [CLI]: ["tk-linear"] }, {}, [genericPolicy(schemaRecord("SLACK_REMOTE_BASH", { type: "object" }, NOW, "1"), "tk-linear")])).toHaveProperty("reason");
  });

  test("POLICY: an input that carries a nested tool call is denied before its schema is looked at", () => {
    const { gate } = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const d = gate.check(tool(ISSUE), { ...ISSUE_ARGS, description: { tool_slug: "GMAIL_SEND_EMAIL" } } as unknown as Record<string, unknown>).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/nested tool call/);
  });

  test("POLICY: reply, forward and unreviewed draft tools never get a generic policy", () => {
    for (const slug of ["GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "LINEAR_CREATE_ISSUE_DRAFT"]) {
      const rec = schemaRecord(slug, { type: "object", properties: { thread_id: { type: "string" } } }, NOW, "1");
      expect("reason" in genericCommit(rec, { thread_id: "t1" })).toBe(true);
      const { gate } = genericGate([], { policies: [genericPolicy(rec, "tk-linear")] });
      expect(gate.check(tool(slug), { thread_id: "t1" }).decision.allow).toBe(false);
    }
  });

  test("POLICY: hand-written s16 policies take precedence (no generic item or policy for their slugs)", () => {
    const send = schemaRecord("GMAIL_SEND_EMAIL", { type: "object", properties: { recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, bcc: { type: "string" } } }, NOW, "1");
    expect(TOOL_POLICIES.some((p) => p.tool === "GMAIL_SEND_EMAIL")).toBe(true);
    const r = genericCommit(send, { recipient_email: "a@b.com", subject: "s", body: "b", bcc: "spy@x.com" });
    expect("reason" in r && r.reason).toMatch(/reviewed policy/);
    // Even a forged generic item with a generic policy offered: the static policy is the one that decides.
    const item = { key: "a@b.com", to: "a@b.com", subject: "s", body: "b", warnings: [], commit: { verb: genericVerb("GMAIL_SEND_EMAIL"), fields: [["schema", send.hash], ["args", JSON.stringify({ bcc: "spy@x.com", body: "b", recipient_email: "a@b.com", subject: "s" })]] as Array<[string, string]> } };
    const { gate } = genericGate([item], { policies: [genericPolicy(send, "gmail")], actions: [{ role: "send", connector: "gmail" }] });
    const d = gate.check(tool("GMAIL_SEND_EMAIL"), { recipient_email: "a@b.com", subject: "s", body: "b", bcc: "spy@x.com" }).decision;
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/bcc is not allowed/);
  });

  test("POLICY: the approved item carries the verb, the schema hash and the canonical arguments, inside the batch hash", () => {
    const item = genericItem(LINEAR_RECORD, ISSUE_ARGS);
    expect(item.commit!.verb).toBe(genericVerb(ISSUE));
    expect(isGenericVerb(item.commit!.verb)).toBe(true);
    expect(isGenericVerb("send")).toBe(false);
    const p = parseGenericCommit(item)!;
    expect(p.slug).toBe(ISSUE);
    expect(p.schemaHash).toBe(LINEAR_RECORD.hash);
    expect(p.args.description).toBe("Customer asked for a refund.\nSee ticket.");
    const a = makeBatch("wf", "live", [item], NOW).hash;
    const b = makeBatch("wf", "live", [genericItem(LINEAR_RECORD, { ...ISSUE_ARGS, priority: 3 })], NOW).hash;
    expect(a).not.toBe(b);
    expect(parseGenericCommit({ ...item, commit: { verb: "send", fields: [] } })).toBeNull();
    // A hand-made item whose bytes are not canonical (CRLF, unsorted keys) is not an approved call.
    expect(parseGenericCommit({ commit: { verb: item.commit!.verb, fields: [["schema", LINEAR_RECORD.hash], ["args", JSON.stringify({ title: "a\r\nb", team_id: "t" })]] } })).toBeNull();
  });
});

describe("s17 review", () => {
  test("REVIEW: every leaf is one row, nested and array values included, nothing folded", () => {
    const r = genericReview({ name: "Ana", contact: { email: "ana@fund.com", phone: "" }, tags: [], extra: {} }, NESTED_SCHEMA);
    expect(r.rows.map((x) => x.path)).toEqual(["contact.email", "contact.phone", "extra", "name", "tags"]);
    expect(r.rows.find((x) => x.path === "tags")!.value).toBe("(empty list)");
    expect(r.rows.find((x) => x.path === "extra")!.value).toBe("(empty)");
    expect(r.rows.find((x) => x.path === "contact.phone")!.value).toBe("(empty)");
    const issue = genericReview(JSON.parse(parseGenericCommit(genericItem(LINEAR_RECORD, ISSUE_ARGS))!.argsJson), LINEAR_RECORD);
    expect(issue.rows.map((x) => x.path)).toEqual(["description", "label_ids[0]", "label_ids[1]", "priority", "team_id", "title"]);
  });

  test("REVIEW: recipients, amounts and ids are highlighted", () => {
    const r = genericReview({ to: "Ana <ana@fund.com>", amount: 4200, team_id: "t-1", label_ids: ["l-1"], note: "write to bob@x.com", title: "Hi" }, null);
    const h = Object.fromEntries(r.rows.map((x) => [x.path, x.highlight]));
    expect(h).toEqual({ amount: "amount", "label_ids[0]": "id", note: "recipient", team_id: "id", title: null, to: "recipient" });
    const refund = genericReview(REFUND_ARGS, STRIPE_RECORD);
    expect(refund.rows.find((x) => x.path === "amount")!.highlight).toBe("amount");
    expect(refund.rows.find((x) => x.path === "charge")!.highlight).toBe("id");
  });

  test("REVIEW: labels are plain words, with required flags and the schema's description", () => {
    const r = genericReview(ISSUE_ARGS, LINEAR_RECORD);
    const team = r.rows.find((x) => x.path === "team_id")!;
    expect(team.label).toBe("Team ID");
    expect(team.required).toBe(true);
    expect(team.description).toMatch(/team/i);
    expect(r.rows.find((x) => x.path === "label_ids[1]")!.label).toBe("Label IDs 2");
    expect(r.rows.find((x) => x.path === "priority")!.required).toBe(false);
    for (const row of r.rows) expect(row.label).not.toMatch(/_/);
  });

  test("REVIEW: a destructive tool carries one plain warning line", () => {
    const r = genericReview(REFUND_ARGS, STRIPE_RECORD, { destructive: true, name: "Create refund" });
    expect(r.warning).toMatch(/cannot be undone/);
    expect(genericReview(ISSUE_ARGS, LINEAR_RECORD).warning).toBeNull();
  });

  test("REVIEW: the rows of an item come from the same canonical bytes that are hashed", () => {
    const item = genericItem(LINEAR_RECORD, ISSUE_ARGS);
    const rows = genericReviewOfItem(item, LINEAR_RECORD)!;
    const canonical = parseGenericCommit(item)!.argsJson;
    expect(rows.rows).toEqual(genericReview(JSON.parse(canonical), LINEAR_RECORD).rows);
    expect(rows.rows.find((x) => x.path === "description")!.value).toBe("Customer asked for a refund.\nSee ticket.");
    expect(rows.schemaHash).toBe(LINEAR_RECORD.hash);
    expect(rows.stale).toBe(false);
  });

  test("REVIEW: an item whose schema changed says so instead of pretending it still fits", () => {
    const changed = schemaRecord(ISSUE, { ...LINEAR_RECORD.inputSchema, required: ["team_id"] }, NOW, "2");
    const r = genericReviewOfItem(genericItem(LINEAR_RECORD, ISSUE_ARGS), changed)!;
    expect(r.stale).toBe(true);
    expect(r.warning).toMatch(/fields changed/);
  });
});

describe("s17 exec", () => {
  const job = (w: ReturnType<typeof genericGate>, accounts: Record<string, string> = { "tk-linear": "linear_live-one", "tk-stripe": "stripe_live-one" }) => ({ runner: universeCli(), accounts, w });

  test("EXEC: a generic item runs `composio execute <SLUG> -d <approved args> --account <id>` once, after the gate allows it", async () => {
    const w = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const { runner, accounts } = job(w);
    const ex = new ComposioCliExecutor({ runner, env: {}, accounts, generic: w.policies });
    const r = await ex.execute({ batch: w.batch, gate: w.gate, actions: [{ role: "send", connector: "tk-linear" }] });
    const exec = runner.calls.filter((c) => c.argv[1] === "execute");
    expect(exec.length).toBe(1);
    expect(exec[0]!.argv.slice(0, 3)).toEqual(["composio", "execute", ISSUE]);
    expect(exec[0]!.argv.slice(-2)).toEqual(["--account", "linear_live-one"]);
    const sent = JSON.parse(exec[0]!.argv[4]!);
    expect(sent).toEqual({ ...ISSUE_ARGS, description: "Customer asked for a refund.\nSee ticket." });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ tool: tool(ISSUE), allowed: true, ok: true, itemKey: "issue-1" });
  });

  test("EXEC: a drifted schema means the gate denies and nothing is executed", async () => {
    const changed = schemaRecord(ISSUE, { ...LINEAR_RECORD.inputSchema, required: ["title"] }, NOW, "x");
    const w = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { records: [changed] });
    const { runner, accounts } = job(w);
    const r = await new ComposioCliExecutor({ runner, env: {}, accounts, generic: w.policies }).execute({ batch: w.batch, gate: w.gate, actions: [{ role: "send", connector: "tk-linear" }] });
    expect(runner.calls.some((c) => c.argv[1] === "execute" && c.argv[2] === ISSUE)).toBe(false);
    expect(r.toolCalls[0]!.allowed).toBe(false);
  });

  test("EXEC: in a dry run nothing is executed", async () => {
    const w = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)], { mode: "dry_run" });
    const { runner, accounts } = job(w);
    await new ComposioCliExecutor({ runner, env: {}, accounts, generic: w.policies }).execute({ batch: w.batch, gate: w.gate, actions: [{ role: "send", connector: "tk-linear" }] });
    expect(runner.calls.some((c) => c.argv[1] === "execute")).toBe(false);
  });

  test("EXEC: without a generic policy for the connection the method fails before any item is used", async () => {
    const w = genericGate([genericItem(LINEAR_RECORD, ISSUE_ARGS)]);
    const { runner, accounts } = job(w);
    await expect(new ComposioCliExecutor({ runner, env: {}, accounts }).execute({ batch: w.batch, gate: w.gate, actions: [{ role: "send", connector: "tk-linear" }] })).rejects.toThrow(/no usable send/);
    expect(runner.calls.some((c) => c.argv[1] === "execute" && c.argv[2] === ISSUE)).toBe(false);
  });

  test("EXEC: buildChain fetches each generic item's schema fresh and binds one policy per tool to the connection", async () => {
    const { home, runner } = await syncedHome();
    const deps = chainDeps({ home, env: {}, now: () => NOW, simulated: false, runner, fetch: async () => new Response("{}") });
    const resolver = new ChainResolver(deps);
    const items = [genericItem(LINEAR_RECORD, ISSUE_ARGS)];
    const before = runner.calls.length;
    const build = await buildChain({ home, env: {}, resolver, config: null, actions: [{ role: "send", connector: "tk-linear" }], mcpExecutor: { execute: async () => ({ toolCalls: [], text: "" }) }, batchItems: items });
    expect(build).not.toBeNull();
    expect(build!.methods).toContain("composio");
    expect(build!.servers[CLI]).toContain("tk-linear");
    const generic = build!.policies.filter((p) => p.generic === true);
    expect(generic.map((p) => [p.tool, p.connector])).toEqual([[ISSUE, "tk-linear"]]);
    expect(runner.calls.slice(before).some((c) => c.argv.join(" ") === `composio execute ${ISSUE} --get-schema`)).toBe(true);
  });

  test("EXEC: when the fresh schema cannot be fetched there is no generic policy (fail closed)", async () => {
    const { home } = await syncedHome();
    const runner = universeCli({ over: { [`execute ${ISSUE}`]: fail(1, "", "offline") } });
    const resolver = new ChainResolver(chainDeps({ home, env: {}, now: () => NOW, simulated: false, runner, fetch: async () => new Response("{}") }));
    const build = await buildChain({ home, env: {}, resolver, config: null, actions: [{ role: "send", connector: "tk-linear" }], mcpExecutor: { execute: async () => ({ toolCalls: [], text: "" }) }, batchItems: [genericItem(LINEAR_RECORD, ISSUE_ARGS)] });
    expect((build?.policies ?? []).filter((p) => p.generic === true)).toEqual([]);
  });

  test("EXEC: a generic policy is a send with a schema, bound to the CLI server, never verified by hand", () => {
    const p = genericPolicy(LINEAR_RECORD, "tk-linear");
    expect(p).toMatchObject({ connector: "tk-linear", flavor: "composio", tool: ISSUE, role: "send", verified: false, server: CLI, generic: true });
    void ok;
    void TOKEN;
  });
});

export type _Unused = SchemaRecord;
