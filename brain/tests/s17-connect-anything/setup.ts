// Shared s17 setup: a fake Composio CLI that answers from output recorded read-only on this Mac (2026-10-25, composio
// CLI 0.4.2: `dev toolkits list`, `tools list <toolkit>`, `execute <SLUG> --get-schema`; trimmed, nothing executed),
// a synced universe in a temp home, schema records, and a gate over an approved live batch of generic items.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkRunResult } from "../../src/connectors/link.ts";
import { parseSchemaOutput, syncUniverse, type SchemaRecord, type UniverseIndex } from "../../src/connectors/universe.ts";
import { genericCommit, genericPolicy } from "../../src/workflows/generic.ts";
import { makeBatch, type Batch, type BatchItem } from "../../src/workflows/batch.ts";
import { createGate, type Gate, type GateAction, type GateContext } from "../../src/workflows/gate.ts";
import type { ToolPolicy } from "../../src/workflows/allowlist.ts";
import { tempHome as helperHome } from "../helpers.ts";
import { FakeRunner, ok } from "../s10e-ui-round4/setup.ts";

export { FakeRunner, ok };

const cleanups: Array<() => void> = [];
/** A fresh temp home (removed when the test process exits). */
export function tempHome(): string {
  const h = helperHome();
  cleanups.push(h.cleanup);
  return h.home;
}
process.on("exit", () => {
  for (const c of cleanups.splice(0)) c();
});
export { BANNED_RE } from "../s10e-ui-round4/setup.ts";

export const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
export const DAY = 24 * 60 * 60_000;
export const TOKEN = "t".repeat(40);
export const SECRET = "lin_api_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
export const CLI = "composio_cli";

const FX = join(import.meta.dir, "fixtures");
const fx = (f: string) => readFileSync(join(FX, f), "utf8");
export const TOOLKITS_LIST = fx("toolkits-list.json");
export const LINEAR_TOOLS = fx("tools-linear.json");
export const STRIPE_TOOLS = fx("tools-stripe.json");
export const LINEAR_SCHEMA_OUT = fx("schema-LINEAR_CREATE_LINEAR_ISSUE.json");
export const STRIPE_SCHEMA_OUT = fx("schema-STRIPE_CREATE_REFUND.json");
export const COMMENT_SCHEMA_OUT = fx("schema-LINEAR_CREATE_LINEAR_COMMENT.json");

