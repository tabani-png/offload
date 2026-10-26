// s27 review round 11 (PR #35): the Composio read child gets only the plain process basics (linkEnv, the same
// allowlist the Composio probes and executors use), and its output cap matches the read limit: a large valid answer
// reads, an answer over the limit is refused explicitly (never cut and parsed).
import { describe, expect, test } from "bun:test";
import type { LinkRunner } from "../../src/connectors/link.ts";
import { readValues } from "../../src/plan/read-source.ts";
import { ComposioSourceReader, MAX_ANSWER_CHARS } from "../../src/workflows/read-fetch.ts";

const SECRETS = { OFFLOAD_TOKEN: "tok-s27", ANTHROPIC_API_KEY: "sk-ant-s27", CLAUDE_CODE_OAUTH_TOKEN: "oat-s27", COMPOSIO_API_KEY: "ck-s27", GMAIL_OAUTH_PATH: "/secret.json", OFFLOAD_ANTHROPIC_KEYCHAIN: "svc/acct", AWS_SECRET_ACCESS_KEY: "aws-s27" };
const state = { method: "composio", reads: ["composio.read"], tools: { "composio.read": "mcp__composio_cli__POSTHOG_GET_INSIGHT" }, info: { account: "acct_1" } } as any;
const job = { target: { id: "web-us-posthog-com" } as any, state, source: {} as any, args: {}, call: async (_t: string, _i: Record<string, unknown>, run: () => Promise<string>) => run() };

/** A runner that records what it was given and answers like SpawnLinkRunner (output cut at maxBytes, 64 KiB default). */
function fakeRunner(stdout: string): LinkRunner & { seen: Array<{ env: Record<string, string>; maxBytes?: number }> } {
  const seen: Array<{ env: Record<string, string>; maxBytes?: number }> = [];
  return {
    seen,
    async run(_argv, opts) {
      seen.push({ env: opts.env, ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }) });
      return { code: 0, stdout: stdout.slice(0, opts.maxBytes ?? 64 * 1024), stderr: "", timedOut: false };
    },
  };
}

const answer = (rows: number) => JSON.stringify({ successful: true, data: { results: Array.from({ length: rows }, (_, i) => ({ signups: String(i), active_users: String(i * 2) })) }, error: null });

describe("s27 round 11: the Composio read child", () => {
  test("FETCH: the child env holds only the plain process basics, never a token, key or connector secret", async () => {
    const r = fakeRunner(answer(1));
    await new ComposioSourceReader({ runner: r, env: { PATH: "/usr/bin", HOME: "/Users/x", LANG: "en_US.UTF-8", ...SECRETS } }).read(job);
    expect(r.seen[0]!.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x", LANG: "en_US.UTF-8" });
  });

  test("FETCH: the output cap is the read limit + 1; a 200 KB answer reads in full", async () => {
    const big = answer(6000);
    expect(big.length).toBeGreaterThan(200 * 1024);
    const r = fakeRunner(big);
    const text = await new ComposioSourceReader({ runner: r, env: { PATH: "/usr/bin" } }).read(job);
    expect(r.seen[0]!.maxBytes).toBe(MAX_ANSWER_CHARS + 1);
    const out = readValues(text, [{ label: "Signups", sourceLabel: "Signups" }, { label: "Active", sourceLabel: "Active users" }]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.rows).toHaveLength(6000);
  });

  test("FETCH: an answer over the limit is refused with a plain reason, never cut and parsed", async () => {
    const huge = answer(1) + " ".repeat(MAX_ANSWER_CHARS + 1);
    const r = fakeRunner(huge);
    await expect(new ComposioSourceReader({ runner: r, env: { PATH: "/usr/bin" } }).read(job)).rejects.toThrow(/larger than Offload reads at once/);
  });
});
