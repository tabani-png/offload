// s13 API: the direct-API method. Config without secrets (env var / Keychain references only), secrets read in memory
// and never in logs, errors, DTOs or the cache; OpenAPI reads; a health probe; a gated, deterministic executor.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseApis } from "../../src/connectors/api-config.ts";
import { ApiExecutor, ApiProbe, apiPolicies, apiServer, buildRequest, gmailRaw, mapArgs, openapiReads } from "../../src/connectors/api.ts";
import { chainPath, toChainDTO } from "../../src/connectors/chain.ts";
import { MethodFailed } from "../../src/connectors/composio.ts";
import { loadConnectorsConfig, parseConnectorsConfig } from "../../src/connectors/config.ts";
import { DefaultSecretReader, redact, SecretUnavailable } from "../../src/connectors/secrets.ts";
import { catalogTarget } from "../../src/connectors/targets.ts";
import type { ToolCallRecord } from "../../src/workflows/executor.ts";
import { FakeRunner, FakeSecrets, fakeFetch, GMAIL_API, gateWorld, ITEM, ok, resolver, SECRET, tempHome, writeConfig } from "./setup.ts";

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

const gmail = () => catalogTarget("gmail")!;
const parse = (apis: unknown) => {
  const errors: string[] = [];
  const out = parseApis(apis, errors);
  return { out, errors };
};

describe("s13 api config", () => {
  test("API: a good entry parses: bearer from an env var, a health check, a send with its full schema and sources", () => {
    const { out, errors } = parse(GMAIL_API);
    expect(errors).toEqual([]);
    expect(out.gmail!.auth).toEqual({ type: "bearer", header: null, secret: { fromEnv: "GMAIL_TOKEN" } });
    expect(out.gmail!.operations.map((o) => [o.capability, o.role, o.body])).toEqual([
      ["mail.send", "send", "gmail-raw"],
      ["mail.search", "read", "none"],
    ]);
    expect(parseConnectorsConfig({ version: 1, servers: {}, apis: GMAIL_API }).config?.apis?.gmail?.baseUrl).toBe("https://gmail.googleapis.com");
  });

  test("API: no raw secret anywhere: a token key, a Bearer value, an api_key URL or a long literal are refused", () => {
    const bad = (patch: Record<string, unknown>) => parse({ gmail: { ...GMAIL_API.gmail, ...patch } }).errors;
    expect(bad({ auth: { type: "bearer", token: SECRET } }).join()).toContain("raw secrets are not allowed");
    expect(bad({ auth: { type: "bearer", fromEnv: "lowercase" } }).join()).toContain("env var name");
    expect(bad({ baseUrl: "https://api.x.com/?api_key=abc" }).join()).toContain("looks like it holds a secret");
    expect(bad({ baseUrl: "http://api.x.com" }).join()).toContain("must be https");
    expect(bad({ baseUrl: "https://user:pw@api.x.com" }).join()).toContain("user or password");
    expect(bad({ auth: { type: "header", keychain: { service: "svc" } } }).join()).toContain("keychain needs a service and an account");
    expect(parse({ gmail: { ...GMAIL_API.gmail, baseUrl: "http://127.0.0.1:9000" } }).errors).toEqual([]);
  });

  test("API: a write must declare every argument's schema (no any) and where each comes from", () => {
    const op = GMAIL_API.gmail.operations["mail.send"];
    const withOp = (o: Record<string, unknown>) => parse({ gmail: { ...GMAIL_API.gmail, operations: { "mail.send": { ...op, ...o } } } }).errors.join("\n");
    expect(withOp({ fields: { to: "any", subject: "text", body: "text" } })).toContain("must have a schema");
    expect(withOp({ map: { to: "$item.to", subject: "$item.subject" } })).toContain("where body comes from");
    expect(withOp({ map: { to: "$item.to", subject: "$item.subject", body: "$env.HOME" } })).toContain("must be a literal or one of");
    expect(withOp({ role: "read" })).toContain("a read must be a GET");
    expect(withOp({ fields: { to: "text", subject: "text", body: "text" } })).toContain("gmail-raw needs fields to (addresses)");
    expect(parse({ "Not An Id": GMAIL_API.gmail }).errors.join()).toContain("must be a catalog id or an app target id");
  });
});

