// s05c H4 close-out: brain artefact keys live in the observer's Keychain-wrapped store (`offload-observer wrap-key /
// unwrap-key --name DAY`, binary via OFFLOAD_OBSERVER_BIN). Raw key files only under OFFLOAD_KEYS=file. Raw key files
// left from s05b are migrated (same key, wrapped) on start and lazily. A fake observer stands in for the Keychain.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBrainServer } from "../../src/api/server.ts";
import { brainKeyPath, clearBrainKeyCache, migrateBrainKeys, openText, purgeExpired, sealText, wrappedBrainKeyPath } from "../../src/store/vault.ts";
import { tempHome } from "../helpers.ts";
import { FAKE_OBSERVER, fakeObserverWith, fakeVarsFromEnv } from "./fake.ts";

const NOW = new Date(2026, 9, 19, 12).getTime();
const DAY = "2026-10-19";
const DAY_MS = 86_400_000;

let home = "";
let cleanup = () => {};
let log = "";
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["OFFLOAD_KEYS", "OFFLOAD_OBSERVER_BIN", "FAKE_OBSERVER_LOG", "FAKE_OBSERVER_FAIL_UNWRAP"] as const;

// s10b N6: FAKE_OBSERVER_* reach the fake through a wrapper script, not the (minimal) child environment.
function keychainMode(bin?: string): void {
  delete process.env.OFFLOAD_KEYS;
  process.env.OFFLOAD_OBSERVER_BIN = bin ?? fakeObserverWith(fakeVarsFromEnv(), home);
}
function fileMode(): void {
  process.env.OFFLOAD_KEYS = "file";
  process.env.OFFLOAD_OBSERVER_BIN = FAKE_OBSERVER;
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l !== "") : []);

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  ({ home, cleanup } = tempHome());
  log = join(home, "fake-observer.log");
  process.env.FAKE_OBSERVER_LOG = log;
  clearBrainKeyCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearBrainKeyCache();
  cleanup();
});

