// s13 COMPOSIO: discovery, connection status and capabilities from recorded CLI output (fake runner, nothing spawned);
// the probe runs only read-only commands; meta tools never count; the CLI executor goes through the gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPOSIO_CLI_SERVER,
  ComposioCliExecutor,
  ComposioProbe,
  isReadOnlyComposioArgv,
  MethodFailed,
  parseConnections,
  parseJsonOut,
  parseSearchToolkits,
  parseToolsList,
  pickAccount,
  readOnlyRunner,
  toolkitMatches,
} from "../../src/connectors/composio.ts";
import { catalogTarget, targetForProfile } from "../../src/connectors/targets.ts";
import type { ToolCallRecord } from "../../src/workflows/executor.ts";
import { profile } from "../helpers.ts";
import { composioCli, connections, fail, GMAIL_CONNECTIONS, GMAIL_TOOLS, gateWorld, ITEM, missing, ok, resolver, SEARCH_QUICKBOOKS, tempHome, timedOut } from "./setup.ts";

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

const gmail = () => catalogTarget("gmail")!;
const quickbooks = () => targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks Online", host: "" }));

describe("s13 composio: parsing recorded CLI output", () => {
  test("COMPOSIO: tools list, connections list and search parse; ANSI and leading noise are tolerated", () => {
    expect(parseToolsList(GMAIL_TOOLS).map((t) => t.slug)).toContain("GMAIL_SEND_EMAIL");
    expect(parseToolsList("\x1b[2mnote\x1b[22m\n" + GMAIL_TOOLS)).toHaveLength(6);
    expect(parseToolsList("")).toEqual([]);
    expect(parseConnections(GMAIL_CONNECTIONS, "gmail")).toEqual([
      { wordId: "gmail_old-one", status: "EXPIRED", askEveryCall: false },
      { wordId: "gmail_live-one", status: "ACTIVE", askEveryCall: false },
    ]);
    expect(parseSearchToolkits(SEARCH_QUICKBOOKS)).toEqual(["quickbooks", "harvest"]);
    expect(parseJsonOut("not json")).toBeNull();
  });

  test("COMPOSIO: the account is an ACTIVE always_allow one first; ask-every-call only as a fallback; expired never", () => {
    expect(pickAccount([{ wordId: "a", status: "ACTIVE", askEveryCall: true }, { wordId: "b", status: "ACTIVE", askEveryCall: false }])?.wordId).toBe("b");
    expect(pickAccount([{ wordId: "a", status: "ACTIVE", askEveryCall: true }])?.wordId).toBe("a");
    expect(pickAccount([{ wordId: "a", status: "EXPIRED", askEveryCall: false }, { wordId: "c", status: "INACTIVE", askEveryCall: false }])).toBeNull();
  });

  test("COMPOSIO: a search toolkit matches an app only by its own name", () => {
    expect(toolkitMatches("quickbooks", quickbooks())).toBe(true);
    expect(toolkitMatches("harvest", quickbooks())).toBe(false);
    expect(toolkitMatches("qb", quickbooks())).toBe(false);
  });
});

