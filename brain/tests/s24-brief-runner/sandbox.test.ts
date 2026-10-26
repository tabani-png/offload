// SAFETY: the builder's tool allowlist, the Bash allowlist, the workspace lock, Cindy's container-only bypass rule and
// the telemetry-off env.
import { afterAll, describe, expect, test } from "bun:test";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { assertSafeExecutionProfile, BUILDER_TOOLS, builderEnv, builderPermissions, decideBashCommand, decideTool, DISALLOWED_TOOLS, NETWORK_TOOLS, profileFromEnv, UnsafeProfileError } from "../../src/builder/sandbox.ts";
import { fakeQuery, NOW, prepared, writeSlug, releaseTemps } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const WS = "/tmp/ws-s24";

describe("s24 builder sandbox", () => {
  test("SAFETY: no network tool is on the allowlist and every network tool is explicitly disallowed", () => {
    for (const t of NETWORK_TOOLS) {
      expect(BUILDER_TOOLS as readonly string[]).not.toContain(t);
      expect(DISALLOWED_TOOLS as readonly string[]).toContain(t);
      expect(decideTool(WS, t, { url: "https://example.com" }).allow).toBe(false);
    }
    expect(decideTool(WS, "mcp__gmail__send", {}).allow).toBe(false);
    expect(decideTool(WS, "Task", {}).allow).toBe(false);
    expect(decideTool(WS, "SomethingNew", {}).allow).toBe(false);
  });

  test("SAFETY: the SDK options lock cwd to the workspace, use only the builder tools, no MCP, no settings files", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: { mode: "allowlist", containerSandbox: false } });
    const o = f.seen[0]!.options;
    expect(o.cwd).toBe(rec.artifactPath);
    expect(o.tools).toEqual([...BUILDER_TOOLS]);
    expect(o.allowedTools).toEqual([]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(o.mcpServers).toEqual({});
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe("default");
    expect(typeof o.canUseTool).toBe("function");
    expect(o.env).toMatchObject({ DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
  });

  test("SAFETY: Bash runs only allowlisted commands with no shell operators", () => {
    expect(decideBashCommand(WS, "python3 slug.py").allow).toBe(true);
    expect(decideBashCommand(WS, "bun test ./accept/accept.test.ts").allow).toBe(true);
    expect(decideBashCommand(WS, "ls").allow).toBe(true);
    for (const bad of ["curl https://example.com", "python3 -c 'import os'", "ls; rm -rf /", "cat a | sh", "echo x > accept/accept.py", "bun install left-pad", "rm slug.py", "python3 $(whoami)", "ssh host"]) expect(decideBashCommand(WS, bad).allow).toBe(false);
  });

  test("SAFETY: paths outside the workspace are denied for every tool", () => {
    expect(decideTool(WS, "Read", { file_path: "/etc/passwd" }).allow).toBe(false);
    expect(decideTool(WS, "Read", { file_path: "../../.ssh/id_rsa" }).allow).toBe(false);
    expect(decideTool(WS, "Glob", { pattern: "*", path: "/Users" }).allow).toBe(false);
    expect(decideTool(WS, "Glob", { pattern: "/etc/*" }).allow).toBe(false);
    expect(decideTool(WS, "Glob", { pattern: "../**/*.key" }).allow).toBe(false);
    expect(decideTool(WS, "Glob", { pattern: "**/*.py" }).allow).toBe(true);
    expect(decideTool(WS, "Bash", { command: "cat /etc/hosts" }).allow).toBe(false);
    expect(decideTool(WS, "Read", { file_path: `${WS}/slug.py` }).allow).toBe(true);
    expect(decideTool(WS, "Read", { file_path: "accept/accept.py" }).allow).toBe(true);
  });

  test("SAFETY: bypass mode is refused unless running in a container sandbox (Cindy's rule)", async () => {
    expect(() => assertSafeExecutionProfile({ mode: "bypass", containerSandbox: false })).toThrow(UnsafeProfileError);
    expect(() => assertSafeExecutionProfile({ mode: "bypass", containerSandbox: true })).not.toThrow();
    expect(() => assertSafeExecutionProfile({ mode: "allowlist", containerSandbox: false })).not.toThrow();
    expect(profileFromEnv({}).containerSandbox).toBe(false);
    expect(profileFromEnv({ OFFLOAD_BUILDER_SANDBOX: "container" }, "bypass")).toEqual({ mode: "bypass", containerSandbox: true });
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{}]);
    await expect(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: { mode: "bypass", containerSandbox: false } })).rejects.toBeInstanceOf(UnsafeProfileError);
    expect(f.seen).toHaveLength(0);
  });

  test("SAFETY: container mode is not supported: the run is refused (allowlist or bypass) and the approval is kept; the PreToolUse hook still guards the check", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    for (const mode of ["bypass", "allowlist"] as const) {
      await expect(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: { mode, containerSandbox: true } })).rejects.toThrow(/container mode is not supported/);
    }
    expect(f.seen).toHaveLength(0);
    expect((await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: { mode: "allowlist", containerSandbox: false } })).outcome).toBe("PASS");
    const out = await builderPermissions("/tmp/ws-s24").preToolUse({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "accept/accept.py" } } as never, "t", { signal: new AbortController().signal });
    expect(JSON.stringify(out)).toContain('"permissionDecision":"deny"');
  });

  test("SAFETY: the subprocess env sets telemetry off and drops unrelated secrets", () => {
    const env = builderEnv({ PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "ghp_x", AWS_SECRET_ACCESS_KEY: "s" });
    expect(env).toMatchObject({ PATH: "/usr/bin", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
