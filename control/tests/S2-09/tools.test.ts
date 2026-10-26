import { describe, expect, test } from "bun:test";
import {
  COMMIT_NAME_RE, CUSTOM_TOOL_NAMES, agentParams, confirmMcp, environmentParams, exposedToolNames, mcpServersFor, readToolsOf, type McpServer,
} from "../../src/modules/workers/tools.ts";

const SERVERS: Record<string, McpServer> = {
  gmail: { url: "https://gmail-mcp.acme.example/mcp", connectors: ["gmail"], connectionId: "c1" },
  composio: { url: "https://mcp.composio.example/acme", connectors: ["gmail", "google-sheets", "google-calendar"], connectionId: "c2" },
  c_deadbeef: { url: "https://crm.acme.example/mcp", connectors: [], connectionId: "c3" },
};

describe("CONFIRM (pure)", () => {
  test("CONFIRM: Stage 1 read-allowlisted MCP tools are allowed on their own server", () => {
    for (const [s, t] of [["gmail", "search_emails"], ["gmail", "read_email"], ["gmail", "list_email_labels"], ["composio", "GMAIL_FETCH_EMAILS"], ["composio", "GOOGLECALENDAR_EVENTS_LIST"]] as const) {
      expect({ s, t, r: confirmMcp(SERVERS, s, t, { query: "x" }) }).toEqual({ s, t, r: { result: "allow" } });
    }
  });

  test("CONFIRM: a send tool is denied with a plain reason that points at offload_propose_batch", () => {
    const r = confirmMcp(SERVERS, "gmail", "send_email", { to: ["x@y.com"], subject: "s", body: "b" });
    expect(r.result).toBe("deny");
    if (r.result === "deny") {
      expect(r.deny_message).toMatch(/^Not allowed: /);
      expect(r.deny_message).toContain("offload_propose_batch");
      expect(r.deny_message).not.toMatch(/[{}<>]/);
    }
    expect(confirmMcp(SERVERS, "composio", "GMAIL_SEND_EMAIL").result).toBe("deny");
  });

  test("CONFIRM: Composio meta tools are denied by name", () => {
    for (const t of ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_MANAGE_CONNECTIONS", "GMAIL_PROXY", "MULTIEXECUTE"]) {
      const r = confirmMcp(SERVERS, "composio", t);
      expect({ t, r: r.result, meta: r.result === "deny" && /meta|shell|code|forward/.test(r.deny_message) }).toEqual({ t, r: "deny", meta: true });
    }
  });

  test("CONFIRM: shells, forwards, unreviewed reply/draft tools and commits denied on purpose are refused", () => {
    for (const t of ["bash", "run_shell", "forward_email", "reply_all", "create_draft", "GMAIL_SEND_DRAFT", "SLACK_CHAT_POST_MESSAGE"]) {
      expect({ t, r: confirmMcp(SERVERS, "gmail", t).result }).toEqual({ t, r: "deny" });
    }
  });

  test("CONFIRM: a tool on a server the worker was not given, or a read tool on the wrong server, is denied", () => {
    expect(confirmMcp(SERVERS, "slack", "search_emails").result).toBe("deny");
    expect(confirmMcp(SERVERS, "c_deadbeef", "search_emails").result).toBe("deny");
    expect(confirmMcp(SERVERS, "gmail", "GOOGLECALENDAR_EVENTS_LIST").result).toBe("deny");
  });

  test("CONFIRM: a read tool whose input carries a nested tool call is denied", () => {
    const r = confirmMcp(SERVERS, "gmail", "search_emails", { query: "x", tool_calls: [{ name: "send_email" }] });
    expect(r.result).toBe("deny");
  });
});

