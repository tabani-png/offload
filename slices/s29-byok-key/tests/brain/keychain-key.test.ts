// s29-byok-key BRAIN: the app launches the brain with OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key (the item's
// NAME only). The brain reads the key from the Keychain itself; argv and env never hold it. The Keychain read is the
// existing seam (KeyRunner); nothing here touches the real Keychain or the network. Run from brain/ (its bunfig
// preload): `bun test ../slices/s29-byok-key/tests/brain`. The key is a made-up test string.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeKeyConfigured, resolveAnthropicKey, type KeyRunner } from "../../../../brain/src/vision/claude.ts";
import { ApiBackend } from "../../../../brain/src/models/api-backend.ts";
import { createRoutedModel } from "../../../../brain/src/models/factory.ts";

const FAKE_KEY = "sk-ant-api03-s29test" + "q".repeat(60) + "WXYZ";
const REF = "offload.anthropic/api-key";

/** The fake Keychain: answers for offload.anthropic/api-key only, records every call. */
function fakeKeychain(value: string | null = FAKE_KEY) {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const run: KeyRunner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const svc = args[args.indexOf("-s") + 1];
    const acct = args[args.indexOf("-a") + 1];
    if (value !== null && svc === "offload.anthropic" && acct === "api-key") return { status: 0, stdout: `${value}\n` };
    return { status: 44, stdout: "" };
  };
  return { run, calls };
}

function fakeAnthropic() {
  const seen: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "request-id": "req_s29" } });
  };
  return { fetch, seen };
}

const envHasKey = () => Object.values(process.env).some((v) => (v ?? "").includes(FAKE_KEY)) || process.argv.some((a) => a.includes(FAKE_KEY));

describe("s29 brain key loading", () => {
  test("BRAIN: with only OFFLOAD_ANTHROPIC_KEYCHAIN the key comes from the Keychain; argv names the item, never the key", () => {
    const kc = fakeKeychain();
    const k = resolveAnthropicKey({ OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, kc.run);
    expect(k).toEqual({ source: "keychain", key: FAKE_KEY });
    expect(kc.calls).toEqual([{ cmd: "/usr/bin/security", args: ["find-generic-password", "-s", "offload.anthropic", "-a", "api-key", "-w"] }]);
    for (const c of kc.calls) expect(c.args.join(" ")).not.toContain("sk-ant");
    expect(claudeKeyConfigured({ OFFLOAD_ANTHROPIC_KEYCHAIN: REF })).toBe(true);
    expect(envHasKey()).toBe(false);
  });

  test("BRAIN: no item in the Keychain = no key (the app shows its Settings notice); no env = not configured", () => {
    const kc = fakeKeychain(null);
    expect(resolveAnthropicKey({ OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, kc.run)).toEqual({ source: "none", key: null });
    expect(resolveAnthropicKey({}, kc.run)).toEqual({ source: "none", key: null });
    expect(claudeKeyConfigured({})).toBe(false);
    expect(ApiBackend.fromEnv({ env: { OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, run: kc.run })).toBeNull();
  });

  test("BRAIN: the API backend sends the Keychain key in a header to api.anthropic.com only, and process.env never gains it", async () => {
    const kc = fakeKeychain();
    const api = fakeAnthropic();
    const before = JSON.stringify(process.env);
    const b = ApiBackend.fromEnv({ env: { OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, run: kc.run, fetch: api.fetch, maxRetries: 0 });
    expect(b).not.toBeNull();
    const r = await b!.complete({ model: "claude-haiku-5-5", route: "draft", role: "draft", system: "S", prompt: "P", maxTokens: 5, effort: "low", adaptiveThinking: false });
    expect(r.text).toBe("ok");
    expect(api.seen.length).toBe(1);
    expect(new URL(api.seen[0]!.url).host).toBe("api.anthropic.com");
    expect(api.seen[0]!.url).not.toContain(FAKE_KEY);
    // The SDK carries the key in a header (x-api-key, or Authorization: Bearer in this SDK version), nowhere else.
    const h = api.seen[0]!.headers;
    expect(h.get("x-api-key") === FAKE_KEY || h.get("authorization") === `Bearer ${FAKE_KEY}`).toBe(true);
    expect(api.seen[0]!.body).not.toContain(FAKE_KEY);
    expect(JSON.stringify(process.env)).toBe(before);
    expect(envHasKey()).toBe(false);
  });

  test("BRAIN: the serve path (createRoutedModel) picks the API backend from the Keychain reference alone", () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "s29-brain-"));
    try {
      const kc = fakeKeychain();
      const m = createRoutedModel({ home, env: { OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, api: { run: kc.run, fetch: fakeAnthropic().fetch } });
      expect(kc.calls.length).toBe(1);
      const summary = m.router.summary();
      expect(summary.backend).toBe("api");
      expect(summary.needsYou).toBeNull();
      expect(JSON.stringify(summary)).not.toContain(FAKE_KEY);
      expect(envHasKey()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