describe("s05c H4: Keychain-wrapped brain keys", () => {
  test("H4c: keychain mode seals with a key from wrap-key --name DAY; no raw key file is written", () => {
    keychainMode();
    const f = join(home, "a.json.enc");
    sealText(home, f, "secret OCR text", NOW);
    expect(calls()).toContain(`wrap-key --name ${DAY} --home ${home}`);
    expect(existsSync(join(home, "brain-keys"))).toBe(false);
    expect(existsSync(wrappedBrainKeyPath(home, DAY))).toBe(true);
    expect(readFileSync(f, "utf8")).not.toContain("secret OCR text");
    expect(openText(home, f, NOW)).toBe("secret OCR text");
  });

  test("H4c: reading in keychain mode unwraps the key through unwrap-key", () => {
    keychainMode();
    const f = join(home, "a.json.enc");
    sealText(home, f, "hello", NOW);
    clearBrainKeyCache();
    expect(openText(home, f, NOW)).toBe("hello");
    expect(calls()).toContain(`unwrap-key --name ${DAY} --home ${home}`);
  });

  test("H4c: a second day gets its own wrapped key and an existing key is never replaced", () => {
    keychainMode();
    sealText(home, join(home, "a.enc"), "one", NOW);
    const first = readFileSync(wrappedBrainKeyPath(home, DAY), "utf8");
    clearBrainKeyCache();
    sealText(home, join(home, "b.enc"), "two", NOW);
    sealText(home, join(home, "c.enc"), "three", NOW + DAY_MS);
    expect(readFileSync(wrappedBrainKeyPath(home, DAY), "utf8")).toBe(first);
    expect(existsSync(wrappedBrainKeyPath(home, "2026-10-20"))).toBe(true);
    expect(openText(home, join(home, "a.enc"), NOW + DAY_MS)).toBe("one");
  });

  test("H4c: OFFLOAD_KEYS=file keeps raw 32-byte key files and never calls the observer", () => {
    fileMode();
    const f = join(home, "a.json.enc");
    sealText(home, f, "fixture", NOW);
    expect(calls()).toEqual([]);
    expect(statSync(brainKeyPath(home, DAY)).size).toBe(32);
    expect(statSync(brainKeyPath(home, DAY)).mode & 0o777).toBe(0o600);
    expect(openText(home, f, NOW)).toBe("fixture");
  });

  test("H4c: a missing observer binary fails loudly when sealing; no raw key is written as a fallback", () => {
    keychainMode(join(home, "no-observer"));
    expect(() => sealText(home, join(home, "a.enc"), "x", NOW)).toThrow(/OFFLOAD_OBSERVER_BIN/);
    expect(existsSync(join(home, "brain-keys"))).toBe(false);
    expect(existsSync(join(home, "a.enc"))).toBe(false);
  });

  test("H4c: migration wraps each raw key with the same bytes, deletes the raw file, and old artefacts still open", () => {
    fileMode();
    const f = join(home, "old.json.enc");
    sealText(home, f, "sealed before s05c", NOW);
    const raw = readFileSync(brainKeyPath(home, DAY));
    keychainMode();
    const r = migrateBrainKeys(home, NOW);
    expect(r).toEqual({ migrated: 1, errors: [] });
    expect(existsSync(brainKeyPath(home, DAY))).toBe(false);
    expect(existsSync(join(home, "brain-keys"))).toBe(false);
    expect(readFileSync(wrappedBrainKeyPath(home, DAY), "utf8")).toContain(raw.toString("base64"));
    clearBrainKeyCache();
    expect(openText(home, f, NOW)).toBe("sealed before s05c");
  });

  test("H4c: migration leaves expired raw keys to the purge and reports a conflict without deleting the raw key", () => {
    fileMode();
    sealText(home, join(home, "old.enc"), "old", NOW - 9 * DAY_MS);
    const f = join(home, "today.enc");
    sealText(home, f, "today", NOW);
    keychainMode();
    // A different key is already wrapped under today's name.
    mkdirSync(join(home, "keys"), { recursive: true });
    writeFileSync(wrappedBrainKeyPath(home, DAY), `FAKEOKW1\n${Buffer.alloc(32, 7).toString("base64")}\n`);
    const r = migrateBrainKeys(home, NOW);
    expect(r.migrated).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(DAY);
    expect(existsSync(brainKeyPath(home, DAY))).toBe(true);
    expect(existsSync(brainKeyPath(home, "2026-10-10"))).toBe(true);
    // The artefact sealed under the raw key still opens (the raw key is tried after the wrapped one).
    expect(openText(home, f, NOW)).toBe("today");
  });

  test("H4c: sealing a day that only has a raw key wraps that key first (lazy migration)", () => {
    fileMode();
    const f = join(home, "a.enc");
    sealText(home, f, "first", NOW);
    keychainMode();
    sealText(home, join(home, "b.enc"), "second", NOW);
    expect(existsSync(brainKeyPath(home, DAY))).toBe(false);
    expect(openText(home, f, NOW)).toBe("first");
    expect(openText(home, join(home, "b.enc"), NOW)).toBe("second");
  });

  test("H4c: the purge deletes expired wrapped brain keys and their artefacts, and logs them", () => {
    keychainMode();
    const f = join(home, "a.enc");
    sealText(home, f, "x", NOW);
    const res = purgeExpired(home, NOW + 8 * DAY_MS, { log: () => {} });
    expect(res.keys).toBe(1);
    expect(existsSync(wrappedBrainKeyPath(home, DAY))).toBe(false);
    expect(openText(home, f, NOW + 8 * DAY_MS)).toBeNull();
    expect(readFileSync(join(home, "purge-log.jsonl"), "utf8")).toContain(`"day":"${DAY}"`);
  });

  test("H4c: an unwrap failure (Keychain locked) never makes the purge delete live artefacts", () => {
    keychainMode();
    const wf = join(home, "workflows", "wf_abcd1234");
    mkdirSync(wf, { recursive: true });
    const f = join(wf, "dry-run.json.enc");
    sealText(home, f, "{}", NOW);
    clearBrainKeyCache();
    process.env.FAKE_OBSERVER_FAIL_UNWRAP = "1";
    keychainMode();
    expect(openText(home, f, NOW)).toBeNull();
    const res = purgeExpired(home, NOW, { log: () => {} });
    expect(res.files).toBe(0);
    expect(existsSync(f)).toBe(true);
    delete process.env.FAKE_OBSERVER_FAIL_UNWRAP;
    keychainMode();
    expect(openText(home, f, NOW)).toBe("{}");
  });

  test("H4c: the server migrates raw brain keys when it starts", async () => {
    fileMode();
    sealText(home, join(home, "a.enc"), "x", NOW);
    keychainMode();
    const srv = await startBrainServer({ home, token: "k".repeat(40), now: () => NOW, log: () => {} });
    try {
      expect(existsSync(brainKeyPath(home, DAY))).toBe(false);
      expect(existsSync(wrappedBrainKeyPath(home, DAY))).toBe(true);
    } finally {
      await srv.stop();
    }
  });
});
