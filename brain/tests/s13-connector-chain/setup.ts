// Shared s13 setup: fake runner / MCP lister / fetch / secrets (nothing real is spawned, fetched or read), recorded
// Composio CLI output (captured read-only on 2026-10-25 with composio 0.4.2, trimmed, ids replaced), and a gate over
// an approved live batch built without the runner.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { chainDeps, ChainResolver, type ChainDeps, type MethodProbe } from "../../src/connectors/chain.ts";
import type { ComputerProbe } from "../../src/connectors/computer/probe.ts";
import type { LinkRunResult } from "../../src/connectors/link.ts";
import type { McpLister } from "../../src/connectors/mcp-probe.ts";
import { SecretUnavailable, type SecretReader, type SecretRef } from "../../src/connectors/secrets.ts";
import type { Method } from "../../src/connectors/link.ts";
import type { ToolPolicy } from "../../src/workflows/allowlist.ts";
import { makeBatch, type Batch, type BatchItem, type ItemState } from "../../src/workflows/batch.ts";
import { createGate, type Gate, type GateAction, type GateDecisionLog } from "../../src/workflows/gate.ts";
import { tempHome } from "../helpers.ts";
import { FakeRunner, ok } from "../s10e-ui-round4/setup.ts";

export { FakeRunner, ok, tempHome };
export { BANNED_RE } from "../s10e-ui-round4/setup.ts";

export const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
export const SECRET = "s3cr3t-VALUE-never-shown-0123456789";

export const fail = (code = 1, stdout = "", stderr = ""): LinkRunResult => ({ code, stdout, stderr, timedOut: false });
export const missing: LinkRunResult = { code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" };
export const timedOut: LinkRunResult = { code: null, stdout: "", stderr: "", timedOut: true };

// ---------- recorded Composio CLI output ----------

export const GMAIL_TOOLS = JSON.stringify([
  { slug: "GMAIL_BATCH_DELETE_MESSAGES", name: "Batch delete Gmail messages", tags: ["gmail", "destructiveHint"] },
  { slug: "GMAIL_CREATE_EMAIL_DRAFT", name: "Create email draft", tags: ["important", "createHint"] },
  { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", tags: ["readOnlyHint", "important"] },
  { slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", name: "Fetch message by id", tags: ["readOnlyHint"] },
  { slug: "GMAIL_SEND_EMAIL", name: "Send Email", tags: ["important", "openWorldHint"] },
  { slug: "COMPOSIO_MULTI_EXECUTE_TOOL", name: "Multi execute", tags: [] },
]);

export const connections = (toolkit: string, accounts: Array<{ status: string; word_id: string; permission_group?: string }>) => JSON.stringify({ [toolkit]: accounts });
export const GMAIL_CONNECTIONS = connections("gmail", [
  { status: "EXPIRED", word_id: "gmail_old-one", permission_group: "always_allow" },
  { status: "ACTIVE", word_id: "gmail_live-one", permission_group: "always_allow" },
]);

export const SEARCH_QUICKBOOKS = JSON.stringify({
  results: [{ index: 1, use_case: "QuickBooks", primary_tool_slugs: ["QUICKBOOKS_CREATE_INVOICE"], toolkits: ["quickbooks", "harvest"] }],
  connected_toolkits: [],
});
export const QUICKBOOKS_TOOLS = JSON.stringify([{ slug: "QUICKBOOKS_CREATE_INVOICE", tags: ["createHint"] }, { slug: "QUICKBOOKS_QUERY_ENTITIES", tags: ["readOnlyHint"] }]);

/** A Composio CLI that answers like the real one for Gmail (and QuickBooks through search). */
export function composioCli(over: Partial<Record<string, LinkRunResult | ((argv: readonly string[]) => LinkRunResult)>> = {}): FakeRunner {
  return new FakeRunner((argv) => {
    const key = argv.slice(1, 3).join(" ");
    const o = over[key] ?? over[argv[1] ?? ""];
    if (o !== undefined) return typeof o === "function" ? o(argv) : o;
    if (argv[0] !== "composio") return fail(127);
    if (argv[1] === "--version") return ok("0.4.2\n");
    if (key === "tools list") return ok(argv[3] === "gmail" ? GMAIL_TOOLS : argv[3] === "quickbooks" ? QUICKBOOKS_TOOLS : "");
    if (key === "connections list") return ok(argv[4] === "gmail" ? GMAIL_CONNECTIONS : argv[4] === "quickbooks" ? connections("quickbooks", [{ status: "ACTIVE", word_id: "qb_one", permission_group: "always_allow" }]) : "{}");
    if (argv[1] === "search") return ok(SEARCH_QUICKBOOKS);
    if (argv[1] === "execute") return ok(JSON.stringify({ successful: true, data: { id: "msg_1" } }));
    return fail();
  });
}

// ---------- other fakes ----------

export class FakeLister implements McpLister {
  readonly calls: Array<{ name: string; server: McpServerConfig; timeoutMs: number }> = [];
  constructor(public reply: (name: string) => string[] | Promise<string[]>) {}
  async listTools(name: string, server: McpServerConfig, timeoutMs: number): Promise<string[]> {
    this.calls.push({ name, server, timeoutMs });
    return this.reply(name);
  }
}

export class FakeSecrets implements SecretReader {
  readonly reads: SecretRef[] = [];
  constructor(public values: Record<string, string> = { GMAIL_TOKEN: SECRET }) {}
  async read(ref: SecretRef): Promise<string> {
    this.reads.push(ref);
    const k = "fromEnv" in ref ? ref.fromEnv : `${ref.keychain.service}/${ref.keychain.account}`;
    const v = this.values[k];
    if (v === undefined) throw new SecretUnavailable(`${k} is not set`);
    return v;
  }
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export function fakeFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>): { calls: FetchCall[]; fetch: (url: string, init: RequestInit) => Promise<Response> } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return reply(url, init);
    },
  };
}