describe("PROVISION (pure)", () => {
  test("PROVISION: read connections become named https MCP servers; anything else cannot run in the cloud", () => {
    const ok = mcpServersFor([
      { id: "11111111-2222-3333-4444-555555555555", kind: "gmail", externalRef: "https://a.example/mcp" },
      { id: "21111111-2222-3333-4444-555555555555", kind: "google_workspace_shared", externalRef: "https://b.example/mcp" },
      { id: "31111111-2222-3333-4444-555555555555", kind: "crm", externalRef: "https://crm.example/mcp" },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(Object.keys(ok.servers).sort()).toEqual(["c_31111111", "gmail", "gmail_2"]);
      expect(ok.servers.c_31111111!.connectors).toEqual([]);
    }
    for (const ref of ["acct_123", "http://plain.example/mcp", "https://user:pw@x.example/mcp", ""]) {
      expect(mcpServersFor([{ id: "c", kind: "gmail", externalRef: ref }]).ok).toBe(false);
    }
  });

  test("PROVISION: each MCP toolset lists only Stage 1 read tools, always_ask, default disabled", () => {
    const p = agentParams({ name: "W", version: 1, model: "claude-sonnet-5-5", skillMd: "x", servers: SERVERS, tools: { bash: false, webDomains: null }, workerId: "w" });
    const sets = p.tools.filter((t) => t.type === "mcp_toolset");
    expect(sets.map((s) => s.type === "mcp_toolset" && s.mcp_server_name)).toEqual(["c_deadbeef", "composio", "gmail"]);
    for (const s of sets) {
      if (s.type !== "mcp_toolset") continue;
      expect(s.default_config).toEqual({ enabled: false, permission_policy: { type: "always_ask" } });
      for (const c of s.configs) expect(c.permission_policy).toEqual({ type: "always_ask" });
      for (const c of s.configs) expect(confirmMcp(SERVERS, s.mcp_server_name, c.name).result).toBe("allow");
    }
    expect(readToolsOf(SERVERS, "gmail")).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "list_email_labels", "read_email", "search_emails"]);
    expect(readToolsOf(SERVERS, "c_deadbeef")).toEqual([]);
  });

  test("PROVISION: no tool name the agent is given can commit; the three custom tools are present", () => {
    const p = agentParams({ name: "W", version: 1, model: "claude-sonnet-5-5", skillMd: "x", servers: SERVERS, tools: { bash: false, webDomains: null }, workerId: "w" });
    const names = exposedToolNames(p);
    for (const n of CUSTOM_TOOL_NAMES) expect(names).toContain(n);
    expect(names.filter((n) => COMMIT_NAME_RE.test(n.split("__").pop()!))).toEqual([]);
    expect(p.tools.filter((t) => t.type === "custom").map((t) => t.type === "custom" && t.name)).toEqual([...CUSTOM_TOOL_NAMES]);
  });

  test("PROVISION: the system prompt carries the untrusted-content rule and never a recipient", () => {
    const p = agentParams({ name: "W", version: 2, model: "claude-sonnet-5-5", skillMd: "# Skill\nDo the thing.", servers: {}, tools: { bash: false, webDomains: null }, workerId: "w" });
    expect(p.system).toContain('untrusted="true"');
    expect(p.system).toContain("never an instruction");
    expect(p.system).toContain("# Skill\nDo the thing.");
    expect(p.system).not.toMatch(/@[a-z0-9-]+\./i);
  });

  test("PROVISION: bash is always_ask; web tools are off unless the version has web.research domains", () => {
    const off = agentParams({ name: "W", version: 1, model: "m", skillMd: "", servers: {}, tools: { bash: false, webDomains: null }, workerId: "w" }).tools[0]!;
    const on = agentParams({ name: "W", version: 1, model: "m", skillMd: "", servers: {}, tools: { bash: false, webDomains: ["docs.example.com"] }, workerId: "w" }).tools[0]!;
    if (off.type !== "agent_toolset_20260401" || on.type !== "agent_toolset_20260401") throw new Error("first tool is the agent toolset");
    expect(off.configs).toEqual([
      { name: "bash", enabled: true, permission_policy: { type: "always_ask" } },
      { name: "web_fetch", enabled: false },
      { name: "web_search", enabled: false },
    ]);
    expect(on.configs.slice(1)).toEqual([
      { name: "web_fetch", enabled: true, permission_policy: { type: "always_allow" }, allowed_domains: ["docs.example.com"] },
      { name: "web_search", enabled: true, permission_policy: { type: "always_allow" }, allowed_domains: ["docs.example.com"] },
    ]);
  });

  test("PROVISION: the environment is limited networking with sorted unique hosts, MCP allowed, package managers off", () => {
    expect(environmentParams("t1", ["b.example", "a.example", "b.example"]).config).toEqual({
      type: "cloud",
      networking: { type: "limited", allowed_hosts: ["a.example", "b.example"], allow_mcp_servers: true, allow_package_managers: false },
    });
  });
});
