// s13 FALLBACK: one gate and one item journal for the whole chain. MCP fails mid-batch -> the Composio retry sends
// only items never attempted (no double send); unknown is never retried; the contacted ledger has every attempted
// address; refusals do not fall back; the chain decision moves to the next method with the last error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toChainDTO } from "../../src/connectors/chain.ts";
import { COMPOSIO_CLI_SERVER, ComposioCliExecutor } from "../../src/connectors/composio.ts";
import { catalogTarget } from "../../src/connectors/targets.ts";
import { addressHash } from "../../src/workflows/autorun.ts";
import { buildChain, ChainExecutor } from "../../src/workflows/chain-executor.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import type { ExecJob, ExecResult, Executor } from "../../src/workflows/executor.ts";
import { approveBatch, executeBatch, ledgerPath, prepareLiveBatch } from "../../src/workflows/runner.ts";
import { NOW, world, writeRecipients, type World } from "../s05-workflows/setup.ts";
import { composioCli, FakeLister, fail, GMAIL_STDIO, missing, resolver, writeConfig } from "./setup.ts";

const SEND = "mcp__gmail__send_email";
const SIG = { signal: new AbortController().signal };
const ROWS = ["anna@northzone.com,Anna,Berg,Northzone,", "leo@hustlefund.vc,Leo,Park,Hustle Fund,", "tom@seedcamp.com,Tom,Reid,Seedcamp,"];
const exact = (job: ExecJob, k: string) => {
  const i = job.batch.items.find((x) => x.key === k)!;
  return { to: i.to, subject: i.subject, body: i.body };
};

let w: World;
const mcpSent: string[] = [];
beforeEach(async () => {
  w = await world();
  mcpSent.length = 0;
  writeRecipients(w.home, w.outreach.id, ROWS);
  const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 2, now: () => NOW });
  approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 1);
});
afterEach(() => w.cleanup());

const live = async () => {
  const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 10 });
  const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
  return { b, token };
};

/** The Gmail MCP server sends the first item, then the transport dies on the second call (after the gate allowed it). */
class McpDiesMidBatch implements Executor {
  calls = 0;
  async execute(job: ExecJob): Promise<ExecResult> {
    const keys = job.batch.items.map((i) => i.key).filter((k) => job.only?.has(k) ?? true);
    this.calls += 1;
    const first = keys[0]!;
    const a = job.gate.check(SEND, exact(job, first));
    if (a.result.behavior === "allow") {
      mcpSent.push(first);
      job.onToolResult?.({ tool: SEND, input: exact(job, first), allowed: true, ok: true, itemKey: first, role: "send" });
    }
    const second = keys[1]!;
    const b = await job.gate.canUseTool(SEND, exact(job, second), SIG);
    if (b.behavior === "allow") job.onToolResult?.({ tool: SEND, input: exact(job, second), allowed: true, ok: false, itemKey: second, role: "send", error: "MCP error -32000: Connection closed" });
    throw new Error("MCP error -32000: Connection closed");
  }
}

const servers = { gmail: ["gmail"], [COMPOSIO_CLI_SERVER]: ["gmail"] };

