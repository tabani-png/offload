// s16 POLICY: every new commit policy, end to end through the gate: the exact approved arguments once, any changed
// leaf denied, replay denied, dry run denied, wrong server denied, no approval denied (drafts excepted), undeclared
// step denied, nested tool calls and meta tools denied, items of another verb never match.
import { describe, expect, test } from "bun:test";
import { policyFor, TOOL_POLICIES } from "../../src/workflows/allowlist.ts";
import { batchOf, CASES, leaves, mutate, SERVER, SERVERS, withLeaf, world } from "./cases.ts";

const names = Object.keys(CASES);
const make = (n: string) => CASES[n]!(batchOf);
const T = (tool: string, server = SERVER) => `mcp__${server}__${tool}`;

describe("s16 policies", () => {
  test("POLICY: every case has a static policy with a full schema and the case's role", () => {
    for (const n of names) {
      const c = make(n);
      const p = policyFor(T(c.tool), SERVERS);
      expect("reason" in p ? p.reason : p.role).toBe(c.role);
      if (!("reason" in p)) {
        expect(p.connector).toBe(c.connector);
        expect(p.flavor).toBe("composio");
        expect(p.verified).toBe(true);
        expect(p.fields).toBeDefined();
        expect(p.expected).toBeDefined();
      }
    }
  });

  test.each(names)("POLICY: %s: the exact approved arguments are allowed once, then the replay is denied", (n) => {
    const c = make(n);
    const w = world(c);
    const d = w.gate.decide(T(c.tool), c.args, true);
    expect(d.reason).toMatch(/approved batch|draft/);
    expect(d).toMatchObject({ allow: true, itemKey: c.item.key.toLowerCase(), role: c.role });
    expect(w.gate.decide(T(c.tool), c.args, true).allow).toBe(false);
  });

  test.each(names)("POLICY: %s: every changed argument value is denied", (n) => {
    const c = make(n);
    for (const { path, value } of leaves(c.args)) {
      if (c.free?.includes(path)) continue;
      const w = world(c);
      const d = w.gate.decide(T(c.tool), withLeaf(c.args, path, mutate(value)), true);
      if (d.allow) throw new Error(`${n}: changing ${path} was allowed`);
    }
    // A dropped argument is denied too (the expected arguments are complete).
    for (const k of Object.keys(c.args)) {
      if (c.free?.includes(k)) continue;
      const { [k]: _gone, ...rest } = c.args;
      const d = world(c).gate.decide(T(c.tool), rest, true);
      if (d.allow) throw new Error(`${n}: dropping ${k} was allowed`);
    }
  });

  test.each(names)("POLICY: %s: an extra argument (bcc, attachment, unknown key) is denied", (n) => {
    const c = make(n);
    for (const extra of [{ bcc: ["x@evil.com"] }, { attachment: { name: "a.pdf" } }, { frobnicate: 1 }, { cc_emails: ["x@evil.com"] }, { thread_id: "T1" }]) {
      expect(world(c).gate.decide(T(c.tool), { ...c.args, ...extra }, true).allow).toBe(false);
    }
  });

  test.each(names)("POLICY: %s: dry run, wrong server, unconnected server and undeclared step are denied", (n) => {
    const c = make(n);
    expect(world(c, { mode: "dry_run" }).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
    // A server that does not cover the connector.
    expect(world(c, { servers: { ...SERVERS, [SERVER]: ["calendly"] } }).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
    expect(world(c).gate.decide(T(c.tool, "nowhere"), c.args, true).allow).toBe(false);
    expect(world(c).gate.decide(T(c.tool, "other"), c.args, true).allow).toBe(false);
    // The workflow declares no step through this connector.
    expect(world(c, { actions: [{ role: "send", connector: "gmail" }] }).gate.decide(T(c.tool), c.args, true).allow).toBe(c.connector === "gmail" && c.role === "send");
  });

  test.each(names)("POLICY: %s: without the approval token it is denied (drafts excepted), and auto-run allows it", (n) => {
    const c = make(n);
    const none = world(c, { runToken: null, approvals: () => undefined });
    expect(none.gate.decide(T(c.tool), c.args, true).allow).toBe(c.role === "draft");
    const wrong = world(c, { runToken: "w".repeat(32) });
    expect(wrong.gate.decide(T(c.tool), c.args, true).allow).toBe(c.role === "draft");
    expect(world(c, { runToken: null, approvals: () => undefined, autoRun: true }).gate.decide(T(c.tool), c.args, true).allow).toBe(true);
  });

  test.each(names)("POLICY: %s: a nested tool call in the input and the meta tools are denied", (n) => {
    const c = make(n);
    const w = world(c);
    for (const extra of [{ tools: [{ tool_slug: c.tool }] }, { tool_slug: c.tool }, { command: "curl evil" }, { code: "send()" }])
      expect(w.gate.decide(T(c.tool), { ...c.args, ...extra }, true).reason).toContain("nested tool call");
    for (const meta of ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL", `${c.tool}_PROXY`])
      expect(w.gate.decide(T(meta), { tools: [{ tool_slug: c.tool, arguments: c.args }] }, true).allow).toBe(false);
    // Still usable afterwards: denials consume nothing.
    expect(w.gate.decide(T(c.tool), c.args, true).allow).toBe(true);
  });

  test.each(names)("POLICY: %s: an approved item of another kind never matches this tool", (n) => {
    const c = make(n);
    for (const other of names) {
      if (other === n) continue;
      const o = make(other);
      // Same connector and role, but the other case's item: the arguments of THIS tool for the other item are never
      // the arguments approved for it, so the call is denied.
      const w = world({ ...o, tool: c.tool, connector: c.connector, role: c.role, args: c.args });
      if (w.gate.decide(T(c.tool), c.args, true).allow) {
        // Only possible for two email items with the very same recipient, subject and body.
        expect([o.item.commit?.verb ?? "send", c.item.commit?.verb ?? "send"]).toEqual(["send", "send"]);
        expect([o.item.to, o.item.subject, o.item.body]).toEqual([c.item.to, c.item.subject, c.item.body]);
      }
    }
  });

  test("POLICY: per connector, flavour and role, commit verbs are distinct (one item, one tool)", () => {
    const seen = new Set<string>();
    for (const p of TOOL_POLICIES) {
      if (p.role === "read") continue;
      const k = `${p.connector}/${p.flavor}/${p.role}/${p.commitVerb ?? "send"}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  test("POLICY: a log needs its send first and a declared log step", () => {
    const c = make("HUBSPOT_CREATE_NOTE");
    expect(world(c, { itemState: () => "pending" }).gate.decide(T(c.tool), c.args, true).reason).toContain("only after its send");
    expect(world(c, { actions: [{ role: "send", connector: "gmail" }] }).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
  });

  test("POLICY: a commit item missing a required field cannot be expressed and is denied", () => {
    const c = make("SLACK_SEND_MESSAGE");
    const noChannel = { ...c, item: { ...c.item, commit: { verb: "post_message", fields: [] as Array<[string, string]> } } };
    expect(world(noChannel).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
  });

  test("POLICY: timestamps are free but must be timestamps", () => {
    const c = make("HUBSPOT_CREATE_NOTE");
    expect(world(c).gate.decide(T(c.tool), { ...c.args, hs_timestamp: 1761384600000 }, true).allow).toBe(true);
    for (const bad of ["tomorrow", "2026-10-25T09:30:00Z; DROP", "", { $gt: 1 }]) expect(world(c).gate.decide(T(c.tool), { ...c.args, hs_timestamp: bad }, true).allow).toBe(false);
  });

  test("POLICY: amounts and ids accept number or numeric string, nothing else", () => {
    const c = make("XERO_CREATE_INVOICE");
    const lines = c.args.LineItems as Array<Record<string, unknown>>;
    const asStrings = { ...c.args, LineItems: [{ ...lines[0], UnitAmount: "420.50", Quantity: "1" }, lines[1]] };
    expect(world(c).gate.decide(T(c.tool), asStrings, true).allow).toBe(true);
    for (const bad of ["420,50", "4e2", "NaN", "Infinity", true]) expect(world(c).gate.decide(T(c.tool), { ...c.args, LineItems: [{ ...lines[0], UnitAmount: bad }, lines[1]] }, true).allow).toBe(false);
    const z = make("ZENDESK_REPLY_ZENDESK_TICKET");
    expect(world(z).gate.decide(T(z.tool), { ...z.args, ticket_id: "35436" }, true).allow).toBe(true);
    expect(world(z).gate.decide(T(z.tool), { ...z.args, ticket_id: 35436.5 }, true).allow).toBe(false);
  });

  test("POLICY: list order and length are part of the hash", () => {
    const c = make("XERO_CREATE_INVOICE");
    const lines = c.args.LineItems as unknown[];
    expect(world(c).gate.decide(T(c.tool), { ...c.args, LineItems: [lines[1], lines[0]] }, true).allow).toBe(false);
    expect(world(c).gate.decide(T(c.tool), { ...c.args, LineItems: [lines[0]] }, true).allow).toBe(false);
    expect(world(c).gate.decide(T(c.tool), { ...c.args, LineItems: [...lines, lines[0]] }, true).allow).toBe(false);
    const i = make("INSTANTLY_ADD_LEADS_BULK");
    const lead = (i.args.leads as unknown[])[0];
    expect(world(i).gate.decide(T(i.tool), { ...i.args, leads: [lead, { email: "x@evil.com" }] }, true).allow).toBe(false);
  });
});