describe("s13 api secrets", () => {
  test("API: env references resolve in memory; Keychain references run `security` with the item name only", async () => {
    const runner = new FakeRunner(() => ok(`${SECRET}\n`));
    const r = new DefaultSecretReader({ GMAIL_TOKEN: "from-env-value" }, runner);
    expect(await r.read({ fromEnv: "GMAIL_TOKEN" })).toBe("from-env-value");
    expect(await r.read({ keychain: { service: "offload.gmail", account: "me" } })).toBe(SECRET);
    expect(runner.calls[0]!.argv).toEqual(["security", "find-generic-password", "-s", "offload.gmail", "-a", "me", "-w"]);
    expect(runner.calls[0]!.env.GMAIL_TOKEN).toBeUndefined();
    await expect(r.read({ fromEnv: "MISSING" })).rejects.toBeInstanceOf(SecretUnavailable);
    const empty = new DefaultSecretReader({}, new FakeRunner(() => ({ code: 44, stdout: "", stderr: "not found", timedOut: false })));
    await expect(empty.read({ keychain: { service: "s", account: "a" } })).rejects.toThrow("the Keychain item s could not be read");
  });

  test("API: redact removes a secret and its encodings from any text", () => {
    const t = `Bearer ${SECRET} / ${Buffer.from(SECRET).toString("base64")} / ${encodeURIComponent(SECRET)}`;
    expect(redact(t, [SECRET])).toBe("Bearer [redacted] / [redacted] / [redacted]");
  });
});

