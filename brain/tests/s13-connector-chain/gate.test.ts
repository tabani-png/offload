// s13 GATE: every method's writes map to the item's one commit with a full-argument hash; dynamic policies are bound
// to their server; meta tools stay denied on every method; `input` needs a live approved batch and consumes nothing;
// commit-bearing items change the batch hash, old items hash as before.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { apiPolicies, apiServer } from "../../src/connectors/api.ts";
import { parseApis } from "../../src/connectors/api-config.ts";
import { COMPOSIO_CLI_SERVER } from "../../src/connectors/composio.ts";
import { expectedCommit } from "../../src/connectors/computer/actions.ts";
import { computerPolicies } from "../../src/connectors/computer/executor.ts";
import { computerServer } from "../../src/connectors/computer/probe.ts";
import { policyFor } from "../../src/workflows/allowlist.ts";
import { batchHash, makeBatch } from "../../src/workflows/batch.ts";
import { GMAIL_API, gateWorld, ITEM, ITEM2 } from "./setup.ts";

const api = () => apiPolicies(parseApis(GMAIL_API, []));
const CSERVER = computerServer("gmail");
const all = () => ({
  servers: { gmail: ["gmail"], [COMPOSIO_CLI_SERVER]: ["gmail"], [apiServer("gmail")]: ["gmail"], [CSERVER]: ["gmail"] },
  policies: [...api(), ...computerPolicies(["gmail"])],
});

/** For every method: the send tool and the exact arguments for an item. */
const methods = (item = ITEM) => [
  { name: "mcp", tool: "mcp__gmail__send_email", args: { to: item.to, subject: item.subject, body: item.body } },
  { name: "composio", tool: `mcp__${COMPOSIO_CLI_SERVER}__GMAIL_SEND_EMAIL`, args: { recipient_email: item.to, subject: item.subject, body: item.body } },
  { name: "api", tool: `mcp__${apiServer("gmail")}__users.messages.send`, args: { to: item.to, subject: item.subject, body: item.body } },
  { name: "computer", tool: `mcp__${CSERVER}__commit`, args: { app: "gmail", verb: "send", fields: expectedCommit(item).fields } },
];

describe("s13 gate: every method needs the approval and the exact hash", () => {
  test("GATE: each method's send is allowed only with the exact approved arguments, once per item", () => {
    for (const m of methods()) {
      const w = gateWorld(all());
      const changed = JSON.parse(JSON.stringify(m.args).replace("Seed round", "Seed round!")) as Record<string, unknown>;
      expect(w.gate.decide(m.tool, changed, false).allow).toBe(false);
      expect(w.gate.check(m.tool, m.args).result.behavior).toBe("allow");
      expect(w.journal).toEqual([{ key: ITEM.key, role: "send", tool: m.tool }]);
      // Once used, no method may send that item again in this batch.
      for (const other of methods()) expect(w.gate.decide(other.tool, other.args, false).allow).toBe(false);
      // The other item is still sendable by any method.
      expect(w.gate.decide(methods(ITEM2)[0]!.tool, methods(ITEM2)[0]!.args, false).allow).toBe(true);
    }
  });

  test("GATE: without an approval, or in a dry run, no method's write or input is allowed", () => {
    for (const o of [{ approved: false }, { mode: "dry_run" as const }]) {
      const w = gateWorld({ ...all(), ...o });
      for (const m of methods()) expect(w.gate.decide(m.tool, m.args, false).allow).toBe(false);
      expect(w.gate.decide(`mcp__${CSERVER}__input`, { member: "type" }, false).allow).toBe(false);
      // Reads stay allowed.
      expect(w.gate.decide(`mcp__${CSERVER}__read`, { member: "screenshot" }, false).allow).toBe(true);
    }
  });

  test("GATE: an item already sending / sent / unknown is never committed again by any method (no double send)", () => {
    for (const state of ["sending", "sent", "unknown", "failed_before_send"] as const) {
      const w = gateWorld(all());
      w.states[ITEM.key] = state;
      for (const m of methods()) expect(w.gate.decide(m.tool, m.args, false).reason).toContain(`is ${state}`);
    }
  });

  test("GATE: input is a local edit: needs the approved live batch and a declared send through that app, never uses up the item", () => {
    const w = gateWorld(all());
    for (let i = 0; i < 5; i++) expect(w.gate.check(`mcp__${CSERVER}__input`, { member: "type" }).decision).toMatchObject({ allow: true, role: "input" });
    expect(w.journal).toHaveLength(0);
    expect(w.gate.check(methods()[3]!.tool, methods()[3]!.args).result.behavior).toBe("allow");
    const noSend = gateWorld({ ...all(), actions: [{ role: "log", connector: "gmail" }] });
    expect(noSend.gate.decide(`mcp__${CSERVER}__input`, { member: "type" }, false).reason).toContain("declares no send step");
  });
});

