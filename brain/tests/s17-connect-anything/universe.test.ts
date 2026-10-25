// s17 UNIVERSE + CLASSIFY: the read-only sync of Composio's toolkit and tool catalog into a versioned local index,
// the schema cache, staleness, offline use, and the deterministic class of every tool.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isReadOnlyComposioArgv } from "../../src/connectors/composio.ts";
import {
  classifyTool,
  fetchSchema,
  indexPath,
  readSchema,
  readUniverse,
  schemaHash,
  searchToolkits,
  searchTools,
  syncUniverse,
  toolsOf,
  UNIVERSE_TTL_MS,
  UniverseSyncError,
  universeStatus,
} from "../../src/connectors/universe.ts";
import { DAY, FakeRunner, fail, LINEAR_RECORD, missing, NOW, ok, syncedHome, tempHome, universeCli } from "./setup.ts";

describe("s17 universe", () => {
  test("UNIVERSE: the sync lists every toolkit (base list plus seed queries) and every toolkit's tools", async () => {
    const { index } = await syncedHome();
    expect(Object.keys(index.toolkits).sort()).toEqual(["composio", "freshdesk", "github", "gmail", "hubspot", "linear", "notion", "shopify", "slack", "stripe"]);
    expect(index.version).toBe(1);
    expect(index.syncedAt).toBe(NOW);
    expect(index.cliVersion).toBe("0.4.2");
    expect(index.complete).toBe(true);
    expect(index.tools.LINEAR_CREATE_LINEAR_ISSUE).toMatchObject({ toolkit: "linear", class: "commit" });
    expect(index.tools.FRESHDESK_CREATE_TICKET).toMatchObject({ toolkit: "freshdesk", class: "commit" });
    expect(index.toolkits.linear!.name).toBe("Linear");
  });

  test("UNIVERSE: every tool keeps toolkit, slug, name, description and Composio's hints", async () => {
    const { index } = await syncedHome();
    const t = index.tools.LINEAR_DELETE_LINEAR_ISSUE!;
    expect(t.slug).toBe("LINEAR_DELETE_LINEAR_ISSUE");
    expect(t.name.length).toBeGreaterThan(0);
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.description.length).toBeLessThanOrEqual(400);
    expect(t.hints).toContain("destructiveHint");
    expect(t.destructive).toBe(true);
    // Non-hint tags (topics) are not hints.
    expect(index.tools.LINEAR_SEARCH_ISSUES!.hints).not.toContain("issues");
  });

  test("UNIVERSE: the index is written versioned and private (0600) under the home", async () => {
    const { home } = await syncedHome();
    expect(existsSync(indexPath(home))).toBe(true);
    expect(statSync(indexPath(home)).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(indexPath(home), "utf8"));
    expect(raw.version).toBe(1);
    expect(readUniverse(home)!.tools.STRIPE_CREATE_REFUND!.toolkit).toBe("stripe");
  });

  test("UNIVERSE: the sync runs only read-only commands", async () => {
    const { runner } = await syncedHome();
    expect(runner.calls.length).toBeGreaterThan(5);
    for (const c of runner.calls) expect(isReadOnlyComposioArgv(c.argv)).toBe(true);
    // No execute at all during a catalog sync (schemas are fetched on demand).
    expect(runner.calls.some((c) => c.argv[1] === "execute")).toBe(false);
  });

  test("UNIVERSE: a failed toolkit listing keeps the previous good index", async () => {
    const { home, index } = await syncedHome();
    const broken = universeCli({ over: { "dev toolkits": fail(1, "", "offline") } });
    await expect(syncUniverse({ home, runner: broken, env: {}, now: () => NOW + DAY })).rejects.toBeInstanceOf(UniverseSyncError);
    expect(readUniverse(home)!.syncedAt).toBe(index.syncedAt);
    expect(Object.keys(readUniverse(home)!.tools).length).toBe(Object.keys(index.tools).length);
  });

  test("UNIVERSE: a toolkit whose tools cannot be listed keeps its previous tools and the index says it is not complete", async () => {
    const { home } = await syncedHome();
    const r = await syncUniverse({ home, runner: universeCli({ failTools: ["linear"] }), env: {}, now: () => NOW + DAY, seeds: ["e"] });
    expect(r.index.complete).toBe(false);
    expect(r.failedToolkits).toEqual(["linear"]);
    expect(r.index.tools.LINEAR_CREATE_LINEAR_ISSUE).toBeDefined();
    expect(r.index.toolkits.linear!.listed).toBe(false);
  });

  test("UNIVERSE: the CLI missing fails the sync without touching the cache", async () => {
    const { home, index } = await syncedHome();
    await expect(syncUniverse({ home, runner: new FakeRunner(() => missing), env: {}, now: () => NOW + DAY })).rejects.toBeInstanceOf(UniverseSyncError);
    expect(readUniverse(home)!.syncedAt).toBe(index.syncedAt);
  });

  test("UNIVERSE: stale after 24 hours; status counts toolkits, tools and classes", async () => {
    const { index } = await syncedHome();
    expect(UNIVERSE_TTL_MS).toBe(DAY);
    const s = universeStatus(index, NOW + DAY - 1);
    expect(s.stale).toBe(false);
    expect(universeStatus(index, NOW + DAY).stale).toBe(true);
    expect(s.toolkits).toBe(10);
    expect(s.tools).toBe(Object.keys(index.tools).length);
    expect(s.classes.commit).toBeGreaterThan(0);
    expect(s.classes.denied).toBeGreaterThan(0);
    expect(universeStatus(null, NOW)).toMatchObject({ syncedAt: null, stale: true, toolkits: 0, tools: 0 });
  });

  test("UNIVERSE: works offline from the cache (search, tools of a toolkit) with no CLI at all", async () => {
    const { home } = await syncedHome();
    const idx = readUniverse(home)!;
    expect(searchToolkits(idx, "linear", 5)[0]!.slug).toBe("linear");
    expect(searchToolkits(idx, "support ticketing", 5).map((t) => t.slug)).toContain("freshdesk");
    expect(toolsOf(idx, "stripe").map((t) => t.slug).sort()).toEqual(["STRIPE_CREATE_INVOICE_ITEM", "STRIPE_CREATE_REFUND", "STRIPE_LIST_CUSTOMERS"]);
    expect(searchTools(idx, "create issue", { classes: ["commit"], limit: 3 })[0]!.slug).toBe("LINEAR_CREATE_LINEAR_ISSUE");
    expect(readUniverse(tempHome())).toBeNull();
  });

  test("UNIVERSE: a corrupt index reads as no index (never half-trusted)", async () => {
    const { home } = await syncedHome();
    writeFileSync(indexPath(home), "{not json");
    expect(readUniverse(home)).toBeNull();
    writeFileSync(indexPath(home), JSON.stringify({ version: 2, tools: {} }));
    expect(readUniverse(home)).toBeNull();
  });

  test("UNIVERSE: schemas are fetched on demand with --get-schema, cached with the sha256 of the canonical schema", async () => {
    const { home, runner } = await syncedHome();
    const r = await fetchSchema({ home, runner, env: {}, now: () => NOW, slug: "LINEAR_CREATE_LINEAR_ISSUE" });
    expect(r).not.toBeNull();
    expect(r!.hash).toBe(schemaHash(r!.inputSchema));
    expect(r!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r!.toolVersion).toBe("20260924_00");
    expect(runner.calls.at(-1)!.argv).toEqual(["composio", "execute", "LINEAR_CREATE_LINEAR_ISSUE", "--get-schema"]);
    expect(readSchema(home, "LINEAR_CREATE_LINEAR_ISSUE")!.hash).toBe(r!.hash);
    // Cached: a second call within maxAge does not run the CLI.
    const n = runner.calls.length;
    await fetchSchema({ home, runner, env: {}, now: () => NOW + 1000, slug: "LINEAR_CREATE_LINEAR_ISSUE", maxAgeMs: DAY });
    expect(runner.calls.length).toBe(n);
  });

  test("UNIVERSE: the schema hash ignores key order but not content", () => {
    const a = { type: "object", properties: { b: { type: "string" }, a: { type: "integer" } }, required: ["a"] };
    const b = { required: ["a"], properties: { a: { type: "integer" }, b: { type: "string" } }, type: "object" };
    expect(schemaHash(a)).toBe(schemaHash(b));
    expect(schemaHash(a)).not.toBe(schemaHash({ ...a, required: ["a", "b"] }));
    expect(schemaHash(LINEAR_RECORD.inputSchema)).toBe(LINEAR_RECORD.hash);
  });

  test("UNIVERSE: a failed schema fetch with maxAge 0 is null (fail closed), never the stale copy", async () => {
    const { home, runner } = await syncedHome();
    await fetchSchema({ home, runner, env: {}, now: () => NOW, slug: "LINEAR_CREATE_LINEAR_ISSUE" });
    const offline = new FakeRunner(() => fail(1, "", "offline"));
    expect(await fetchSchema({ home, runner: offline, env: {}, now: () => NOW + 10, slug: "LINEAR_CREATE_LINEAR_ISSUE", maxAgeMs: 0 })).toBeNull();
    expect(await fetchSchema({ home, runner: offline, env: {}, now: () => NOW + 10, slug: "NOPE_TOOL" })).toBeNull();
  });

  test("UNIVERSE: a slug that is not a plain tool slug is refused before anything runs", async () => {
    const { home, runner } = await syncedHome();
    const n = runner.calls.length;
    for (const slug of ["LINEAR_X --dry-run", "-d", "../etc", "linear_lower"]) expect(await fetchSchema({ home, runner, env: {}, now: () => NOW, slug })).toBeNull();
    expect(runner.calls.length).toBe(n);
  });

  test("UNIVERSE: the read-only guard allows listing and schemas and refuses every write or code path", () => {
    expect(isReadOnlyComposioArgv(["composio", "dev", "toolkits", "list", "--limit", "1000"])).toBe(true);
    expect(isReadOnlyComposioArgv(["composio", "dev", "toolkits", "list", "--limit", "1000", "--query", "crm"])).toBe(true);
    expect(isReadOnlyComposioArgv(["composio", "dev", "toolkits", "info", "linear"])).toBe(true);
    expect(isReadOnlyComposioArgv(["composio", "execute", "LINEAR_CREATE_LINEAR_ISSUE", "--get-schema"])).toBe(true);
    for (const argv of [
      ["composio", "execute", "LINEAR_CREATE_LINEAR_ISSUE", "-d", "{}"],
      ["composio", "dev", "playground-execute"],
      ["composio", "dev", "toolkits", "list", "--connected"],
      ["composio", "dev", "auth-configs", "create"],
      ["composio", "dev", "toolkits", "info", "linear", "--user-id", "x"],
      ["composio", "run", "1"],
      ["composio", "proxy", "https://api.linear.app"],
      ["composio", "link", "linear"],
    ])
      expect(isReadOnlyComposioArgv(argv)).toBe(false);
  });

  test("UNIVERSE: an empty toolkit listing is a failed sync (nothing to trust) and writes no index", async () => {
    const home = tempHome();
    const runner = universeCli({ over: { "dev toolkits": ok("[]") } });
    await expect(syncUniverse({ home, runner, env: {}, now: () => NOW })).rejects.toBeInstanceOf(UniverseSyncError);
    expect(readUniverse(home)).toBeNull();
  });

  test("UNIVERSE: the child environment carries no Offload or connector secret", async () => {
    const home = tempHome();
    const runner = universeCli();
    await syncUniverse({ home, runner, env: { PATH: "/usr/bin", HOME: home, OFFLOAD_TOKEN: "x".repeat(40), COMPOSIO_API_KEY: "ak_secret", ANTHROPIC_API_KEY: "sk-ant-x" }, now: () => NOW, seeds: [] });
    for (const c of runner.calls) {
      expect(c.env.OFFLOAD_TOKEN).toBeUndefined();
      expect(c.env.COMPOSIO_API_KEY).toBeUndefined();
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });
});

