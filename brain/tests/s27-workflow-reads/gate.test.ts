// s27: a read step is read-only, enforced in the gate. In mode "read" anything that is not an allowlisted read is
// denied before any other rule, whatever approval or auto-run the run holds; a reader that tries to write is refused,
// its call never runs, no other method is tried for it, and nothing reaches the live items.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computerPolicies } from "../../src/connectors/computer/executor.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import { createGate, READ_ONLY_WORDS } from "../../src/workflows/gate.ts";
import { activeMetricsWorkflow, COMPOSIO_READ_TOOL, FakeReader, MCP_READ_TOOL, SOURCE_TARGET, world, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const SCREEN = `computer_${SOURCE_TARGET.replace(/-/g, "_")}`;

function readGate(o: { autoRun?: boolean; token?: string } = {}) {
  const batch = makeBatch("wf_test", "live", [{ key: "row-1", to: "row-1", subject: "s", body: "b", warnings: [], commit: { verb: "save", fields: [["Week", "43"]] } }], 1);
  const policies = [
    ...computerPolicies([SOURCE_TARGET]),
    { connector: SOURCE_TARGET, flavor: "api" as const, tool: "query_metrics", role: "read" as const, verified: false, server: "posthog" },
  ];
  return createGate({
    workflowId: "wf_test",
    mode: "read",
    batch,
    autoRun: o.autoRun ?? false,
    runToken: o.token ?? null,
    approvals: () => (o.token === undefined ? undefined : { token: o.token, approvedAt: 1 }),
    servers: { gmail: ["gmail"], composio_cli: ["google-sheets", "gmail"], [SCREEN]: [SOURCE_TARGET], posthog: [SOURCE_TARGET] },
    policies,
    actions: [{ role: "send", connector: SOURCE_TARGET, method: "computer" }, { role: "send", connector: "gmail" }],
  });
}

describe("s27 read gate", () => {
  test("GATE: mode read allows allowlisted reads only: screen read, a connector's read tool, a catalog read", () => {
    const g = readGate();
    expect(g.decide(`mcp__${SCREEN}__read`, { member: "read_ui" }, true).allow).toBe(true);
    expect(g.decide("mcp__posthog__query_metrics", {}, true).allow).toBe(true);
    expect(g.decide("mcp__gmail__search_emails", { query: "x" }, true).allow).toBe(true);
  });

  test("GATE: mode read denies every write: a send, a sheet append, a draft, a screen input, a screen commit and any unknown tool, even with an approval token and auto-run on", () => {
    for (const g of [readGate(), readGate({ autoRun: true, token: "t".repeat(43) })]) {
      const writes: Array<[string, Record<string, unknown>]> = [
        ["mcp__gmail__send_email", { to: "a@b.co", subject: "s", body: "b" }],
        ["mcp__composio_cli__GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", { spreadsheet_id: "x", range: "A1", values: [["1"]] }],
        ["mcp__composio_cli__GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "a@b.co", subject: "s", body: "b" }],
        [`mcp__${SCREEN}__input`, { member: "type" }],
        [`mcp__${SCREEN}__commit`, { app: SOURCE_TARGET, verb: "save", fields: [["week", "43"]] }],
        ["mcp__posthog__update_insight", { id: 1 }],
        ["Bash", { command: "ls" }],
      ];
      for (const [tool, input] of writes) {
        const d = g.decide(tool, input, true);
        expect(d.allow).toBe(false);
        if (tool !== "Bash") expect(d.reason).toBe(READ_ONLY_WORDS);
      }
      expect(g.done.get("send")!.size).toBe(0);
    }
  });

  test("GATE: a reader that tries to write is refused: its call never runs, the next method is not tried, nothing reaches the items", async () => {
    w = world();
    const { id, dir } = await activeMetricsWorkflow(w);
    w.mcpReader.tool = "mcp__posthog__update_insight";
    w.mcpReader.input = { id: 7, name: "changed" };
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/PostHog/);
    expect(r.body.message).toMatch(/only reads/);
    expect(w.mcpReader.ran).toBe(1); // the dry run's good read before the reader turned bad; the write never ran
    expect(w.composioReader.calls).toBe(0);
    const log = readFileSync(join(dir, "gate-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.mode === "read");
    const refused = log.filter((l) => l.decision === "deny");
    expect(refused.map((l) => l.tool)).toEqual(["mcp__posthog__update_insight"]);
    expect(refused[0].reason).toBe(READ_ONLY_WORDS);
    expect(w.driver.pressed).toHaveLength(0);
  });

  test("GATE: a screen reader that asks to press a control on the dashboard is refused and nothing is clicked", async () => {
    const commit = new FakeReader(() => "Week 43", `mcp__${SCREEN}__commit`, { app: SOURCE_TARGET, verb: "save", fields: [] });
    w = world({ mcp: "none", composio: "none", readers: { computer: commit } });
    const { id } = await activeMetricsWorkflow(w);
    const r = await w.call(`/workflows/${id}/dry-run`, "POST", { limit: 1 });
    expect(r.body.read.status).toBe("refused");
    expect(r.body.read.message).toMatch(/only reads/);
    expect(commit.ran).toBe(0);
    expect(w.driver.touches()).toBe(0);
  });

  test("GATE: a Composio read is allowed through the read gate; a Composio write slug offered by the same reader is not", async () => {
    w = world({ mcp: "none" });
    const { id } = await activeMetricsWorkflow(w);
    expect((await w.call(`/workflows/${id}/dry-run`, "POST", { limit: 1 })).body.read).toMatchObject({ status: "fetched", via: "composio" });
    w.composioReader.tool = "mcp__composio_cli__GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND";
    const ran = w.composioReader.ran;
    const r = await w.call(`/workflows/${id}/dry-run`, "POST", { limit: 1 });
    expect(r.body.read.status).toBe("refused");
    expect(w.composioReader.ran).toBe(ran);
    expect(COMPOSIO_READ_TOOL).toMatch(/^mcp__composio_cli__/);
    expect(MCP_READ_TOOL).toMatch(/^mcp__posthog__/);
  });
});
