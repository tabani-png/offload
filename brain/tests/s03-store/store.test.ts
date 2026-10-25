import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptLine, encryptLine, NONCE_BYTES, TAG_BYTES } from "../../src/store/crypto.ts";
import { validateEvent } from "../../src/store/schema.ts";
import { listDays, readDay, readStore } from "../../src/store/reader.ts";
import { tempHome } from "../helpers.ts";

const good = (id: string, ts: number) => JSON.stringify({ id, ts, kind: "focus", app: "com.google.Chrome", title: "Inbox", host: "mail.google.com" });

describe("crypto line format", () => {
  test("an encrypted line round-trips to the same UTF-8 JSON", () => {
    const key = randomBytes(32);
    const text = good("01A", 1) + " é ✓";
    expect(decryptLine(key, encryptLine(key, text))).toBe(text);
  });

  test("a line is base64 of nonce(12) | ciphertext | tag(16)", () => {
    const key = randomBytes(32);
    const raw = Buffer.from(encryptLine(key, "abc"), "base64");
    expect(raw.length).toBe(NONCE_BYTES + 3 + TAG_BYTES);
  });

  test("a tampered ciphertext fails authentication", () => {
    const key = randomBytes(32);
    const raw = Buffer.from(encryptLine(key, "hello world"), "base64");
    raw[NONCE_BYTES] = (raw[NONCE_BYTES] ?? 0) ^ 0xff;
    expect(() => decryptLine(key, raw.toString("base64"))).toThrow(/decrypt_failed/);
  });

  test("the wrong key fails authentication", () => {
    const line = encryptLine(randomBytes(32), "hello");
    expect(() => decryptLine(randomBytes(32), line)).toThrow(/decrypt_failed/);
  });

  test("a line that is not base64 is rejected as invalid_base64", () => {
    expect(() => decryptLine(randomBytes(32), "not base64 !!")).toThrow(/invalid_base64/);
  });
});

describe("event schema validation", () => {
  test("a well-formed focus event is valid", () => {
    expect(validateEvent(JSON.parse(good("01A", 5))).ok).toBe(true);
  });

  test("a missing required field is invalid", () => {
    const r = validateEvent({ id: "x", kind: "focus" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ts");
  });

  test("an unknown property is invalid", () => {
    expect(validateEvent({ id: "x", ts: 1, kind: "focus", password: "p" }).ok).toBe(false);
  });

  test("a non-integer timestamp is invalid", () => {
    expect(validateEvent({ id: "x", ts: 1.5, kind: "focus" }).ok).toBe(false);
  });

  test("an unknown kind is invalid", () => {
    expect(validateEvent({ id: "x", ts: 1, kind: "keystroke" }).ok).toBe(false);
  });

  test("a non-object is invalid", () => {
    expect(validateEvent([1, 2]).ok).toBe(false);
  });
});

describe("store reader", () => {
  let home = "";
  let cleanup = () => {};
  beforeEach(() => {
    ({ home, cleanup } = tempHome());
    mkdirSync(join(home, "days"), { recursive: true });
    mkdirSync(join(home, "keys"), { recursive: true });
  });
  afterEach(() => cleanup());

  test("reads a plain day file in timestamp order", () => {
    writeFileSync(join(home, "days", "2026-10-12.jsonl"), [good("b", 20), good("a", 10)].join("\n") + "\n");
    const day = readDay(home, "2026-10-12");
    expect(day.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(day.source).toBe("plain");
    expect(day.bad).toEqual([]);
  });

  test("reads an encrypted day file with its key", () => {
    const key = randomBytes(32);
    writeFileSync(join(home, "keys", "2026-10-13.key"), key);
    writeFileSync(join(home, "days", "2026-10-13.jsonl.enc"), [encryptLine(key, good("a", 1)), encryptLine(key, good("b", 2))].join("\n") + "\n");
    const day = readDay(home, "2026-10-13");
    expect(day.source).toBe("encrypted");
    expect(day.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("bad lines are counted with line number and reason, never dropped silently", () => {
    const lines = [good("a", 1), "{not json", JSON.stringify({ id: "x", ts: "late", kind: "focus" }), good("a", 2), good("c", 3)];
    writeFileSync(join(home, "days", "2026-10-12.jsonl"), lines.join("\n"));
    const day = readDay(home, "2026-10-12");
    expect(day.events.map((e) => e.id)).toEqual(["a", "c"]);
    expect(day.bad.map((b) => [b.line, b.reason])).toEqual([
      [2, "invalid_json"],
      [3, "schema_invalid"],
      [4, "duplicate_id"],
    ]);
    expect(day.totalLines).toBe(5);
  });

  test("an encrypted line that fails authentication is reported as decrypt_failed", () => {
    const key = randomBytes(32);
    writeFileSync(join(home, "keys", "2026-10-13.key"), key);
    writeFileSync(join(home, "days", "2026-10-13.jsonl.enc"), [encryptLine(key, good("a", 1)), encryptLine(randomBytes(32), good("b", 2))].join("\n"));
    const day = readDay(home, "2026-10-13");
    expect(day.events.length).toBe(1);
    expect(day.bad[0]?.reason).toBe("decrypt_failed");
  });

  test("a missing key file marks every encrypted line bad and records a day error", () => {
    writeFileSync(join(home, "days", "2026-10-13.jsonl.enc"), [encryptLine(randomBytes(32), good("a", 1)), encryptLine(randomBytes(32), good("b", 2))].join("\n"));
    const day = readDay(home, "2026-10-13");
    expect(day.events).toEqual([]);
    expect(day.bad.length).toBe(2);
    expect(day.errors.join(" ")).toContain("key");
  });

  test("blank lines are counted separately and are not bad lines", () => {
    writeFileSync(join(home, "days", "2026-10-12.jsonl"), `${good("a", 1)}\n\n   \n${good("b", 2)}\n`);
    const day = readDay(home, "2026-10-12");
    expect(day.bad).toEqual([]);
    expect(day.blankLines).toBe(2);
  });

  test("listDays returns plain and encrypted days once each, sorted, ignoring other files", () => {
    writeFileSync(join(home, "days", "2026-10-14.jsonl"), "");
    writeFileSync(join(home, "days", "2026-10-12.jsonl.enc"), "");
    writeFileSync(join(home, "days", "2026-10-12.jsonl"), "");
    writeFileSync(join(home, "days", "notes.txt"), "");
    expect(listDays(home)).toEqual(["2026-10-12", "2026-10-14"]);
  });

  test("readStore keeps only the newest N days and totals bad lines", () => {
    for (let d = 10; d <= 18; d++) writeFileSync(join(home, "days", `2026-10-${d}.jsonl`), `${good(`id${d}`, d)}\n{bad\n`);
    const store = readStore(home, { windowDays: 7, now: new Date(2026, 9, 19, 12).getTime(), env: { OFFLOAD_OBSERVER_BIN: join(home, "no-observer") } });
    expect(store.refused).toEqual(["2026-10-10", "2026-10-11"]);
    expect(store.days.map((d) => d.day)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(store.eventCount).toBe(7);
    expect(store.badLineCount).toBe(7);
  });

  test("a missing home directory yields an empty store, not a crash", () => {
    const store = readStore(join(home, "nope"));
    expect(store.days).toEqual([]);
    expect(store.eventCount).toBe(0);
  });
});
