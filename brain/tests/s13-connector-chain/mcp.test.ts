// s13 MCP: the mcp method's probe. A real MCP tools/list against a local stdio fixture server (no network, no account),
// a time limit, unknown tools never counted, missing sign-in setting skipped.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpProbe, SdkMcpLister } from "../../src/connectors/mcp-probe.ts";
import { catalogTarget } from "../../src/connectors/targets.ts";
import { FakeLister, GMAIL_STDIO, resolver, tempHome, writeConfig } from "./setup.ts";

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-server.ts");
const gmail = () => catalogTarget("gmail")!;
const probe = (lister: FakeLister | SdkMcpLister, env: Record<string, string> = { GMAIL_OAUTH_PATH: "/tmp/c.json" }, timeoutMs = 1000) => new McpProbe().probe(gmail(), resolver(home, { mcp: lister as FakeLister, env, timeoutMs }).r.deps);

describe("s13 mcp probe", () => {
  test("MCP: capabilities are the allowlisted tools the server really lists; unknown tools never count", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    const lister = new FakeLister(() => ["send_email", "search_emails", "delete_everything", "GMAIL_SEND_EMAIL"]);
    const r = await probe(lister);
    expect(r).toMatchObject({ health: "ok", code: "ok", reads: ["mail.search"], writes: ["mail.send"] });
    expect(r.tools).toEqual({ "mail.send": "mcp__gmail__send_email", "mail.search": "mcp__gmail__search_emails" });
    expect(r.info).toEqual({ server: "gmail" });
    // The server's command got the resolved env var, nothing else from the brain.
    expect(lister.calls[0]!.server).toMatchObject({ type: "stdio", command: "npx", env: { GMAIL_OAUTH_PATH: "/tmp/c.json" } });
    expect(lister.calls[0]!.timeoutMs).toBe(1000);
  });

  test("MCP: a server that lists none of the allowlisted tools fails closed", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    expect(await probe(new FakeLister(() => ["send", "mail_send_v2"]))).toMatchObject({ health: "failed", code: "no_allowlisted_tools", reason: "It does not offer any action Offload can use." });
  });

  test("MCP: no server -> skipped no_server; env var missing -> skipped missing_env (nothing is spawned)", async () => {
    const lister = new FakeLister(() => ["send_email"]);
    expect(await probe(lister)).toMatchObject({ health: "skipped", code: "no_server" });
    writeConfig(home, { servers: GMAIL_STDIO });
    expect(await probe(lister, {})).toMatchObject({ health: "skipped", code: "missing_env", reason: "Its sign-in setting is not set yet." });
    expect(lister.calls).toHaveLength(0);
  });

  test("MCP: a lister that times out or throws makes the method failed with a plain reason", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    expect(await probe(new FakeLister(() => Promise.reject(new Error("timeout"))))).toMatchObject({ health: "failed", code: "timeout", reason: "The connector on this Mac did not answer in time." });
    expect(await probe(new FakeLister(() => Promise.reject(new Error("spawn npx ENOENT"))))).toMatchObject({ health: "failed", code: "error" });
  });

  test("MCP: a real tools/list against a local stdio MCP server lists its tools", async () => {
    const names = await new SdkMcpLister().listTools("fixture", { type: "stdio", command: process.execPath, args: [FIXTURE], env: { PATH: process.env.PATH ?? "", FIXTURE_TOOLS: "send_email,search_emails,weird_tool" } }, 10_000);
    expect(names.sort()).toEqual(["search_emails", "send_email", "weird_tool"]);
  });

  test("MCP: the probe end to end against the real local server: ok with the allowlisted subset", async () => {
    writeConfig(home, { servers: { gmail: { type: "stdio", command: process.execPath, args: [FIXTURE], envFromEnv: { FIXTURE_TOOLS: "TOOLS" }, catalog: ["gmail"] } } });
    const r = await new McpProbe().probe(gmail(), resolver(home, { mcp: new SdkMcpLister() as unknown as FakeLister, env: { TOOLS: "send_email,read_email,weird_tool", PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 }).r.deps);
    expect(r).toMatchObject({ health: "ok", reads: ["mail.read"], writes: ["mail.send"] });
  });

  test("MCP: a server that never answers is cut off at the time limit", async () => {
    const t0 = Date.now();
    await expect(new SdkMcpLister().listTools("hang", { type: "stdio", command: process.execPath, args: [FIXTURE, "--hang"], env: { PATH: process.env.PATH ?? "" } }, 600)).rejects.toThrow("timeout");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