describe("s13 composio: read-only commands", () => {
  test("COMPOSIO: only listing, search, schemas, dry runs and connection status are read-only", () => {
    const yes = [
      ["composio", "--version"],
      ["composio", "whoami"],
      ["composio", "search", "send an email", "--limit", "3"],
      ["composio", "tools", "list", "gmail", "--limit", "1000"],
      ["composio", "connections", "list", "--toolkit", "gmail"],
      ["composio", "link", "gmail", "--list"],
      ["composio", "execute", "GMAIL_SEND_EMAIL", "--get-schema"],
      ["composio", "execute", "GMAIL_FETCH_EMAILS", "--dry-run", "-d", '{"max_results":1}'],
    ];
    const no = [
      ["composio", "execute", "GMAIL_SEND_EMAIL", "-d", "{}"],
      ["composio", "execute", "GMAIL_SEND_EMAIL", "-d", "{}", "--account", "x"],
      ["composio", "execute", "-p", "GMAIL_SEND_EMAIL", "-d", "{}", "--dry-run"],
      ["composio", "execute", "GMAIL_SEND_EMAIL", "--dry-run", "--file", "/etc/passwd"],
      ["composio", "link", "gmail", "--no-browser", "--no-wait"],
      ["composio", "run", "console.log(1)"],
      ["composio", "proxy", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", "--toolkit", "gmail", "-X", "POST"],
      ["composio", "connections", "remove"],
      ["npx", "composio", "search", "x"],
    ];
    for (const a of yes) expect(isReadOnlyComposioArgv(a)).toBe(true);
    for (const a of no) expect(isReadOnlyComposioArgv(a)).toBe(false);
    expect(() => readOnlyRunner(composioCli()).run(["composio", "execute", "GMAIL_SEND_EMAIL", "-d", "{}"], { timeoutMs: 1, env: {} })).toThrow("not read-only");
  });
});

describe("s13 composio probe", () => {
  test("COMPOSIO: gmail: ok with mail.send through GMAIL_SEND_EMAIL; meta tools and unlisted tools never count; only read-only commands ran", async () => {
    const { r, runner } = resolver(home);
    const p = await new ComposioProbe().probe(gmail(), r.deps);
    expect(p).toMatchObject({ health: "ok", code: "ok", reads: ["mail.read", "mail.search"], writes: ["mail.send"], info: { toolkit: "gmail", account: "gmail_live-one" } });
    expect(p.tools["mail.send"]).toBe(`mcp__${COMPOSIO_CLI_SERVER}__GMAIL_SEND_EMAIL`);
    expect(JSON.stringify(p.tools)).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(JSON.stringify(p.tools)).not.toContain("GMAIL_BATCH_DELETE_MESSAGES");
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const c of runner.calls) expect(isReadOnlyComposioArgv(c.argv)).toBe(true);
    // The CLI gets the plain environment only.
    expect(Object.keys(runner.calls[0]!.env).sort()).toEqual(Object.keys(runner.calls[0]!.env).filter((k) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"].includes(k)).sort());
  });

  test("COMPOSIO: not signed in -> skipped not_signed_in; CLI missing -> skipped; timeout -> failed", async () => {
    const notSigned = resolver(home, { runner: composioCli({ "connections list": ok(connections("gmail", [{ status: "EXPIRED", word_id: "x" }])) }) });
    expect(await new ComposioProbe().probe(gmail(), notSigned.r.deps)).toMatchObject({ health: "skipped", code: "not_signed_in", reason: "Gmail is not signed in to Composio yet." });
    expect(await new ComposioProbe().probe(gmail(), resolver(home, { runner: composioCli({ "tools list": missing }) }).r.deps)).toMatchObject({ health: "skipped", code: "composio_missing" });
    expect(await new ComposioProbe().probe(gmail(), resolver(home, { runner: composioCli({ "tools list": timedOut }) }).r.deps)).toMatchObject({ health: "failed", code: "timeout" });
  });

  test("COMPOSIO: an account that asks before every call is used for reads only (a send must never hang on a prompt)", async () => {
    const asks = resolver(home, { runner: composioCli({ "connections list": ok(connections("gmail", [{ status: "ACTIVE", word_id: "g1", permission_group: "ask_every_call" }])) }) });
    const p = await new ComposioProbe().probe(gmail(), asks.r.deps);
    expect(p).toMatchObject({ health: "ok", code: "reads_only", writes: [], reason: "Composio asks before every action on this account, so Offload only reads through it." });
    expect(p.tools["mail.send"]).toBeUndefined();
  });

  test("COMPOSIO: an app the catalog does not know is found through search; with no allowlisted tool it is skipped, never guessed", async () => {
    const { r, runner } = resolver(home);
    const p = await new ComposioProbe().probe(quickbooks(), r.deps);
    expect(p).toMatchObject({ health: "skipped", code: "no_allowlisted_tools", info: { toolkit: "quickbooks", account: "qb_one" } });
    expect(runner.calls.map((c) => c.argv.slice(1, 4).join(" "))).toEqual(["tools list quickbooksonline", "search QuickBooks Online --limit", "tools list quickbooks", "connections list --toolkit"]);
    const none = resolver(home, { runner: composioCli({ search: ok(JSON.stringify({ results: [] })) }) });
    expect(await new ComposioProbe().probe(quickbooks(), none.r.deps)).toMatchObject({ health: "skipped", code: "no_toolkit", reason: "Composio has no app for QuickBooks Online." });
  });
});

describe("s13 composio CLI executor", () => {
  const exec = (runner = composioCli()) => ({ runner, ex: new ComposioCliExecutor({ runner, env: { PATH: "/usr/bin", OFFLOAD_TOKEN: "x".repeat(40) }, accounts: { gmail: "gmail_live-one" } }) });

  test("COMPOSIO: an approved item is sent with exactly the approved arguments and the chosen account", async () => {
    const w = gateWorld({ servers: { [COMPOSIO_CLI_SERVER]: ["gmail"] } });
    const { runner, ex } = exec();
    const recs: ToolCallRecord[] = [];
    await ex.execute({ batch: w.batch, gate: w.gate, only: new Set([ITEM.key]), onToolResult: (r) => void recs.push(r) });
    const run = runner.calls.filter((c) => c.argv[1] === "execute");
    expect(run).toHaveLength(1);
    expect(run[0]!.argv.slice(0, 4)).toEqual(["composio", "execute", "GMAIL_SEND_EMAIL", "-d"]);
    expect(JSON.parse(run[0]!.argv[4]!)).toEqual({ recipient_email: ITEM.to, subject: ITEM.subject, body: ITEM.body });
    expect(run[0]!.argv.slice(5)).toEqual(["--account", "gmail_live-one"]);
    expect(run[0]!.env.OFFLOAD_TOKEN).toBeUndefined();
    expect(recs).toEqual([expect.objectContaining({ tool: "mcp__composio_cli__GMAIL_SEND_EMAIL", allowed: true, ok: true, itemKey: ITEM.key, role: "send" })]);
    expect(w.journal).toEqual([{ key: ITEM.key, role: "send", tool: "mcp__composio_cli__GMAIL_SEND_EMAIL" }]);
  });

  test("COMPOSIO: without an approval nothing is executed", async () => {
    const w = gateWorld({ approved: false, servers: { [COMPOSIO_CLI_SERVER]: ["gmail"] } });
    const { runner, ex } = exec();
    const out = await ex.execute({ batch: w.batch, gate: w.gate });
    expect(out.toolCalls.every((c) => !c.allowed)).toBe(true);
    expect(runner.calls.filter((c) => c.argv[1] === "execute")).toHaveLength(0);
  });

  test("COMPOSIO: a missing CLI fails the method before any item is used", async () => {
    const w = gateWorld({ servers: { [COMPOSIO_CLI_SERVER]: ["gmail"] } });
    const { ex } = exec(composioCli({ "--version": missing }));
    await expect(ex.execute({ batch: w.batch, gate: w.gate })).rejects.toBeInstanceOf(MethodFailed);
    expect(w.journal).toHaveLength(0);
  });

  test("COMPOSIO: a failed execute records the item as not ok (it may have sent) and stops the method", async () => {
    const w = gateWorld({ servers: { [COMPOSIO_CLI_SERVER]: ["gmail"] } });
    const { runner, ex } = exec(composioCli({ execute: fail(1, JSON.stringify({ successful: false, error: "403" })) }));
    const recs: ToolCallRecord[] = [];
    await expect(ex.execute({ batch: w.batch, gate: w.gate, onToolResult: (r) => void recs.push(r) })).rejects.toBeInstanceOf(MethodFailed);
    expect(recs).toEqual([expect.objectContaining({ allowed: true, ok: false, itemKey: ITEM.key })]);
    // The second item was never attempted.
    expect(runner.calls.filter((c) => c.argv[1] === "execute")).toHaveLength(1);
    expect(w.states[ITEM.key]).toBe("sending");
    expect(w.states["leo@hustlefund.vc"]).toBe("pending");
  });
});
