// s10e work item 1, real model: the sign-in is handed to Composio (`composio link <toolkit> --no-browser --no-wait`,
// polled with `--list`) or to the Gmail MCP server's one-time auth command. Tests inject a fake runner and pin argv;
// nothing is ever spawned here, and the child never gets OFFLOAD_TOKEN or a connector secret.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectLinkDTO } from "../../src/api/types.ts";
import { firstHttpsUrl, LINK_MESSAGES_FOR_LINT, linkEnv, listShowsActive, type LinkRunResult } from "../../src/connectors/link.ts";
import { BANNED_RE, FakeRunner, linkWorld, ok, type LinkWorld } from "./setup.ts";

let x: LinkWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

const SECRET_ENV = { OFFLOAD_TOKEN: "o".repeat(40), COMPOSIO_API_KEY: "ck_secret_value", GMAIL_OAUTH_PATH: "/tmp/creds.json", ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/usr/bin:/bin", HOME: "/Users/someone", LANG: "en_US.UTF-8" };
const link = (w: LinkWorld, id: string, method = "GET", body?: unknown) => w.call<ConnectLinkDTO>(`/connectors/${id}/link`, { method, ...(body === undefined ? {} : { body }) });
const composioServer = (home: string, catalog: string[]) =>
  writeFileSync(join(home, "connectors.json"), JSON.stringify({ version: 1, servers: { composio: { type: "http", url: "https://mcp.composio.example/x", headersFromEnv: { "x-api-key": "COMPOSIO_API_KEY" }, catalog } } }));

describe("s10e connect link: real model, Composio", () => {
  test("POST runs `composio link <toolkit> --no-browser --no-wait` and returns the first https URL", async () => {
    const runner = new FakeRunner(() => ok("Created link request.\nOpen https://connect.composio.dev/link/ln_abc123. to finish\nhttps://second.example/no\n"));
    x = await linkWorld({ modelLabel: "real", runner, env: SECRET_ENV });
    const r = await link(x, "google-calendar", "POST");
    expect(r.status).toBe(200);
    expect(runner.calls.map((c) => c.argv)).toEqual([["composio", "link", "googlecalendar", "--no-browser", "--no-wait"]]);
    expect(r.body).toMatchObject({ connectorId: "google-calendar", via: "composio", state: "waiting", url: "https://connect.composio.dev/link/ln_abc123", simulated: false, startedAt: x.clock.now, model: "real" } as Partial<ConnectLinkDTO>);
    expect(runner.calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(runner.calls[0]!.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  test("gmail goes through Composio (toolkit gmail) when a Composio http server lists it", async () => {
    const runner = new FakeRunner(() => ok("https://connect.composio.dev/link/g1"));
    x = await linkWorld({ modelLabel: "real", runner, env: { PATH: "/bin" } });
    composioServer(x.home, ["gmail"]); // COMPOSIO_API_KEY unset: missing_env, so not connected yet
    const r = await link(x, "gmail", "POST");
    expect(r.body.via).toBe("composio");
    expect(runner.calls[0]!.argv).toEqual(["composio", "link", "gmail", "--no-browser", "--no-wait"]);
    expect(r.body.message).toBe("Finish signing in to Gmail in your browser. Offload checks every few seconds.");
  });

  test("the child gets only the process basics: no OFFLOAD_TOKEN, connector secret or model login", async () => {
    const runner = new FakeRunner(() => ok("https://connect.composio.dev/link/x"));
    x = await linkWorld({ modelLabel: "real", runner, env: SECRET_ENV });
    await link(x, "slack", "POST");
    const env = runner.calls[0]!.env;
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/someone", LANG: "en_US.UTF-8" });
    expect(linkEnv(SECRET_ENV)).not.toHaveProperty("OFFLOAD_TOKEN");
    expect(JSON.stringify(env)).not.toContain("secret");
  });

  test("poll: active account but no server lists the id stays waiting with a plain next step; then connected", async () => {
    let list = "googlecalendar  ca_1  INACTIVE";
    const runner = new FakeRunner((argv) => (argv.includes("--list") ? ok(list) : ok("https://connect.composio.dev/link/c1")));
    x = await linkWorld({ modelLabel: "real", runner, env: SECRET_ENV });
    await link(x, "google-calendar", "POST");
    x.clock.now += 3000;
    const p1 = await link(x, "google-calendar");
    expect(runner.calls.at(-1)!.argv).toEqual(["composio", "link", "googlecalendar", "--list"]);
    expect(p1.body.state).toBe("waiting");
    expect(p1.body.url).toBe("https://connect.composio.dev/link/c1");
    list = "googlecalendar  ca_1  ACTIVE";
    x.clock.now += 3000;
    const p2 = await link(x, "google-calendar");
    expect(p2.body.state).toBe("waiting");
    expect(p2.body.message).toBe("Google Calendar is signed in. Add it to the Composio server Offload uses, then Offload connects it.");
    composioServer(x.home, ["google-calendar"]);
    x.clock.now += 3000;
    const p3 = await link(x, "google-calendar");
    expect(p3.body).toMatchObject({ state: "connected", connectedAt: x.clock.now, url: null });
    expect(p3.body.message).toBe("Google Calendar is connected.");
  });

  test("catalog connected alone is not enough while the Composio account is not active", async () => {
    let list = "[]";
    const runner = new FakeRunner((argv) => (argv.includes("--list") ? ok(list) : ok("https://connect.composio.dev/link/s1")));
    x = await linkWorld({ modelLabel: "real", runner, env: { PATH: "/bin", COMPOSIO_API_KEY: "k" } });
    await link(x, "slack", "POST");
    composioServer(x.home, ["slack"]);
    x.clock.now += 3000;
    expect((await link(x, "slack")).body.state).toBe("waiting");
    list = '[{"toolkit":"slack","status":"ACTIVE"}]';
    x.clock.now += 3000;
    expect((await link(x, "slack")).body.state).toBe("connected");
    // A fresh brain has no running sign-in: a connected catalog id is simply connected.
    x.rebuild({ modelLabel: "real", runner, env: { PATH: "/bin", COMPOSIO_API_KEY: "k" } });
    expect((await link(x, "slack")).body.state).toBe("connected");
  });

  test("polls are throttled: at most one `--list` every 2 seconds", async () => {
    const runner = new FakeRunner((argv) => (argv.includes("--list") ? ok("") : ok("https://connect.composio.dev/link/t")));
    x = await linkWorld({ modelLabel: "real", runner, env: {} });
    await link(x, "notion", "POST");
    x.clock.now += 2000;
    await link(x, "notion");
    await link(x, "notion");
    await link(x, "notion");
    expect(runner.calls.filter((c) => c.argv.includes("--list"))).toHaveLength(1);
  });

  test("a start that fails says so in plain words: error exit, no URL, not installed, timeout", async () => {
    const cases: Array<[() => LinkRunResult, string]> = [
      [() => ({ code: 1, stdout: "", stderr: "Error: not logged in (run composio login)", timedOut: false }), "The sign-in did not start: Composio stopped with an error."],
      [() => ok("done"), "The sign-in did not start: Composio did not give a sign-in link."],
      [() => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }), "The sign-in did not start: the Composio command is not installed on this Mac."],
      [() => ({ code: null, stdout: "", stderr: "", timedOut: true }), "The sign-in did not start: Composio did not answer in time."],
    ];
    for (const [reply, message] of cases) {
      const runner = new FakeRunner(reply);
      x?.cleanup();
      x = await linkWorld({ modelLabel: "real", runner, env: {} });
      const r = await link(x, "hubspot", "POST");
      expect(r.body).toMatchObject({ state: "failed", url: null, message });
      expect(r.body.message).not.toMatch(BANNED_RE);
      // A failed start can be started again.
      runner.reply = () => ok("https://connect.composio.dev/link/retry");
      expect((await link(x, "hubspot", "POST")).body.state).toBe("waiting");
    }
  });

  test("already connected: POST answers connected and runs nothing", async () => {
    const runner = new FakeRunner(() => ok("https://x.example"));
    x = await linkWorld({ modelLabel: "real", runner, env: { COMPOSIO_API_KEY: "k" } });
    composioServer(x.home, ["google-sheets"]);
    expect((await link(x, "google-sheets", "POST")).body).toMatchObject({ state: "connected", message: "Google Sheets is connected." });
    expect(runner.calls).toEqual([]);
  });
});

describe("s10e connect link: real model, Gmail MCP", () => {
  test("no server: runs the default one-time auth command in the background, waiting without a URL", async () => {
    let release: (v: { code: number; stdout: string; stderr: string; timedOut: boolean }) => void = () => {};
    const runner = new FakeRunner(() => new Promise((r) => (release = r)));
    x = await linkWorld({ modelLabel: "real", runner, env: SECRET_ENV });
    const r = await link(x, "gmail", "POST");
    expect(runner.calls[0]!.argv).toEqual(["npx", "-y", "@gongrzhe/server-gmail-autoauth-mcp", "auth"]);
    expect(runner.calls[0]!.env).not.toHaveProperty("OFFLOAD_TOKEN");
    expect(r.body).toMatchObject({ via: "gmail-mcp", state: "waiting", url: null, message: "Finish signing in to Gmail in the browser window that opened." });
    release({ code: 0, stdout: "", stderr: "", timedOut: false });
    await x.brain.linkIdle();
    // Signed in, but no server lists gmail yet: a plain next step, still waiting.
    const p = await link(x, "gmail");
    expect(p.body.state).toBe("waiting");
    expect(p.body.message).toBe("Gmail is signed in. Add it to the Gmail server Offload uses, then Offload connects it.");
  });

  test("a configured stdio server: its own command and args plus `auth`; connected once the catalog says so", async () => {
    const runner = new FakeRunner(() => ok(""));
    x = await linkWorld({ modelLabel: "real", runner, env: {} });
    writeFileSync(join(x.home, "connectors.json"), JSON.stringify({ version: 1, servers: { gmail: { type: "stdio", command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"], envFromEnv: { GMAIL_OAUTH_PATH: "GMAIL_OAUTH_PATH" }, catalog: ["gmail"] } } }));
    await link(x, "gmail", "POST");
    await x.brain.linkIdle();
    expect(runner.calls[0]!.argv).toEqual(["npx", "-y", "@gongrzhe/server-gmail-autoauth-mcp", "auth"]);
    x.rebuild({ modelLabel: "real", runner, env: { GMAIL_OAUTH_PATH: "/tmp/creds.json" } });
    expect((await link(x, "gmail")).body).toMatchObject({ state: "connected", message: "Gmail is connected." });
  });

  test("an auth command that fails or times out ends in failed with plain words", async () => {
    const runner = new FakeRunner(() => ({ code: 1, stdout: "", stderr: "oauth error", timedOut: false }));
    x = await linkWorld({ modelLabel: "real", runner, env: {} });
    await link(x, "gmail", "POST");
    await x.brain.linkIdle();
    const p = await link(x, "gmail");
    expect(p.body).toMatchObject({ state: "failed", message: "The sign-in did not finish: the sign-in window closed with an error." });
    runner.reply = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    await link(x, "gmail", "POST", { restart: true });
    await x.brain.linkIdle();
    expect((await link(x, "gmail")).body.message).toBe("The sign-in did not finish: it took too long, so Offload stopped waiting.");
  });
});

describe("s10e connect link: parsing and plain words", () => {
  test("firstHttpsUrl takes the first https URL and drops trailing punctuation; none -> null", () => {
    expect(firstHttpsUrl("go to http://plain.example then https://a.example/x?y=1, ok")).toBe("https://a.example/x?y=1");
    expect(firstHttpsUrl('{"redirect_url":"https://b.example/r"}')).toBe("https://b.example/r");
    expect(firstHttpsUrl("no link here")).toBeNull();
  });

  test("listShowsActive: ACTIVE yes, INACTIVE no", () => {
    expect(listShowsActive("gmail ca_1 ACTIVE")).toBe(true);
    expect(listShowsActive('[{"status":"active"}]')).toBe(true);
    expect(listShowsActive("gmail ca_1 INACTIVE")).toBe(false);
    expect(listShowsActive("")).toBe(false);
  });

  test("no link message contains a banned word, and each is one or two short sentences", () => {
    for (const m of LINK_MESSAGES_FOR_LINT) {
      expect(m).not.toMatch(BANNED_RE);
      expect(m.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
      expect(m.length).toBeLessThan(140);
    }
  });
});