describe("s13 fallback: no double send", () => {
  test("FALLBACK: MCP dies mid-batch -> Composio sends only the never-attempted item; the unknown one is not retried", async () => {
    const { b, token } = await live();
    const runner = composioCli();
    const mcp = new McpDiesMidBatch();
    const chain = new ChainExecutor([
      { method: "mcp", executor: mcp },
      { method: "composio", executor: new ComposioCliExecutor({ runner, env: {}, accounts: { gmail: "gmail_live-one" } }) },
    ]);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: chain, servers, now: () => NOW + 12 });
    const [a, l, t] = ["anna@northzone.com", "leo@hustlefund.vc", "tom@seedcamp.com"];
    expect(mcpSent).toEqual([a]);
    const composioSends = runner.calls.filter((c) => c.argv[1] === "execute").map((c) => (JSON.parse(c.argv[4]!) as { recipient_email: string }).recipient_email);
    expect(composioSends).toEqual([t]);
    expect(out.itemStates?.[a]?.state).toBe("sent");
    expect(out.itemStates?.[l]?.state).toBe("unknown");
    expect(out.itemStates?.[t]?.state).toBe("sent");
    expect(out.state).toBe("partial");
    expect(chain.attempts).toEqual([
      { method: "mcp", items: [a, l, t], error: "MCP error -32000: Connection closed" },
      { method: "composio", items: [t], error: null },
    ]);
    // Every attempted address is in the contacted ledger (hashes only, no address on disk).
    const ledger = readFileSync(ledgerPath(w.home, w.outreach.id), "utf8");
    for (const k of [a, l, t]) expect(ledger).toContain(`contacted ${addressHash(w.outreach.id, k)}`);
    expect(ledger).not.toContain("@");
    // The next batch never picks the unknown or the sent ones.
    writeRecipients(w.home, w.outreach.id, [...ROWS, "mia@x.vc,Mia,Lee,X,"]);
    const next = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 20 });
    expect(next.items.map((i) => i.key)).toEqual(["mia@x.vc"]);
  });

  test("FALLBACK: a method that fails before any call hands every item to the next; nothing is consumed twice", async () => {
    const { b, token } = await live();
    const runner = composioCli({ "--version": missing });
    const second = composioCli();
    const chain = new ChainExecutor([
      { method: "composio", executor: new ComposioCliExecutor({ runner, env: {}, accounts: { gmail: "g" } }) },
      { method: "api", executor: new ComposioCliExecutor({ runner: second, env: {}, accounts: { gmail: "g" } }) },
    ]);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: chain, servers, now: () => NOW + 12 });
    expect(runner.calls.filter((c) => c.argv[1] === "execute")).toHaveLength(0);
    expect(second.calls.filter((c) => c.argv[1] === "execute")).toHaveLength(3);
    expect(Object.values(out.itemStates ?? {}).map((s) => s.state)).toEqual(["sent", "sent", "sent"]);
  });

  test("FALLBACK: refusals are policy, not health: a method whose calls are denied does not fall back", async () => {
    const { b, token } = await live();
    let nextRan = false;
    const denied: Executor = {
      async execute(job) {
        for (const i of job.batch.items) job.gate.check(SEND, { to: i.to, subject: `${i.subject} (edited)`, body: i.body });
        return { toolCalls: [], text: "" };
      },
    };
    const chain = new ChainExecutor([
      { method: "mcp", executor: denied },
      { method: "composio", executor: { execute: async () => ((nextRan = true), { toolCalls: [], text: "" }) } },
    ]);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: chain, servers, now: () => NOW + 12 });
    expect(nextRan).toBe(false);
    expect(Object.values(out.itemStates ?? {}).every((s) => s.state === "failed_before_send")).toBe(true);
  });

  test("FALLBACK: when every method fails the batch ends without a double send and the error is recorded", async () => {
    const { b, token } = await live();
    const chain = new ChainExecutor([
      { method: "mcp", executor: new McpDiesMidBatch() },
      { method: "composio", executor: new ComposioCliExecutor({ runner: composioCli({ execute: fail(1) }), env: {}, accounts: { gmail: "g" } }) },
    ]);
    const out = await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: chain, servers, now: () => NOW + 12 });
    const states = Object.fromEntries(Object.entries(out.itemStates ?? {}).map(([k, v]) => [k, v.state]));
    expect(states).toEqual({ "anna@northzone.com": "sent", "leo@hustlefund.vc": "unknown", "tom@seedcamp.com": "unknown" });
    expect(out.results.some((r) => r.tool === "executor")).toBe(true);
  });

  test("FALLBACK: without an approval no method runs a single call", async () => {
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 10 });
    const runner = composioCli();
    const chain = new ChainExecutor([{ method: "composio", executor: new ComposioCliExecutor({ runner, env: {}, accounts: { gmail: "g" } }) }]);
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token: null, executor: chain, servers, now: () => NOW + 12 });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("s13 fallback: the chain build", () => {
  test("FALLBACK: buildChain orders the healthy methods, binds their servers, and a run failure moves the decision", async () => {
    writeConfig(w.home, { servers: GMAIL_STDIO });
    const { r } = resolver(w.home, { mcp: new FakeLister(() => ["send_email", "search_emails"]) });
    const mcp = new McpDiesMidBatch();
    const build = (await buildChain({ home: w.home, env: { GMAIL_OAUTH_PATH: "/tmp/c.json" }, resolver: r, config: null, actions: [{ role: "send", connector: "gmail" }], mcpExecutor: mcp }))!;
    // config null: the mcp step cannot resolve servers, so only Composio is built.
    expect(build.methods).toEqual(["composio"]);
    const { loadConnectorsConfig } = await import("../../src/connectors/config.ts");
    const full = (await buildChain({ home: w.home, env: { GMAIL_OAUTH_PATH: "/tmp/c.json" }, resolver: r, config: loadConnectorsConfig(w.home).config, actions: [{ role: "send", connector: "gmail" }], mcpExecutor: mcp, executors: { composio: new ComposioCliExecutor({ runner: composioCli(), env: {}, accounts: { gmail: "gmail_live-one" } }) } }))!;
    expect(full.methods).toEqual(["mcp", "composio"]);
    expect(full.servers).toEqual({ gmail: ["gmail"], [COMPOSIO_CLI_SERVER]: ["gmail"] });
    expect(Object.keys(full.mcpServers)).toEqual(["gmail"]);
    const { b, token } = await live();
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: full.executor, mcpServers: full.mcpServers, servers: full.servers, policies: full.policies, now: () => NOW + 12 });
    const dto = toChainDTO(catalogTarget("gmail")!, r.peek("gmail")!, false);
    expect(dto.method).toBe("composio");
    expect(dto.methods[0]).toMatchObject({ method: "mcp", health: "failed", code: "run_failed" });
    expect(dto.lastError).toContain("Connection closed");
  });
});
