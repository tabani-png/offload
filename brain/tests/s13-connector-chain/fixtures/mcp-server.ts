// A local stdio MCP server for the s13 MCP probe tests: it lists tools and never sends anything (no tool does work).
// `--hang` makes it read stdin and never answer (the probe must time out).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (process.argv.includes("--hang")) {
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  const names = (process.env.FIXTURE_TOOLS ?? "send_email,search_emails,weird_tool").split(",");
  const server = new McpServer({ name: "s13-fixture", version: "1" });
  for (const n of names) server.registerTool(n, { description: `fixture ${n}` }, async () => ({ content: [{ type: "text", text: "fixture: nothing done" }] }));
  await server.connect(new StdioServerTransport());
}
