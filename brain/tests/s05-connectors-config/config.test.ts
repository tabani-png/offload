// s05 AC-1: $OFFLOAD_HOME/connectors.json maps MCP servers to catalog ids. Secrets are named by env var only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogStatus, loadConnectorsConfig, parseConnectorsConfig, toMcpServers } from "../../src/connectors/config.ts";
import { tempHome } from "../helpers.ts";

const GOOD = {
  version: 1,
  servers: {
    composio: { type: "http", url: "https://mcp.composio.dev/composio/server/2f0c1d3e-1111-4222-8333-944455556666/mcp", headersFromEnv: { "x-api-key": "COMPOSIO_API_KEY" }, catalog: ["gmail", "google-calendar", "google-sheets"] },
    gmail: { type: "stdio", command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"], envFromEnv: { GMAIL_OAUTH_PATH: "GMAIL_OAUTH_PATH" }, catalog: ["gmail"] },
  },
  mail: { server: "gmail", listTool: "search_emails", args: { query: "in:sent" }, limitArg: "maxResults" },
};

let home = "";
let cleanup = () => {};
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

describe("s05 connectors config", () => {
  test("a valid config parses with no errors", () => {
    const r = parseConnectorsConfig(GOOD);
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.config?.servers ?? {})).toEqual(["composio", "gmail"]);
  });

  test("raw env or headers values are rejected", () => {
    const bad = { version: 1, servers: { x: { type: "http", url: "https://a.example/mcp", headers: { authorization: "Bearer abc" }, catalog: ["gmail"] } } };
    expect(parseConnectorsConfig(bad).errors.join(" ")).toContain("raw secrets");
    const bad2 = { version: 1, servers: { x: { type: "stdio", command: "npx", env: { TOKEN: "abc" }, catalog: ["gmail"] } } };
    expect(parseConnectorsConfig(bad2).errors.join(" ")).toContain("raw secrets");
  });

  test("secret-looking strings anywhere are rejected", () => {
    for (const leak of ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "Bearer abcdef", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]) {
      const cfg = { version: 1, servers: { x: { type: "stdio", command: "npx", args: ["--key", leak], catalog: ["gmail"] } } };
      expect(parseConnectorsConfig(cfg).errors.join(" ")).toContain("looks like a secret");
    }
    const q = { version: 1, servers: { x: { type: "http", url: "https://a.example/mcp?api_key=123", catalog: ["gmail"] } } };
    expect(parseConnectorsConfig(q).errors.join(" ")).toContain("looks like a secret");
  });

  test("env var names must be UPPER_SNAKE and catalog ids must exist", () => {
    const cfg = { version: 1, servers: { x: { type: "http", url: "https://a.example/mcp", headersFromEnv: { "x-api-key": "my key" }, catalog: ["fax-machine"] } } };
    const errs = parseConnectorsConfig(cfg).errors.join(" ");
    expect(errs).toContain("env var name");
    expect(errs).toContain("unknown catalog id fax-machine");
  });

  test("plain http is only allowed on loopback", () => {
    const cfg = { version: 1, servers: { x: { type: "http", url: "http://mcp.example.com/mcp", catalog: ["gmail"] } } };
    expect(parseConnectorsConfig(cfg).errors.join(" ")).toContain("https");
    const local = { version: 1, servers: { x: { type: "http", url: "http://127.0.0.1:3000/mcp", catalog: ["gmail"] } } };
    expect(parseConnectorsConfig(local).errors).toEqual([]);
  });

  test("status: connected when every named env var is set, missing_env when not, missing when no server", () => {
    const cfg = parseConnectorsConfig(GOOD).config!;
    const none = catalogStatus(cfg, {});
    expect(none.gmail).toBe("missing_env");
    expect(none.slack).toBe("missing");
    const some = catalogStatus(cfg, { GMAIL_OAUTH_PATH: "/x/creds.json" });
    expect(some.gmail).toBe("connected");
    expect(some["google-calendar"]).toBe("missing_env");
    expect(catalogStatus(null, {}).gmail).toBe("missing");
  });

  test("toMcpServers resolves env values in memory and refuses missing ones", () => {
    const cfg = parseConnectorsConfig(GOOD).config!;
    const servers = toMcpServers(cfg, { COMPOSIO_API_KEY: "k-123", GMAIL_OAUTH_PATH: "/p", PATH: "/usr/bin" });
    expect(servers.composio).toEqual({ type: "http", url: GOOD.servers.composio.url, headers: { "x-api-key": "k-123" } });
    expect(servers.gmail).toMatchObject({ type: "stdio", command: "npx", env: { GMAIL_OAUTH_PATH: "/p", PATH: "/usr/bin" } });
    expect(() => toMcpServers(cfg, {})).toThrow(/COMPOSIO_API_KEY/);
    expect(Object.keys(toMcpServers(cfg, { GMAIL_OAUTH_PATH: "/p" }, ["gmail"]))).toEqual(["gmail"]);
  });

  test("loadConnectorsConfig: missing file is no config and no error; bad JSON is an error", () => {
    expect(loadConnectorsConfig(home)).toEqual({ config: null, errors: [], path: join(home, "connectors.json") });
    writeFileSync(join(home, "connectors.json"), "{nope");
    expect(loadConnectorsConfig(home).errors[0]).toContain("not valid JSON");
    writeFileSync(join(home, "connectors.json"), JSON.stringify(GOOD));
    expect(loadConnectorsConfig(home).config?.mail?.listTool).toBe("search_emails");
  });
});
