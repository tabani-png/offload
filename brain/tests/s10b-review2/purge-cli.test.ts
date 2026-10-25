// s10b N4 (REVIEW-2), brain side: the purge runs at brain start before serving, and through `cli.ts purge` that the
// app calls at launch, so expired artefacts and keys go even when the brain was not running for days. The observer
// also deletes expired brain-YYYY-MM-DD.key files (engine 52b205b); wrap-key / unwrap-key of such a day exit 3, which
// the brain treats as "expired": the sealed file is deleted, never reported as an error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startBrainServer } from "../../src/api/server.ts";
import { brainKeyPath, clearBrainKeyCache, openText, sealText, wrappedBrainKeyPath } from "../../src/store/vault.ts";
import { tempHome } from "../helpers.ts";
import { fakeObserverWith } from "../s05c-keys/fake.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;
const DAY_MS = 86_400_000;
let home = "";
let cleanup = () => {};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  ({ home, cleanup } = tempHome());
  for (const k of ["OFFLOAD_KEYS", "OFFLOAD_OBSERVER_BIN"]) saved[k] = process.env[k];
  clearBrainKeyCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearBrainKeyCache();
  cleanup();
});

function expiredArtefact(): string {
  const wf = join(home, "workflows", "wf_abcd1234");
  mkdirSync(wf, { recursive: true });
  const f = join(wf, "dry-run.json.enc");
  sealText(home, f, '{"secret":"ocr"}', Date.now() - 9 * DAY_MS);
  return f;
}

describe("s10b N4: purge without a running brain", () => {
  test("N4: `cli.ts purge --home` deletes expired sealed artefacts and their keys and prints what it did", () => {
    const f = expiredArtefact();
    const key = brainKeyPath(home, Date.now() - 9 * DAY_MS);
    expect(existsSync(key)).toBe(true);
    const r = Bun.spawnSync(["bun", "run", CLI, "purge", "--home", home, "--json"], { env: { ...process.env, OFFLOAD_KEYS: "file" } });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { files: number; keys: number };
    expect(out.files).toBeGreaterThanOrEqual(1);
    expect(out.keys).toBeGreaterThanOrEqual(1);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(readFileSync(join(home, "purge-log.jsonl"), "utf8")).toContain('"by":"brain"');
  });

  test("N4: `cli.ts purge` without --home is a usage error", () => {
    const r = Bun.spawnSync(["bun", "run", CLI, "purge"], { env: { ...process.env, OFFLOAD_KEYS: "file" } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--home");
  });

  test("N4: the brain purges before it serves: an expired artefact is gone when the server is up", async () => {
    const f = expiredArtefact();
    const srv = await startBrainServer({ home, token: "t".repeat(40), port: 0, schedulerIntervalMs: 0, log: () => {} });
    try {
      expect(existsSync(f)).toBe(false);
    } finally {
      await srv.stop();
    }
  });

  test("N4: wrap-key with a key on stdin passes --import (raw-key migration works against engine 52b205b)", () => {
    // Raw key left from s05b, then keychain mode: migration pipes it to wrap-key, which must say --import.
    process.env.OFFLOAD_KEYS = "file";
    const f = join(home, "a.enc");
    sealText(home, f, "kept", Date.now());
    delete process.env.OFFLOAD_KEYS;
    const log = join(home, "obs.log");
    process.env.OFFLOAD_OBSERVER_BIN = fakeObserverWith({ FAKE_OBSERVER_LOG: log }, home);
    clearBrainKeyCache();
    expect(openText(home, f, Date.now())).toBe("kept");
    expect(readFileSync(log, "utf8")).toMatch(/wrap-key --name \d{4}-\d{2}-\d{2} --import --home/);
    expect(existsSync(brainKeyPath(home, Date.now()))).toBe(false);
  });

  test("N4: unwrap-key exit 3 (expired, key purged by the observer) deletes the sealed file and is not an error", () => {
    delete process.env.OFFLOAD_KEYS;
    process.env.OFFLOAD_OBSERVER_BIN = fakeObserverWith({}, home);
    const f = join(home, "b.enc");
    sealText(home, f, "old", Date.now());
    expect(existsSync(wrappedBrainKeyPath(home, Date.now()))).toBe(true);
    clearBrainKeyCache();
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      process.env.OFFLOAD_OBSERVER_BIN = fakeObserverWith({ FAKE_OBSERVER_EXPIRED: "1" }, home);
      expect(openText(home, f, Date.now())).toBeNull();
    } finally {
      console.error = orig;
    }
    expect(existsSync(f)).toBe(false);
    expect(errs.join("\n")).not.toContain("cannot open");
  });

  test("N4: SPEC documents that the observer purges expired brain keys too", () => {
    const spec = readFileSync(new URL("../../../slices/s10b-review2-brain/SPEC.md", import.meta.url).pathname, "utf8");
    expect(spec).toContain("brain-YYYY-MM-DD.key");
    expect(spec).toMatch(/observer[^.]*purges? expired brain keys/i);
  });
});
