// A minimal MCP client for deterministic read calls the brain makes itself (Sent mail for the tone pack), without a
// model in between. Side-effect calls never go through here: they go through the Agent SDK runner and its gate.
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { classifyTool } from "../workflows/gate.ts";
import type { ToolCaller } from "../tone/mail-source.ts";

export interface McpConnection {
  caller: ToolCaller;
  close(): Promise<void>;
}

export async function connectMcp(name: string, server: McpServerConfig): Promise<McpConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "offload-brain", version: "1" });
  if (server.type === "http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
  } else if (server.type === undefined || server.type === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }), stderr: "pipe" }));
  } else {
    throw new Error(`MCP server ${name}: transport ${server.type} is not supported here`);
  }
  return {
    caller: {
      async callTool(tool, args) {
        // This path is read-only by construction: anything the gate would not call a read is refused.
        if (classifyTool(`mcp__${name}__${tool}`) !== "read") throw new Error(`refusing ${tool}: the brain's direct MCP calls are read-only`);
        const r = await client.callTool({ name: tool, arguments: args });
        if (r.isError === true) throw new Error(`MCP tool ${tool} failed: ${JSON.stringify(r.content).slice(0, 300)}`);
        return r;
      },
    },
    close: () => client.close(),
  };
}
