// s13: the mcp method's health probe. For every connectors.json server that lists the target: its sign-in env vars
// must be set, and a real MCP `tools/list` must answer within the time limit. The capabilities are only the tools the
// gate's allowlist knows for that connector AND the server really lists: a server that lists none of them fails
// closed (`no_allowlisted_tools`); a tool is never trusted from its name. tools/list calls no tool.
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { CHAIN_WORDS, result, withTimeout, type ChainDeps, type MethodProbe, type ProbeResult } from "./chain.ts";
import { loadConnectorsConfig, missingEnv, toMcpServers } from "./config.ts";
import { capabilityOf, type ChainTarget } from "./targets.ts";

/** Lists a server's tool names. Tests inject a fake; the default speaks MCP to the real server. */
export interface McpLister {
  listTools(name: string, server: McpServerConfig, timeoutMs: number): Promise<string[]>;
}

export class SdkMcpLister implements McpLister {
  async listTools(name: string, server: McpServerConfig, timeoutMs: number): Promise<string[]> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "offload-brain-probe", version: "1" });
    const run = async () => {
      if (server.type === "http") {
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
      } else if (server.type === undefined || server.type === "stdio") {
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }), stderr: "pipe" }));
      } else {
        throw new Error(`server ${name}: transport ${server.type} is not supported`);
      }
      const out: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await client.listTools(cursor === undefined ? {} : { cursor });
        for (const t of r.tools) out.push(t.name);
        cursor = r.nextCursor;
        if (cursor === undefined) break;
      }
      return out;
    };
    try {
      return await withTimeout(run(), timeoutMs);
    } finally {
      // Bounded: a server that hangs must not hold the probe past its time limit.
      await withTimeout(client.close(), 500).catch(() => {});
    }
  }
}

export class McpProbe implements MethodProbe {
  readonly method = "mcp" as const;

  async probe(t: ChainTarget, d: ChainDeps): Promise<ProbeResult> {
    const cfg = loadConnectorsConfig(d.home).config;
    const servers = Object.entries(cfg?.servers ?? {}).filter(([, s]) => s.catalog.includes(t.id));
    if (cfg === null || servers.length === 0) return result("skipped", "no_server", CHAIN_WORDS.noServer(t.name));
    const ready = servers.filter(([, s]) => missingEnv(s, d.env).length === 0);
    if (ready.length === 0) return result("skipped", "missing_env", CHAIN_WORDS.missingSetting);
    let last: ProbeResult = result("failed", "error", CHAIN_WORDS.broken);
    for (const [name] of ready) {
      const t0 = d.now();
      let tools: string[];
      try {
        const resolved = toMcpServers({ ...cfg, servers: { [name]: cfg.servers[name]! } }, d.env)[name]!;
        tools = await d.mcp.listTools(name, resolved, d.timeoutMs);
      } catch (err) {
        const timedOut = err instanceof Error && err.message === "timeout";
        last = result("failed", timedOut ? "timeout" : "error", timedOut ? CHAIN_WORDS.noAnswer : CHAIN_WORDS.broken, {}, d.now() - t0);
        continue;
      }
      const reads: string[] = [];
      const writes: string[] = [];
      const map: Record<string, string> = {};
      for (const tool of tools) {
        const c = capabilityOf(t.id, tool);
        if (c === null) continue;
        (c.role === "read" ? reads : writes).push(c.capability);
        map[c.capability] ??= `mcp__${name}__${tool}`;
      }
      if (reads.length + writes.length === 0) {
        last = result("failed", "no_allowlisted_tools", CHAIN_WORDS.noUsable, {}, d.now() - t0, { server: name });
        continue;
      }
      return result("ok", "ok", null, { reads: [...new Set(reads)], writes: [...new Set(writes)], tools: map }, d.now() - t0, { server: name });
    }
    return last;
  }
}