export const fail = (code = 1, stdout = "", stderr = ""): LinkRunResult => ({ code, stdout, stderr, timedOut: false });
export const missing: LinkRunResult = { code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" };

/** Toolkits only a seed query finds (the CLI caps one listing at 1000). */
export const EXTRA_TOOLKIT = JSON.stringify([{ name: "Freshdesk", slug: "freshdesk", description: "Customer support software with ticketing.", latest_version: null, tools_count: 2, triggers_count: 0, is_no_auth: false, enabled: true, connected: null }]);
export const SHOPIFY_TOOLKIT = JSON.stringify([{ name: "Shopify", slug: "shopify", description: "E-commerce platform for online stores: orders, products and customers.", latest_version: null, tools_count: 2, triggers_count: 0, is_no_auth: false, enabled: true, connected: null }]);
export const SHOPIFY_TOOLS = JSON.stringify([
  { slug: "SHOPIFY_GET_ORDER", name: "Get order", description: "Reads one order with its status and tracking.", tags: ["readOnlyHint"] },
  { slug: "SHOPIFY_CREATE_ORDER_NOTE", name: "Add order note", description: "Adds a note to an order.", tags: ["createHint"] },
]);
export const FRESHDESK_TOOLS = JSON.stringify([
  { slug: "FRESHDESK_CREATE_TICKET", name: "Create ticket", description: "Creates a support ticket for a requester.", tags: ["createHint", "openWorldHint"] },
  { slug: "FRESHDESK_LIST_TICKETS", name: "List tickets", description: "Lists tickets.", tags: ["readOnlyHint"] },
]);
export const COMPOSIO_TOOLS = JSON.stringify([
  { slug: "COMPOSIO_MULTI_EXECUTE_TOOL", name: "Multi execute", description: "Runs several tools.", tags: [] },
  { slug: "COMPOSIO_REMOTE_BASH_TOOL", name: "Remote bash", description: "Runs a shell.", tags: [] },
  { slug: "COMPOSIO_SEARCH_TOOLS", name: "Search tools", description: "Finds tools.", tags: ["readOnlyHint"] },
]);
export const GMAIL_TOOLS = JSON.stringify([
  { slug: "GMAIL_SEND_EMAIL", name: "Send Email", description: "Sends an email.", tags: ["important", "openWorldHint"] },
  { slug: "GMAIL_CREATE_EMAIL_DRAFT", name: "Create email draft", description: "Creates a draft.", tags: ["createHint"] },
  { slug: "GMAIL_REPLY_TO_THREAD", name: "Reply to thread", description: "Replies in a thread.", tags: ["createHint"] },
  { slug: "GMAIL_FORWARD_MESSAGE", name: "Forward", description: "Forwards a message.", tags: ["createHint"] },
  { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", description: "Lists emails.", tags: ["readOnlyHint"] },
]);
export const SMALL = (prefix: string) => JSON.stringify([{ slug: `${prefix}_LIST_THINGS`, name: "List", description: "Lists things.", tags: ["readOnlyHint"] }, { slug: `${prefix}_CREATE_THING`, name: "Create", description: "Creates a thing.", tags: ["createHint"] }]);
export const LINEAR_INFO = JSON.stringify({ name: "Linear", slug: "linear", is_no_auth: false, composio_managed_auth_schemes: ["OAUTH2"], auth_modes: ["OAUTH2", "API_KEY"] });
export const ACTIVE = (tk: string, ask = false) => JSON.stringify({ [tk]: [{ status: "ACTIVE", word_id: `${tk}_live-one`, permission_group: ask ? "ask_every_call" : "always_allow" }] });

export interface CliOptions {
  /** argv.slice(1, 3).join(" ") or argv[1] -> reply. */
  over?: Record<string, LinkRunResult | ((argv: readonly string[]) => LinkRunResult)>;
  /** Toolkits whose `tools list` fails. */
  failTools?: string[];
  askEveryCall?: boolean;
}

/** A Composio CLI that answers like the real one, from the recorded output. Never spawns. */
export function universeCli(o: CliOptions = {}): FakeRunner {
  return new FakeRunner((argv) => {
    const key = argv.slice(1, 3).join(" ");
    const hit = o.over?.[key] ?? o.over?.[argv[1] ?? ""];
    if (hit !== undefined) return typeof hit === "function" ? hit(argv) : hit;
    if (argv[0] !== "composio") return fail(127);
    if (argv[1] === "--version") return ok("0.4.2\n");
    if (key === "dev toolkits" && argv[3] === "list") {
      const q = argv.indexOf("--query");
      if (q < 0) return ok(TOOLKITS_LIST);
      return ok(argv[q + 1] === "e" ? EXTRA_TOOLKIT : argv[q + 1] === "o" ? SHOPIFY_TOOLKIT : "[]");
    }
    if (key === "dev toolkits" && argv[3] === "info") return argv[4] === "linear" ? ok(LINEAR_INFO) : ok(JSON.stringify({ slug: argv[4], auth_modes: ["OAUTH2"] }));
    if (key === "tools list") {
      const tk = argv[3] ?? "";
      if (o.failTools?.includes(tk)) return fail(1, "", "network");
      const by: Record<string, string> = { linear: LINEAR_TOOLS, stripe: STRIPE_TOOLS, composio: COMPOSIO_TOOLS, gmail: GMAIL_TOOLS, freshdesk: FRESHDESK_TOOLS, shopify: SHOPIFY_TOOLS, github: SMALL("GITHUB"), notion: SMALL("NOTION"), slack: SMALL("SLACK"), hubspot: SMALL("HUBSPOT") };
      return ok(by[tk] ?? "[]");
    }
    if (key === "execute LINEAR_CREATE_LINEAR_ISSUE" && argv[3] === "--get-schema") return ok(LINEAR_SCHEMA_OUT);
    if (key === "execute STRIPE_CREATE_REFUND" && argv[3] === "--get-schema") return ok(STRIPE_SCHEMA_OUT);
    if (key === "execute LINEAR_CREATE_LINEAR_COMMENT" && argv[3] === "--get-schema") return ok(COMMENT_SCHEMA_OUT);
    if (key === "connections list") return ok(ACTIVE(argv[4] ?? "", o.askEveryCall === true));
    if (argv[1] === "link" && argv.includes("--list")) return ok("linear  ACTIVE\n");
    if (argv[1] === "link") return ok("Open https://connect.composio.dev/link/ln_test to sign in\n");
    if (argv[1] === "execute") return ok(JSON.stringify({ successful: true, data: { id: "obj_1" } }));
    return fail();
  });
}

/** A temp home with the universe synced from the recorded CLI output. */
export async function syncedHome(o: CliOptions = {}): Promise<{ home: string; runner: FakeRunner; index: UniverseIndex }> {
  const home = tempHome();
  const runner = universeCli(o);
  const r = await syncUniverse({ home, runner, env: { PATH: "/usr/bin", HOME: home }, now: () => NOW, seeds: ["e", "o"], concurrency: 2 });
  return { home, runner, index: r.index };
}

export const LINEAR_RECORD: SchemaRecord = parseSchemaOutput(LINEAR_SCHEMA_OUT, NOW)!;
export const STRIPE_RECORD: SchemaRecord = parseSchemaOutput(STRIPE_SCHEMA_OUT, NOW)!;

export const ISSUE_ARGS = { team_id: "9cfb482a-81e3-4154-b5b9-2c805e70a02d", title: "Refund for order 1042", description: "Customer asked for a refund.\r\nSee ticket.", priority: 2, label_ids: ["l-1", "l-2"] };
export const REFUND_ARGS = { charge: "ch_3PqTest", amount: 4200, reason: "requested_by_customer", metadata: { order: "1042" } };

/** One generic item: `to` is the item key (no recipient), the commit carries the schema hash and the full arguments. */
export function genericItem(record: SchemaRecord, args: Record<string, unknown>, key = "issue-1"): BatchItem {
  const c = genericCommit(record, args);
  if ("reason" in c) throw new Error(c.reason);
  return { key, to: key, subject: `${record.slug} for ${key}`, body: "", warnings: [], commit: c.commit };
}

export interface GateWorld {
  gate: Gate;
  batch: Batch;
  policies: ToolPolicy[];
}

/** A gate over an approved live batch of generic items, connection tk-linear (and tk-stripe) through the CLI server. */
export function genericGate(items: BatchItem[], o: Partial<GateContext> & { records?: SchemaRecord[]; kind?: "live" | "dry_run"; actions?: GateAction[] } = {}): GateWorld {
  const batch = makeBatch("wf_generic", o.kind ?? "live", items, NOW);
  const policies = (o.records ?? [LINEAR_RECORD, STRIPE_RECORD]).map((r) => genericPolicy(r, r.slug.startsWith("STRIPE") ? "tk-stripe" : "tk-linear"));
  const gate = createGate({
    workflowId: "wf_generic",
    mode: "live",
    batch,
    autoRun: false,
    runToken: TOKEN,
    approvals: (h) => (h === batch.hash ? { token: TOKEN, approvedAt: NOW } : undefined),
    servers: { [CLI]: ["tk-linear", "tk-stripe", "gmail", "hubspot"] },
    policies,
    actions: o.actions ?? [
      { role: "send", connector: "tk-linear" },
      { role: "send", connector: "tk-stripe" },
    ],
    ...o,
  });
  return { gate, batch, policies };
}

export const tool = (slug: string) => `mcp__${CLI}__${slug}`;
