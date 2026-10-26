import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import contract from "../../src/modules/workers/cma-contract.json" with { type: "json" };
import { CMA_BETA, disabledManagedAgents, managedAgentsFromEnv } from "../../src/modules/workers/managed-agents.ts";
import { FakeManagedAgents } from "../../src/modules/workers/fake-managed-agents.ts";

const CONTROL = join(import.meta.dir, "../..");
const SDK = join(CONTROL, "node_modules/@anthropic-ai/sdk");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The body of `export interface <name> {...}` in a .d.ts, comments removed. */
function iface(dts: string, name: string): string {
  const src = readFileSync(join(SDK, dts), "utf8");
  const start = src.indexOf(`export interface ${name} `);
  if (start < 0) throw new Error(`${name} not in ${dts}`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(from, i + 1).replace(/\/\*\*[\s\S]*?\*\//g, "");
}

describe("HERMETIC", () => {
  test("HERMETIC: no Anthropic client is constructed outside workers/managed-agents.ts", () => {
    const files = [...walk(join(CONTROL, "src")), ...walk(join(CONTROL, "tests"))].filter((f) => f.endsWith(".ts"));
    const hits = files.filter((f) => readFileSync(f, "utf8").includes("new Anthropic" + "(")).map((f) => f.slice(CONTROL.length + 1));
    expect(hits).toEqual(["src/modules/workers/managed-agents.ts"]);
  });

  test("HERMETIC: OFFLOAD_CMA_REAL is not set while tests run, and nothing in tests sets it", () => {
    expect(process.env.OFFLOAD_CMA_REAL).toBeUndefined();
    const setters = walk(join(CONTROL, "tests")).filter(
      (f) => f.endsWith(".ts") && readFileSync(f, "utf8").split("\n").some((l) => /OFFLOAD_CMA_REAL\s*[:=]/.test(l) && !l.includes("// allowed:")),
    );
    expect(setters).toEqual([]);
  });

  test("HERMETIC: unless the real flag is 1 and a key is set, the client is the disabled one, which refuses every call", async () => {
    expect(managedAgentsFromEnv({})).toBe(disabledManagedAgents);
    expect(managedAgentsFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(disabledManagedAgents);
    expect(managedAgentsFromEnv({ OFFLOAD_CMA_REAL: "1" })).toBe(disabledManagedAgents); // allowed: a plain object passed to a pure function, process.env untouched
    await expect(disabledManagedAgents.createAgent({ name: "x", model: "m", system: "", mcp_servers: [], tools: [] })).rejects.toThrow(/not configured/);
  });

  test("HERMETIC: the SDK is pinned to 1.3.0 and the lockfile is version 1", () => {
    const pkg = JSON.parse(readFileSync(join(CONTROL, "package.json"), "utf8"));
    expect(pkg.dependencies["@anthropic-ai/sdk"]).toBe("1.3.0");
    expect(JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")).version).toBe("1.3.0");
    expect(readFileSync(join(CONTROL, "bun.lock"), "utf8")).toMatch(/"lockfileVersion": 1,/);
  });

  test("HERMETIC: every endpoint of the recorded contract is a real SDK 1.3.0 route with that method", () => {
    for (const ep of contract.endpoints) {
      const js = readFileSync(join(SDK, ep.js), "utf8");
      const verb = ep.method === "GET" ? (ep.op.endsWith(".list") ? "getAPIList" : "get") : ep.method.toLowerCase();
      const tpl = ep.path.replace(/\{id\}/, "${").split("${")[0]!;
      const re = new RegExp(`_client\\.${verb}\\((?:\\(0, path_1\\.path\\) \`|')${tpl.replace(/[/.]/g, "\\$&")}`);
      expect({ op: ep.op, found: re.test(js) }).toEqual({ op: ep.op, found: true });
    }
  });

  test("HERMETIC: every body field and user event field of the contract exists in the SDK's parameter interface", () => {
    for (const ep of contract.endpoints) {
      const body = iface(ep.dts, ep.params);
      for (const f of ep.fields) expect({ op: ep.op, f, ok: new RegExp(`\\b${f}\\??:`).test(body) }).toEqual({ op: ep.op, f, ok: true });
    }
    const { dts, ...events } = contract.userEvents as unknown as { dts: string } & Record<string, { params: string; fields: string[] }>;
    const ue = { dts };
    for (const [type, spec] of Object.entries(events) as Array<[string, { params: string; fields: string[] }]>) {
      const body = iface(ue.dts, spec.params);
      expect(body).toContain(`type: '${type}'`);
      for (const f of spec.fields) expect({ type, f, ok: new RegExp(`\\b${f}\\??:`).test(body) }).toEqual({ type, f, ok: true });
    }
  });

  test("HERMETIC: the fake refuses requests outside the contract, without the beta header, or with unknown fields", async () => {
    const fake = new FakeManagedAgents();
    const call = (path: string, init: RequestInit) => fake.fetch(`http://cma.fake${path}`, init);
    const h = { "x-api-key": "k", "anthropic-beta": CMA_BETA, "content-type": "application/json" };
    expect((await call("/v1/messages", { method: "POST", headers: h, body: "{}" })).status).toBe(400);
    expect((await call("/v1/agents", { method: "POST", headers: { "x-api-key": "k" }, body: JSON.stringify({ name: "a", model: "m" }) })).status).toBe(400);
    expect((await call("/v1/agents", { method: "POST", headers: h, body: JSON.stringify({ name: "a", model: "m", commit_tool: true }) })).status).toBe(400);
    expect((await call("/v1/agents", { method: "POST", headers: h, body: JSON.stringify({ name: "a" }) })).status).toBe(400);
    expect((await call("/v1/agents", { method: "POST", headers: h, body: JSON.stringify({ name: "a", model: "m" }) })).status).toBe(200);
    expect(fake.violations).toHaveLength(4);
  });

  test("HERMETIC: requests made through the real SDK carry the managed-agents beta header and pass the contract", async () => {
    const fake = new FakeManagedAgents();
    const api = fake.api();
    const env = await api.createEnvironment({ name: "e", config: { type: "cloud", networking: { type: "limited", allowed_hosts: [], allow_mcp_servers: true, allow_package_managers: false } } });
    const s = await api.createSession({ agent: { type: "agent", id: "agent_1", version: 1 }, environment_id: env.id, vault_ids: [], budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } } });
    await api.sendEvents(s.id, [{ type: "user.interrupt" }]);
    expect(fake.violations).toEqual([]);
    expect(fake.requests.map((r) => r.beta?.includes(CMA_BETA))).toEqual([true, true, true]);
    expect(fake.requests.map((r) => r.op)).toEqual(["environments.create", "sessions.create", "sessions.events.send"]);
  });
});