describe("s17 classify", () => {
  test.each([
    ["COMPOSIO_MULTI_EXECUTE_TOOL", "composio", []],
    ["COMPOSIO_REMOTE_BASH_TOOL", "composio", []],
    ["COMPOSIO_SEARCH_TOOLS", "composio", ["readOnlyHint"]],
    ["GITHUB_EXECUTE_GRAPHQL", "github", ["createHint"]],
    ["NOTION_RUN_WORKBENCH", "notion", []],
    ["SLACK_PROXY_REQUEST", "slack", []],
    ["GMAIL_FORWARD_MESSAGE", "gmail", ["createHint"]],
    ["GMAIL_REPLY_TO_THREAD", "gmail", ["createHint"]],
    ["INSTANTLY_ACTIVATE_CAMPAIGN", "instantly", ["updateHint"]],
    ["QUICKBOOKS_CREATE_BILL_PAYMENT", "quickbooks", ["createHint"]],
    ["SHELL_EXEC_THING", "x", ["readOnlyHint"]],
  ])("CLASSIFY: %s is denied", (slug, tk, tags) => {
    const c = classifyTool(slug, tk, tags);
    expect(c.class).toBe("denied");
    expect(c.reason).not.toBeNull();
  });

  test("CLASSIFY: create-draft tools are draft (usable only through the reviewed s16 names)", () => {
    expect(classifyTool("GMAIL_CREATE_EMAIL_DRAFT", "gmail", ["createHint"]).class).toBe("draft");
    expect(classifyTool("LINEAR_LIST_ISSUE_DRAFTS", "linear", ["readOnlyHint"]).class).toBe("read");
  });

  test("CLASSIFY: readOnlyHint without a write hint is read", () => {
    expect(classifyTool("LINEAR_LIST_LINEAR_TEAMS", "linear", ["readOnlyHint", "openWorldHint"]).class).toBe("read");
    expect(classifyTool("STRIPE_LIST_CUSTOMERS", "stripe", ["customers", "readOnlyHint"]).class).toBe("read");
  });

  test("CLASSIFY: create, update, destructive and hint-less tools are commits (fail closed)", () => {
    expect(classifyTool("LINEAR_CREATE_LINEAR_ISSUE", "linear", ["createHint"]).class).toBe("commit");
    expect(classifyTool("LINEAR_UPDATE_ISSUE", "linear", ["updateHint"]).class).toBe("commit");
    expect(classifyTool("STRIPE_CREATE_REFUND", "stripe", ["destructiveHint"]).class).toBe("commit");
    expect(classifyTool("ACME_DO_SOMETHING", "acme", []).class).toBe("commit");
    // A read hint next to a write hint is not trusted as a read.
    expect(classifyTool("ACME_GET_AND_UPDATE", "acme", ["readOnlyHint", "updateHint"]).class).toBe("commit");
  });

  test("CLASSIFY: the synced index classes match classifyTool for every tool", async () => {
    const { index } = await syncedHome();
    for (const t of Object.values(index.tools)) expect(t.class).toBe(classifyTool(t.slug, t.toolkit, t.hints).class);
    expect(index.tools.COMPOSIO_SEARCH_TOOLS!.class).toBe("denied");
    expect(index.tools.GMAIL_FETCH_EMAILS!.class).toBe("read");
  });
});