describe("s13 gate: bound policies and meta tools", () => {
  test("GATE: dynamic policies apply only on their own server; static tool names never apply on a bound server", () => {
    const { servers, policies } = all();
    expect(policyFor(`mcp__${CSERVER}__send_email`, servers, {}, policies)).toMatchObject({ reason: expect.stringContaining("not on the allowlist") });
    expect(policyFor("mcp__gmail__commit", servers, {}, policies)).toMatchObject({ reason: expect.stringContaining("not on the allowlist") });
    expect(policyFor(`mcp__${apiServer("gmail")}__commit`, servers, {}, policies)).toMatchObject({ reason: expect.stringContaining("not on the allowlist") });
    expect(policyFor(`mcp__${CSERVER}__commit`, servers, {}, policies)).toMatchObject({ flavor: "computer", role: "send", server: CSERVER });
    // An unknown server never resolves, even with policies.
    expect(policyFor("mcp__computer_slack__commit", servers, {}, policies)).toMatchObject({ reason: expect.stringContaining("not a connected server") });
  });

  test("GATE: meta, shell and multiplexer tools are denied on every method's server, and so are nested tool calls", () => {
    const w = gateWorld(all());
    for (const server of ["gmail", COMPOSIO_CLI_SERVER, apiServer("gmail"), CSERVER])
      for (const t of ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "execute", "bash", "run_action", "proxy_request", "forward_email", "create_draft"])
        expect(w.gate.decide(`mcp__${server}__${t}`, {}, false).allow).toBe(false);
    const [, composio] = methods();
    expect(w.gate.decide(composio!.tool, { ...composio!.args, tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] }, false).reason).toContain("nested tool call");
  });

  test("GATE: Composio's live schema fields: from_email only empty, include_signature only false", () => {
    const w = gateWorld(all());
    const [, c] = methods();
    expect(w.gate.decide(c!.tool, { ...c!.args, from_email: "other@x.com" }, false).reason).toContain("from_email is not allowed");
    expect(w.gate.decide(c!.tool, { ...c!.args, include_signature: true }, false).reason).toContain("include_signature must be false");
    expect(w.gate.decide(c!.tool, { ...c!.args, from_email: "", include_signature: false }, false).allow).toBe(true);
  });
});

describe("s13 gate: items that carry their commit", () => {
  test("GATE: an item's commit is part of the batch hash; an item without one hashes exactly as before s13", () => {
    const old = createHash("sha256").update(JSON.stringify({ v: 1, workflowId: "wf", kind: "live", items: [[ITEM.to, ITEM.subject, ITEM.body]] })).digest("hex");
    expect(batchHash("wf", "live", [ITEM])).toBe(old);
    const a = batchHash("wf", "live", [{ ...ITEM, commit: { verb: "save", fields: [["amount", "120.00"]] } }]);
    const b = batchHash("wf", "live", [{ ...ITEM, commit: { verb: "save", fields: [["amount", "121.00"]] } }]);
    expect(a).not.toBe(old);
    expect(a).not.toBe(b);
    expect(makeBatch("wf", "live", [{ ...ITEM, commit: { verb: "save", fields: [["amount", "120.00"]] } }], 0).hash).toBe(a);
  });

  test("GATE: a computer commit for a non-email item must match its approved verb and form", () => {
    const item = { ...ITEM, commit: { verb: "save", fields: [["Invoice number", "INV-7"], ["Amount", "120.00"]] as Array<[string, string]> } };
    const w = gateWorld({ ...all(), items: [item] });
    const tool = `mcp__${CSERVER}__commit`;
    const exact = { app: "gmail", verb: "save", fields: [["amount", "120.00"], ["invoice number", "INV-7"]] };
    expect(w.gate.decide(tool, { ...exact, verb: "send" }, false).allow).toBe(false);
    expect(w.gate.decide(tool, { ...exact, fields: [["amount", "1200.00"], ["invoice number", "INV-7"]] }, false).allow).toBe(false);
    expect(w.gate.decide(tool, { ...exact, app: "slack" }, false).allow).toBe(false);
    expect(w.gate.check(tool, exact).result.behavior).toBe("allow");
  });
});
