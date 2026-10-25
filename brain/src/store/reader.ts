// Reads the observer store (docs/store-contract.md). Plain `.jsonl` and encrypted `.jsonl.enc` are both supported.
// Bad lines are never dropped silently: each one is returned with its file, line number and reason.
// The 7-day rule (REVIEW-1 M4): days older than 7 local days are refused even when their files still exist (the
// observer may be stopped, so its purge did not run), and the observer is asked to purge them (`purge-now`).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DayLabel, OffloadEvent } from "../types.ts";
import { decryptLine, KEY_BYTES, LineCryptoError } from "./crypto.ts";
import { isExpired, KEEP_DAYS } from "./vault.ts";
import { observerBin, observerChildEnv } from "./observer.ts";
import { validateEvent } from "./schema.ts";

export type BadLineReason = "invalid_base64" | "decrypt_failed" | "invalid_json" | "schema_invalid" | "duplicate_id";

export interface BadLine {
  day: DayLabel;
  file: string;
  /** 1-based line number in the file. */
  line: number;
  reason: BadLineReason;
  detail: string;
}

export type DaySource = "plain" | "encrypted" | "both";

export interface DayRead {
  day: DayLabel;
  source: DaySource;
  files: string[];
  events: OffloadEvent[];
  bad: BadLine[];
  totalLines: number;
  blankLines: number;
  /** Day-level problems (e.g. missing key). The affected lines are also in `bad`. */
  errors: string[];
  /** How the encrypted file was read: raw 32-byte key in-process, or wrapped key via `offload-observer export-day`. */
  keyMode?: "raw" | "wrapped";
}

export type ReaderEnv = Readonly<Record<string, string | undefined>>;

export interface ReadOptions {
  /** OFFLOAD_OBSERVER_BIN (observer binary for wrapped keys) and OFFLOAD_KEYS. Default process.env. */
  env?: ReaderEnv;
  /** When given, a day older than 7 local days at this time is refused (no events, one error). */
  now?: number;
}

export { observerBin } from "./observer.ts";

const EXPORT_TIMEOUT_MS = 60_000;

