// s05 AC-2 (MCP-backed MailSource): a real MCP stdio round trip against a fake Gmail server, offline.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectMcp } from "../../src/connectors/mcp-client.ts";
import { McpMailSource } from "../../src/tone/mail-source.ts";

const server = { type: "stdio" as const, command: "bun", args: [join(import.meta.dir, "fake-gmail-server.ts")], env: { PATH: process.env.PATH ?? "" } };

describe("s05 MCP mail source", () => {
  test("lists sent mail through a stdio MCP server's read tool", async () => {
    const conn = await connectMcp("gmail", server);
    try {
      const src = new McpMailSource({ caller: conn.caller, tool: "search_emails", args: { query: "in:sent" }, limitArg: "maxResults" });
      const got = await src.listSent({ limit: 1 });
      expect(got).toEqual([{ id: "s1", to: ["anna@northzone.com"], subject: "Acme seed round: Northzone", body: "Hi Anna,\n\nShort one.\n\nMuhammad", sentAt: Date.parse("2026-10-01T09:00:00Z") }]);
    } finally {
      await conn.close();
    }
  }, 20_000);

  test("the direct MCP path refuses side-effect tools", async () => {
    const conn = await connectMcp("gmail", server);
    try {
      await expect(conn.caller.callTool("send_email", { to: "a@b.com" })).rejects.toThrow(/read-only/);
    } finally {
      await conn.close();
    }
  }, 20_000);
});
