// s29-byok-key review round 3 (PR #36, Codex P2): the computer-use client must get the key from the same Keychain
// resolver as the router and the captioner (vision/claude.ts resolveAnthropicKey). The app launches the brain with
// only OFFLOAD_ANTHROPIC_KEYCHAIN and no ANTHROPIC_API_KEY. Fake Keychain seam, fake HTTP; the key is a test string.
import { describe, expect, test } from "bun:test";
import { anthropicMessages } from "../../../../brain/src/connectors/computer/claude.ts";
import type { KeyRunner } from "../../../../brain/src/vision/claude.ts";

const FAKE_KEY = "sk-ant-api03-s29computer" + "c".repeat(60) + "WXYZ";
const REF = "offload.anthropic/api-key";

function fakeKeychain(value: string | null = FAKE_KEY) {
  const calls: string[][] = [];
  const run: KeyRunner = (_cmd, args) => {
    calls.push([...args]);
    return value === null ? { status: 44, stdout: "" } : { status: 0, stdout: `${value}\n` };
  };
  return { run, calls };
}

function fakeAnthropic() {
  const seen: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    const msg = { id: "msg_c", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "request-id": "req_c" } });
  };
  return { fetch, seen };
}

const PARAMS = { model: "claude-sonnet-5-5", max_tokens: 5, messages: [{ role: "user" as const, content: "hi" }] };

describe("s29 computer-use key", () => {
  test("OFFLINE-KEY: with only OFFLOAD_ANTHROPIC_KEYCHAIN the computer-use client is authenticated from the Keychain", async () => {
    const kc = fakeKeychain();
    const api = fakeAnthropic();
    const before = JSON.stringify(process.env);
    const m = await anthropicMessages({ env: { OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, run: kc.run, fetch: api.fetch });
    await m.create(PARAMS);
    expect(kc.calls).toEqual([["find-generic-password", "-s", "offload.anthropic", "-a", "api-key", "-w"]]);
    expect(api.seen.length).toBe(1);
    expect(new URL(api.seen[0]!.url).host).toBe("api.anthropic.com");
    const h = api.seen[0]!.headers;
    expect(h.get("x-api-key") === FAKE_KEY || h.get("authorization") === `Bearer ${FAKE_KEY}`).toBe(true);
    expect(api.seen[0]!.url).not.toContain(FAKE_KEY);
    expect(api.seen[0]!.body).not.toContain(FAKE_KEY);
    expect(JSON.stringify(process.env)).toBe(before);
  });

  test("OFFLINE-KEY: no key anywhere -> a plain error that points to Settings, never a silent unauthenticated client", async () => {
    const kc = fakeKeychain(null);
    const api = fakeAnthropic();
    const err = await anthropicMessages({ env: { OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, run: kc.run, fetch: api.fetch }).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toContain("Settings");
    expect(api.seen.length).toBe(0);
  });

  test("OFFLINE-KEY: the client only talks to api.anthropic.com (same host guard as the captioner)", async () => {
    const kc = fakeKeychain();
    const m = await anthropicMessages({ env: { OFFLOAD_ANTHROPIC_KEYCHAIN: REF }, run: kc.run, fetch: fakeAnthropic().fetch, baseURL: "https://evil.example.com" }).then(
      () => "built",
      () => "refused",
    );
    expect(m).toBe("refused");
  });
});