/** Plain lines of a keychain-wrapped day from the observer (the only process that can unwrap the key). */
function exportDay(home: string, day: DayLabel, env: ReaderEnv): { lines: string[] } | { error: string } {
  const bin = observerBin(env);
  if (!existsSync(bin)) return { error: `wrapped day key needs the observer to export ${day}, but ${bin} does not exist (build the engine or set OFFLOAD_OBSERVER_BIN)` };
  const childEnv = observerChildEnv(home, env);
  const r = spawnSync(bin, ["export-day", day, "--home", home], { env: childEnv, encoding: "utf8", timeout: EXPORT_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  if (r.error !== undefined) return { error: `${bin} export-day ${day} failed: ${r.error.message}` };
  if (r.status !== 0) return { error: `${bin} export-day ${day} exited ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().slice(0, 300)}` };
  return { lines: splitLines(r.stdout ?? "") };
}

export interface StoreRead {
  home: string;
  days: DayRead[];
  /** Stored days older than 7 local days: not read. */
  refused: DayLabel[];
  eventCount: number;
  badLineCount: number;
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.enc)?$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function daysDir(home: string): string {
  return join(home, "days");
}

export function keyPath(home: string, day: DayLabel): string {
  return join(home, "keys", `${day}.key`);
}

export function listDays(home: string): DayLabel[] {
  const dir = daysDir(home);
  if (!existsSync(dir)) return [];
  const days = new Set<DayLabel>();
  for (const name of readdirSync(dir)) {
    const m = DAY_FILE_RE.exec(name);
    if (m?.[1] !== undefined) days.add(m[1]);
  }
  return [...days].sort();
}

/** Fingerprint of the day files (name, size, mtime) so callers can cache analysis until the store changes. */
export function storeFingerprint(home: string): string {
  const dir = daysDir(home);
  if (!existsSync(dir)) return "empty";
  return readdirSync(dir)
    .filter((n) => DAY_FILE_RE.test(n))
    .sort()
    .map((n) => {
      const st = statSync(join(dir, n));
      return `${n}:${st.size}:${st.mtimeMs}`;
    })
    .join("|");
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface LineSink {
  day: DayLabel;
  seen: Set<string>;
  events: OffloadEvent[];
  bad: BadLine[];
}

function acceptJson(sink: LineSink, file: string, lineNo: number, json: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    sink.bad.push({ day: sink.day, file, line: lineNo, reason: "invalid_json", detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  const result = validateEvent(parsed);
  if (!result.ok) {
    sink.bad.push({ day: sink.day, file, line: lineNo, reason: "schema_invalid", detail: result.error });
    return;
  }
  if (sink.seen.has(result.event.id)) {
    sink.bad.push({ day: sink.day, file, line: lineNo, reason: "duplicate_id", detail: `id ${result.event.id} already read` });
    return;
  }
  sink.seen.add(result.event.id);
  sink.events.push(result.event);
}

function loadKey(home: string, day: DayLabel): { key: Buffer } | { error: string } {
  const path = keyPath(home, day);
  if (!existsSync(path)) return { error: `key file missing: ${path}` };
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) return { error: `key file ${path} is ${key.length} bytes, expected ${KEY_BYTES}` };
  return { key };
}

export function readDay(home: string, day: DayLabel, opts: ReadOptions = {}): DayRead {
  const env = opts.env ?? process.env;
  if (opts.now !== undefined && isExpired(day, opts.now)) {
    return { day, source: "plain", files: [], events: [], bad: [], totalLines: 0, blankLines: 0, errors: [`refused: ${day} is older than ${KEEP_DAYS} local days (it should have been purged)`] };
  }
  const plain = join(daysDir(home), `${day}.jsonl`);
  const enc = join(daysDir(home), `${day}.jsonl.enc`);
  const hasPlain = existsSync(plain);
  const hasEnc = existsSync(enc);
  const sink: LineSink = { day, seen: new Set(), events: [], bad: [] };
  const result: DayRead = {
    day,
    source: hasPlain && hasEnc ? "both" : hasEnc ? "encrypted" : "plain",
    files: [],
    events: sink.events,
    bad: sink.bad,
    totalLines: 0,
    blankLines: 0,
    errors: [],
  };

  if (hasEnc) {
    result.files.push(enc);
    const lines = splitLines(readFileSync(enc, "utf8"));
    const kp = keyPath(home, day);
    const wrapped = existsSync(kp) && statSync(kp).size !== KEY_BYTES;
    if (wrapped && env.OFFLOAD_KEYS !== "file") {
      readWrapped(home, day, enc, lines, env, sink, result);
    } else {
      const loaded: { key: Buffer } | { error: string } = wrapped
        ? { error: `key file ${kp} is not a raw ${KEY_BYTES}-byte key and OFFLOAD_KEYS=file forbids the observer export` }
        : loadKey(home, day);
      if (!wrapped && "key" in loaded) result.keyMode = "raw";
      if ("error" in loaded) result.errors.push(loaded.error);
      lines.forEach((line, i) => {
        result.totalLines += 1;
        if (line.trim() === "") {
          result.blankLines += 1;
          return;
        }
        if ("error" in loaded) {
          sink.bad.push({ day, file: enc, line: i + 1, reason: "decrypt_failed", detail: loaded.error });
          return;
        }
        let json: string;
        try {
          json = decryptLine(loaded.key, line);
        } catch (err) {
          if (!(err instanceof LineCryptoError)) throw err;
          sink.bad.push({ day, file: enc, line: i + 1, reason: err.reason === "invalid_base64" ? "invalid_base64" : "decrypt_failed", detail: err.message });
          return;
        }
        acceptJson(sink, enc, i + 1, json);
      });
    }
  }

  if (hasPlain) {
    result.files.push(plain);
    splitLines(readFileSync(plain, "utf8")).forEach((line, i) => {
      result.totalLines += 1;
      if (line.trim() === "") {
        result.blankLines += 1;
        return;
      }
      acceptJson(sink, plain, i + 1, line);
    });
  }

  sink.events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return result;
}

function readWrapped(home: string, day: DayLabel, enc: string, lines: readonly string[], env: ReaderEnv, sink: LineSink, result: DayRead): void {
  result.keyMode = "wrapped";
  const encLines = lines.filter((l) => l.trim() !== "").length;
  result.totalLines += lines.length;
  result.blankLines += lines.length - encLines;
  const exported = exportDay(home, day, env);
  if ("error" in exported) {
    result.errors.push(exported.error);
    // Loud: every encrypted line of the day is a bad line with the reason.
    lines.forEach((line, i) => {
      if (line.trim() !== "") sink.bad.push({ day, file: enc, line: i + 1, reason: "decrypt_failed", detail: exported.error });
    });
    return;
  }
  const out = exported.lines.filter((l) => l.trim() !== "");
  if (out.length !== encLines) result.errors.push(`export-day ${day} returned ${out.length} of ${encLines} lines in ${enc}`);
  out.forEach((line, i) => acceptJson(sink, `${enc} (export-day)`, i + 1, line));
}

/** Asks the observer to delete expired days now. Returns false when there is no observer binary to ask. */
export function requestObserverPurge(home: string, env: ReaderEnv): boolean {
  const bin = observerBin(env);
  if (!existsSync(bin)) return false;
  const childEnv = observerChildEnv(home, env);
  const r = spawnSync(bin, ["purge-now", "--home", home], { env: childEnv, encoding: "utf8", timeout: EXPORT_TIMEOUT_MS });
  if (r.error !== undefined || r.status !== 0) {
    console.error(`brain: ${bin} purge-now failed: ${r.error?.message ?? (r.stderr ?? "").trim().slice(0, 200)}`);
    return false;
  }
  return true;
}

export function readStore(home: string, opts: { windowDays?: number; env?: ReaderEnv; now?: number } = {}): StoreRead {
  const window = opts.windowDays ?? 7;
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const stored = listDays(home);
  const refused = stored.filter((d) => isExpired(d, now));
  const days = stored
    .filter((d) => !isExpired(d, now))
    .slice(-window)
    .map((d) => readDay(home, d, { now, ...(opts.env === undefined ? {} : { env: opts.env }) }));
  // After reading, so a purge never races the days this read keeps.
  if (refused.length > 0) {
    const asked = requestObserverPurge(home, env);
    console.error(`brain: refused ${refused.length} stored day(s) older than ${KEEP_DAYS} local days (${refused.join(", ")}); ${asked ? "asked the observer to purge them" : "start the observer or run offload-observer purge-now to delete them"}`);
  }
  return {
    home,
    days,
    refused,
    eventCount: days.reduce((n, d) => n + d.events.length, 0),
    badLineCount: days.reduce((n, d) => n + d.bad.length, 0),
  };
}