describe("s13 api probe", () => {
  test("API: health 2xx -> ok with the configured capabilities and OpenAPI reads; the secret goes only into the auth header", async () => {
    const spec = `${home}/openapi.json`;
    await Bun.write(spec, JSON.stringify({ openapi: "3.0.0", paths: { "/v1/labels": { get: { operationId: "labels.list" }, post: { operationId: "labels.create" } } } }));
    writeConfig(home, { apis: { gmail: { ...GMAIL_API.gmail, openapi: spec } } });
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const { r } = resolver(home, { fetch: f.fetch });
    const p = await new ApiProbe().probe(gmail(), r.deps);
    expect(p).toMatchObject({ health: "ok", writes: ["mail.send"], reads: ["api.labels.list", "mail.search"] });
    expect(p.tools["mail.send"]).toBe(`mcp__${apiServer("gmail")}__users.messages.send`);
    expect(f.calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    // The decision file and the DTO never hold the secret.
    const d = await r.resolve(gmail());
    expect(readFileSync(chainPath(home), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(toChainDTO(gmail(), d, false))).not.toContain(SECRET);
  });

  test("API: 401 -> failed refused; 500 -> failed; a network error is logged without the secret", async () => {
    writeConfig(home, { apis: GMAIL_API });
    expect(await new ApiProbe().probe(gmail(), resolver(home, { fetch: fakeFetch(() => new Response("", { status: 401 })).fetch }).r.deps)).toMatchObject({ health: "failed", code: "refused", reason: "The service refused the sign-in." });
    expect(await new ApiProbe().probe(gmail(), resolver(home, { fetch: fakeFetch(() => new Response("", { status: 503 })).fetch }).r.deps)).toMatchObject({ health: "failed", code: "http_503" });
    const leaky = resolver(home, { fetch: fakeFetch(() => Promise.reject(new Error(`connect failed with header Bearer ${SECRET}`))).fetch });
    expect(await new ApiProbe().probe(gmail(), leaky.r.deps)).toMatchObject({ health: "failed", code: "down", reason: "The service did not answer." });
    expect(leaky.logs.join("\n")).not.toContain(SECRET);
    expect(leaky.logs.join("\n")).toContain("api health failed");
  });

  test("API: no entry -> skipped no_api; no health check -> skipped; secret not readable -> skipped (no request made)", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    expect(await new ApiProbe().probe(gmail(), resolver(home, { fetch: f.fetch }).r.deps)).toMatchObject({ health: "skipped", code: "no_api", reason: "No direct connection is set up for Gmail." });
    writeConfig(home, { apis: { gmail: { ...GMAIL_API.gmail, health: undefined } } });
    expect(await new ApiProbe().probe(gmail(), resolver(home, { fetch: f.fetch }).r.deps)).toMatchObject({ health: "skipped", code: "no_health_check" });
    writeConfig(home, { apis: GMAIL_API });
    expect(await new ApiProbe().probe(gmail(), resolver(home, { fetch: f.fetch, secrets: new FakeSecrets({}) }).r.deps)).toMatchObject({ health: "skipped", code: "no_secret", reason: "The sign-in for the direct connection could not be read." });
    expect(f.calls).toHaveLength(0);
  });

  test("API: openapiReads lists GET operations only", () => {
    expect(openapiReads({ paths: { "/a": { get: { operationId: "a.get" }, delete: { operationId: "a.delete" } }, "/b": { post: { operationId: "b.post" } } } })).toEqual([{ operationId: "a.get", path: "/a" }]);
    expect(openapiReads(null)).toEqual([]);
  });
});

describe("s13 api executor", () => {
  const cfg = () => {
    writeConfig(home, { apis: GMAIL_API });
    return loadConnectorsConfig(home).config!;
  };

  test("API: gmail-raw is a plain-text RFC 5322 message with an encoded subject", () => {
    const raw = gmailRaw("anna@northzone.com", "Seed round: Offload ü", "Hi Anna,\nShort.");
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(mime).toContain("To: anna@northzone.com\r\n");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Seed round: Offload ü").toString("base64")}?=`);
    expect(mime).toContain("Content-Type: text/plain");
    expect(Buffer.from(mime.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe("Hi Anna,\r\nShort.");
  });

  test("API: an approved item goes out once with exactly its text; the record never holds the secret", async () => {
    const config = cfg();
    const w = gateWorld({ servers: { [apiServer("gmail")]: ["gmail"] }, policies: apiPolicies(config.apis) });
    const f = fakeFetch(() => new Response('{"id":"m1"}', { status: 200 }));
    const recs: ToolCallRecord[] = [];
    await new ApiExecutor({ fetch: f.fetch, secrets: new FakeSecrets(), config }).execute({ batch: w.batch, gate: w.gate, only: new Set([ITEM.key]), onToolResult: (r) => void recs.push(r) });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as { raw: string };
    expect(body.raw).toBe(gmailRaw(ITEM.to, ITEM.subject, ITEM.body));
    expect(recs).toEqual([expect.objectContaining({ tool: "mcp__api_gmail__users.messages.send", allowed: true, ok: true, itemKey: ITEM.key, role: "send" })]);
    expect(JSON.stringify(recs)).not.toContain(SECRET);
    expect(w.journal).toEqual([{ key: ITEM.key, role: "send", tool: "mcp__api_gmail__users.messages.send" }]);
  });

  test("API: the gate checks the full arguments: a changed subject, an extra field or a second use are refused", () => {
    const config = cfg();
    const w = gateWorld({ servers: { [apiServer("gmail")]: ["gmail"] }, policies: apiPolicies(config.apis) });
    const tool = "mcp__api_gmail__users.messages.send";
    const exact = { to: ITEM.to, subject: ITEM.subject, body: ITEM.body };
    expect(w.gate.decide(tool, { ...exact, subject: "Seed round: Offload!" }, false).allow).toBe(false);
    expect(w.gate.decide(tool, { ...exact, cc: "x@y.com" }, false).reason).toContain("unknown argument cc");
    expect(w.gate.decide(tool, { ...exact, to: "Anna@NorthZone.com" }, false).allow).toBe(true);
    expect(w.gate.check(tool, exact).result.behavior).toBe("allow");
    expect(w.gate.check(tool, exact).decision.reason).toContain("already done");
    // The read operation is a read; any other operation id on that server is unknown.
    expect(w.gate.decide("mcp__api_gmail__users.messages.list", { q: "in:sent" }, false)).toMatchObject({ allow: true, toolClass: "read" });
    expect(w.gate.decide("mcp__api_gmail__users.messages.delete", {}, false).reason).toContain("not on the allowlist");
  });

  test("API: a secret that cannot be read fails the method before any item is used; a failed request stops it and is redacted", async () => {
    const config = cfg();
    const w = gateWorld({ servers: { [apiServer("gmail")]: ["gmail"] }, policies: apiPolicies(config.apis) });
    await expect(new ApiExecutor({ fetch: fakeFetch(() => new Response("")).fetch, secrets: new FakeSecrets({}), config }).execute({ batch: w.batch, gate: w.gate })).rejects.toBeInstanceOf(MethodFailed);
    expect(w.journal).toHaveLength(0);
    const recs: ToolCallRecord[] = [];
    const boom = fakeFetch(() => Promise.reject(new Error(`socket hang up Bearer ${SECRET}`)));
    await expect(new ApiExecutor({ fetch: boom.fetch, secrets: new FakeSecrets(), config }).execute({ batch: w.batch, gate: w.gate, onToolResult: (r) => void recs.push(r) })).rejects.toBeInstanceOf(MethodFailed);
    expect(recs[0]).toMatchObject({ allowed: true, ok: false });
    expect(recs[0]!.error).not.toContain(SECRET);
    expect(boom.calls).toHaveLength(1);
  });

  test("API: mapArgs and buildRequest: path parameters, literal values, CRM sources", () => {
    const op = { capability: "crm.log", operationId: "rows.add", method: "POST" as const, path: "/sheets/{sheet}/rows", role: "log" as const, body: "json" as const, fields: {}, map: { sheet: "$crm.spreadsheetId", values: "$crm.row", mode: "RAW" } };
    expect(mapArgs(op, ITEM, { batchHash: "a".repeat(64) })).toBeNull();
    const args = mapArgs(op, ITEM, { batchHash: "a".repeat(64), crmSheet: { spreadsheetId: "S/1", range: "A:D" } })!;
    expect(args).toEqual({ sheet: "S/1", values: [[ITEM.to, ITEM.subject, "a".repeat(12), "sent"]], mode: "RAW" });
    const req = buildRequest({ baseUrl: "https://x.example", auth: { type: "header", header: "X-Api-Key", secret: { fromEnv: "K" } }, health: null, operations: [], openapi: null }, op, args, SECRET);
    expect(req.url).toBe("https://x.example/sheets/S%2F1/rows");
    expect(JSON.parse(String(req.init.body))).toEqual({ values: args.values, mode: "RAW" });
    expect((req.init.headers as Record<string, string>)["x-api-key"]).toBe(SECRET);
    expect(req.init.redirect).toBe("error");
  });
});
