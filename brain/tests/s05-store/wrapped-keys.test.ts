// s05 AC-0b (contract change 1198800): in keychain mode keys/DAY.key is 64 bytes ("OKW1" + AES-GCM under a Keychain
// master key). The brain cannot unwrap it, so it reads those days via `offload-observer export-day DAY --home DIR`
// (OFFLOAD_OBSERVER_BIN overrides the path). Raw 32-byte keys (OFFLOAD_KEYS=file fixtures) are decrypted in-process.
// Nothing is skipped silently: a failed export is a day error and every line of that day is a bad line.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptLine } from "../../src/store/crypto.ts";
import { readDay, readStore } from "../../src/store/reader.ts";
import { tempHome } from "../helpers.ts";

const DAY = "2026-10-20";
const ev = (i: number) => JSON.stringify({ id: `w${i}`, ts: Date.UTC(2026, 9, 20, 9, 0, i), kind: "focus", app: "com.google.Chrome", appName: "Google Chrome", title: `T${i}` });

let home = "";
let cleanup = () => {};
let bin = "";
let calls = "";

/** A fake observer: records its argv, prints the plain lines kept in $home/fake/DAY.jsonl, or fails on demand. */
function fakeObserver(mode: "ok" | "fail" | "short"): string {
  const path = join(home, `fake-observer-${mode}`);
  const body =
    mode === "fail"
      ? `echo "export-day $2: keychain locked" >&2; exit 1`
      : mode === "short"
        ? `head -n 1 "${home}/fake/$2.jsonl"`
        : `cat "${home}/fake/$2.jsonl"`;
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = "export-day" ] || exit 9\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function writeWrappedDay(lines: string[]): void {
  mkdirSync(join(home, "days"), { recursive: true });
  mkdirSync(join(home, "keys"), { recursive: true });
  mkdirSync(join(home, "fake"), { recursive: true });
  // Ciphertext the brain cannot read (it is under the wrapped key); only the observer can export it.
  writeFileSync(join(home, "days", `${DAY}.jsonl.enc`), lines.map(() => randomBytes(60).toString("base64")).join("\n") + "\n");
  writeFileSync(join(home, "keys", `${DAY}.key`), Buffer.concat([Buffer.from("OKW1"), randomBytes(60)]));
  writeFileSync(join(home, "fake", `${DAY}.jsonl`), lines.join("\n") + "\n");
}

beforeEach(() => {
  ({ home, cleanup } = tempHome());
  calls = join(home, "calls.log");
});
afterEach(() => cleanup());

describe("s05 store: keychain-wrapped day keys", () => {
  test("a 64-byte wrapped key is read through export-day DAY --home DIR", () => {
    writeWrappedDay([ev(1), ev(2), ev(3)]);
    bin = fakeObserver("ok");
    const d = readDay(home, DAY, { env: { OFFLOAD_OBSERVER_BIN: bin } });
    expect(d.errors).toEqual([]);
    expect(d.bad).toEqual([]);
    expect(d.events.map((e) => e.id)).toEqual(["w1", "w2", "w3"]);
    expect(d.keyMode).toBe("wrapped");
    expect(readFileSync(calls, "utf8").trim()).toBe(`export-day ${DAY} --home ${home}`);
  });

  test("a failing export is a loud day error and every line is bad (never skipped silently)", () => {
    writeWrappedDay([ev(1), ev(2)]);
    bin = fakeObserver("fail");
    const d = readDay(home, DAY, { env: { OFFLOAD_OBSERVER_BIN: bin } });
    expect(d.events).toEqual([]);
    expect(d.errors.join(" ")).toContain("keychain locked");
    expect(d.bad).toHaveLength(2);
    expect(d.bad.every((b) => b.reason === "decrypt_failed")).toBe(true);
  });

  test("a missing observer binary is a day error naming OFFLOAD_OBSERVER_BIN", () => {
    writeWrappedDay([ev(1)]);
    const d = readDay(home, DAY, { env: { OFFLOAD_OBSERVER_BIN: join(home, "nope") } });
    expect(d.errors.join(" ")).toContain("OFFLOAD_OBSERVER_BIN");
    expect(d.bad).toHaveLength(1);
  });

  test("an export with fewer lines than the encrypted file is reported", () => {
    writeWrappedDay([ev(1), ev(2), ev(3)]);
    bin = fakeObserver("short");
    const d = readDay(home, DAY, { env: { OFFLOAD_OBSERVER_BIN: bin } });
    expect(d.events).toHaveLength(1);
    expect(d.errors.join(" ")).toContain("1 of 3");
  });

  test("raw 32-byte keys are still decrypted in-process without calling the observer", () => {
    mkdirSync(join(home, "days"), { recursive: true });
    mkdirSync(join(home, "keys"), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(join(home, "keys", `${DAY}.key`), key);
    writeFileSync(join(home, "days", `${DAY}.jsonl.enc`), [ev(1), ev(2)].map((l) => encryptLine(key, l)).join("\n") + "\n");
    bin = fakeObserver("fail");
    const d = readDay(home, DAY, { env: { OFFLOAD_OBSERVER_BIN: bin, OFFLOAD_KEYS: "file" } });
    expect(d.events.map((e) => e.id)).toEqual(["w1", "w2"]);
    expect(d.keyMode).toBe("raw");
    expect(existsSync(calls)).toBe(false);
  });

  test("OFFLOAD_KEYS=file with a wrapped key fails loudly instead of exporting", () => {
    writeWrappedDay([ev(1)]);
    bin = fakeObserver("ok");
    const d = readDay(home, DAY, { env: { OFFLOAD_OBSERVER_BIN: bin, OFFLOAD_KEYS: "file" } });
    expect(d.events).toEqual([]);
    expect(d.errors.join(" ")).toContain("OFFLOAD_KEYS=file");
    expect(existsSync(calls)).toBe(false);
  });

  test("readStore passes env through to every day", () => {
    writeWrappedDay([ev(1), ev(2)]);
    bin = fakeObserver("ok");
    const s = readStore(home, { env: { OFFLOAD_OBSERVER_BIN: bin } });
    expect(s.eventCount).toBe(2);
    expect(s.badLineCount).toBe(0);
  });
});