export const okComputer = (): ComputerProbe => ({ probe: async () => ({ health: "ok", code: "ok", reason: null, reads: ["screen.read"], writes: ["mail.send"], tools: {}, latencyMs: 0 }) });

/** A resolver with fakes for everything; `probes` replaces methods. */
export function resolver(home: string, o: Partial<ChainDeps> & { probes?: Map<Method, MethodProbe> } = {}): { r: ChainResolver; clock: { now: number }; runner: FakeRunner; lister: FakeLister; logs: string[] } {
  const clock = { now: NOW };
  const runner = (o.runner as FakeRunner | undefined) ?? composioCli();
  const lister = (o.mcp as FakeLister | undefined) ?? new FakeLister(() => ["send_email", "search_emails", "read_email", "unrelated_tool"]);
  const logs: string[] = [];
  const deps = chainDeps({
    home,
    env: o.env ?? { GMAIL_OAUTH_PATH: "/tmp/creds.json" },
    now: () => clock.now,
    simulated: o.simulated ?? false,
    runner,
    mcp: lister,
    fetch: o.fetch ?? (async () => new Response("{}", { status: 200 })),
    secrets: o.secrets ?? new FakeSecrets(),
    computer: o.computer ?? { probe: async () => ({ health: "skipped", code: "computer_off", reason: "Using apps on your screen is off until you turn it on.", reads: [], writes: [], tools: {}, latencyMs: null }) },
    timeoutMs: o.timeoutMs ?? 1000,
    log: (l) => void logs.push(l),
  });
  return { r: new ChainResolver(deps, o.probes), clock, runner, lister, logs };
}

export function writeConfig(home: string, cfg: Record<string, unknown>): void {
  writeFileSync(join(home, "connectors.json"), JSON.stringify({ version: 1, servers: {}, ...cfg }));
}

export const GMAIL_STDIO = { gmail: { type: "stdio", command: "npx", args: ["-y", "gmail-mcp"], envFromEnv: { GMAIL_OAUTH_PATH: "GMAIL_OAUTH_PATH" }, catalog: ["gmail"] } };

export const GMAIL_API = {
  gmail: {
    baseUrl: "https://gmail.googleapis.com",
    auth: { type: "bearer", fromEnv: "GMAIL_TOKEN" },
    health: { method: "GET", path: "/gmail/v1/users/me/profile" },
    operations: {
      "mail.send": {
        operationId: "users.messages.send",
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        role: "send",
        body: "gmail-raw",
        fields: { to: "addresses", subject: "text", body: "text" },
        map: { to: "$item.to", subject: "$item.subject", body: "$item.body" },
      },
      "mail.search": { operationId: "users.messages.list", method: "GET", path: "/gmail/v1/users/me/messages", role: "read", fields: { q: "any" } },
    },
  },
};

// ---------- a gate over an approved live batch ----------

export const ITEM: BatchItem = { key: "anna@northzone.com", to: "anna@northzone.com", subject: "Seed round: Offload", body: "Hi Anna,\n\nShort note.\n\nMuhammad", warnings: [] };
export const ITEM2: BatchItem = { key: "leo@hustlefund.vc", to: "leo@hustlefund.vc", subject: "Seed round: Offload", body: "Hi Leo,\n\nShort note.\n\nMuhammad", warnings: [] };

export interface GateWorld {
  gate: Gate;
  batch: Batch;
  states: Record<string, ItemState>;
  journal: Array<{ key: string; role: string; tool: string }>;
  log: GateDecisionLog[];
}

export function gateWorld(o: { items?: BatchItem[]; mode?: "live" | "dry_run"; approved?: boolean; servers?: Record<string, string[]>; policies?: ToolPolicy[]; actions?: GateAction[] } = {}): GateWorld {
  const batch = makeBatch("wf_test", o.mode === "dry_run" ? "dry_run" : "live", o.items ?? [ITEM, ITEM2], NOW);
  const states: Record<string, ItemState> = Object.fromEntries(batch.items.map((i) => [i.key, "pending" as ItemState]));
  const journal: GateWorld["journal"] = [];
  const log: GateDecisionLog[] = [];
  const approved = o.approved !== false;
  const gate = createGate({
    workflowId: "wf_test",
    mode: o.mode ?? "live",
    batch,
    autoRun: false,
    runToken: approved ? "tok" : null,
    approvals: (h) => (approved && h === batch.hash ? { token: "tok", approvedAt: NOW } : undefined),
    servers: o.servers ?? { gmail: ["gmail"] },
    ...(o.policies === undefined ? {} : { policies: o.policies }),
    actions: o.actions ?? [{ role: "send", connector: "gmail" }],
    itemState: (k) => states[k],
    onAllow: (k, role, tool) => {
      journal.push({ key: k, role, tool });
      if (role === "send") states[k] = "sending";
    },
    log: (d) => void log.push(d),
    now: () => NOW,
  });
  return { gate, batch, states, journal, log };
}
