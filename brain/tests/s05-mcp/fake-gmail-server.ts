// A stdio MCP server standing in for a Gmail MCP server: one read tool (search_emails) and one send tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-gmail", version: "1" });
server.registerTool("search_emails", { description: "search mail", inputSchema: { query: z.string(), maxResults: z.number().optional() } }, async ({ query, maxResults }) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(
        [
          { id: "s1", to: ["anna@northzone.com"], subject: "Offload seed round: Northzone", body: "Hi Anna,\n\nShort one.\n\nMuhammad", date: "2026-10-01T09:00:00Z", query },
          { id: "s2", to: ["tom@seedcamp.com"], subject: "Re: call", body: "Hi Tom,\n\nTuesday 2pm works.\n\nMuhammad", date: "2026-10-02T09:00:00Z" },
        ].slice(0, maxResults ?? 10),
      ),
    },
  ],
}));
server.registerTool("send_email", { description: "send", inputSchema: { to: z.string() } }, async () => ({ content: [{ type: "text", text: "sent" }] }));
await server.connect(new StdioServerTransport());
