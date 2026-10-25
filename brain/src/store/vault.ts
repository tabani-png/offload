// Brain artefacts that hold OCR or mail text (REVIEW-1 H4): dry runs, dry-run batches, the tone corpus and the
// blind-test files. They are sealed with a per-day brain key: AES-256-GCM lines (crypto.ts), one 32-byte key per local
// day. Deleting a day = delete its key AND its artefacts.
//
// Keys (s05c, H4 close-out; docs/store-contract.md "Brain keys"):
// - default (keychain): the observer keeps the key in $OFFLOAD_HOME/keys/brain-YYYY-MM-DD.key, wrapped with its
//   Keychain master key. `offload-observer wrap-key --name DAY` creates (or returns) it and `unwrap-key --name DAY`
//   returns it, base64 on stdout (binary: OFFLOAD_OBSERVER_BIN, else engine/.build/offload-observer). No raw key is
//   ever written; a missing or failing observer is an error, never a fallback to raw files.
// - OFFLOAD_KEYS=file (tests, fixtures): raw 32-byte files in $OFFLOAD_HOME/brain-keys/YYYY-MM-DD.key (0600, folder
//   0700), the s05b scheme. Gives crypto-shredding but no protection from another process of the same user.
// Raw key files left from s05b are wrapped with the same bytes and deleted: at serve start (migrateBrainKeys) and
// lazily when a day with only a raw key is used. Unwrapped keys are cached in memory for this process only.
//
// Sealed file: line 1 "OBV1 YYYY-MM-DD", line 2 the encrypted text (crypto.ts line format).
// Purge (startup and hourly, see startPurgeSchedule): days older than 7 local days lose their key and artefacts, and a
// line goes to $OFFLOAD_HOME/purge-log.jsonl {day, deletedAt, events: 0, files, by: "brain"}. Readers refuse an
// expired artefact even before the purge ran.
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptLine, encryptLine, generateKey, KEY_BYTES } from "./crypto.ts";
import { runObserverSync, type ObserverEnv } from "./observer.ts";

export const KEEP_DAYS = 7;
export const PURGE_INTERVAL_MS = 3_600_000;
const MAGIC = "OBV1";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day of a timestamp, YYYY-MM-DD. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole local days from `day` to the day of `now` (0 = today). null for a malformed label. */
export function dayAge(day: string, now: number): number | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d).getTime();
  const t = new Date(now);
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((today - then) / 86_400_000);
}

/** Older than KEEP_DAYS local days: today and the 7 days before it are kept (same rule as the observer). */
export const isExpired = (day: string, now: number) => {
  const age = dayAge(day, now);
  return age === null || age > KEEP_DAYS;
};

export type BrainKeyMode = "keychain" | "file";
/** OFFLOAD_KEYS=file = raw key files; anything else = Keychain-wrapped through the observer. */
export const brainKeyMode = (env: ObserverEnv = process.env): BrainKeyMode => (env.OFFLOAD_KEYS === "file" ? "file" : "keychain");

/** Raw key folder (OFFLOAD_KEYS=file, and s05b leftovers waiting for migration). */
export const brainKeysDir = (home: string) => join(home, "brain-keys");
/** Raw 32-byte key file of a day (OFFLOAD_KEYS=file). */
export const brainKeyPath = (home: string, at: number | string) => join(brainKeysDir(home), `${typeof at === "number" ? localDay(at) : at}.key`);
/** The observer's wrapped brain key of a day (keychain mode). The brain never reads its bytes, only asks unwrap-key. */
export const wrappedBrainKeyPath = (home: string, at: number | string) => join(home, "keys", `brain-${typeof at === "number" ? localDay(at) : at}.key`);

/** The observer could not wrap or unwrap a brain key. */
export class BrainKeyError extends Error {}

const cache = new Map<string, Buffer>();
const cacheKey = (home: string, day: string) => `${home}\u0000${day}`;
/** Forgets unwrapped keys held in memory (tests; the purge drops expired ones itself). */
export function clearBrainKeyCache(): void {
  cache.clear();
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readRaw(home: string, day: string): Buffer | null {
  const p = brainKeyPath(home, day);
  if (!existsSync(p)) return null;
  const k = readFileSync(p);
  return k.length === KEY_BYTES ? k : null;
}

function createRaw(home: string, day: string): Buffer {
  const p = brainKeyPath(home, day);
  mkdirSync(brainKeysDir(home), { recursive: true, mode: 0o700 });
  chmodSync(brainKeysDir(home), 0o700);
  // Create-if-absent, atomically: a key that already exists is never replaced (that would orphan its artefacts).
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, generateKey(), { mode: 0o600 });
  try {
    linkSync(tmp, p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return readFileSync(p);
}

/** Parses the observer's one base64 line; anything but exactly 32 bytes is an error. */
function parseKeyLine(stdout: string, what: string): Buffer {
  const line = stdout.trim();
  const k = /^[A-Za-z0-9+/]+=*$/.test(line) ? Buffer.from(line, "base64") : Buffer.alloc(0);
  if (k.length !== KEY_BYTES) throw new BrainKeyError(`${what}: the observer did not print a ${KEY_BYTES}-byte base64 key`);
  return k;
}

/** wrap-key --name DAY: stores `raw` (or a new random key when null) and returns the stored key. */
function wrapKey(home: string, day: string, raw: Buffer | null, env: ObserverEnv): Buffer {
  const r = runObserverSync(home, ["wrap-key", "--name", day], env, { input: raw === null ? "" : raw.toString("base64") + "\n", drop: ["OFFLOAD_KEYS"] });
  if (!r.ok) throw new BrainKeyError(`brain key ${day}: ${r.error}`);
  return parseKeyLine(r.stdout, `wrap-key ${day}`);
}

function unwrapKey(home: string, day: string, env: ObserverEnv): Buffer {
  const r = runObserverSync(home, ["unwrap-key", "--name", day], env, { drop: ["OFFLOAD_KEYS"] });
  if (!r.ok) throw new BrainKeyError(`brain key ${day}: ${r.error}`);
  return parseKeyLine(r.stdout, `unwrap-key ${day}`);
}

/** Wraps a day's raw key with the same bytes and deletes the raw file only when the observer returned those bytes. */
function migrateDay(home: string, day: string, raw: Buffer, env: ObserverEnv): Buffer {
  const stored = wrapKey(home, day, raw, env);
  if (!stored.equals(raw)) throw new BrainKeyError(`brain key ${day}: the observer holds a different key; the raw key file is kept`);
  rmSync(brainKeyPath(home, day), { force: true });
  try {
    if (readdirSync(brainKeysDir(home)).length === 0) rmdirSync(brainKeysDir(home));
  } catch {
    // Folder already gone or not empty: fine.
  }
  return stored;
}

/** Keychain mode: the day's key from the observer, wrapping a raw leftover or creating one when asked. */
function keychainKey(home: string, day: string, create: boolean, env: ObserverEnv): Buffer | null {
  const wrapped = wrappedBrainKeyPath(home, day);
  const ck = cacheKey(home, day);
  if (existsSync(wrapped)) {
    const hit = cache.get(ck);
    if (hit !== undefined) return hit;
    const k = unwrapKey(home, day, env);
    cache.set(ck, k);
    return k;
  }
  cache.delete(ck);
  const raw = readRaw(home, day);
  if (raw !== null) {
    const k = migrateDay(home, day, raw, env);
    cache.set(ck, k);
    return k;
  }
  if (!create) return null;
  const k = wrapKey(home, day, null, env);
  cache.set(ck, k);
  return k;
}

function keyFor(home: string, day: string, create: boolean, env: ObserverEnv = process.env): Buffer | null {
  if (brainKeyMode(env) === "file") return readRaw(home, day) ?? (create ? createRaw(home, day) : null);
  return keychainKey(home, day, create, env);
}

/** A key file for the day exists (wrapped or raw). Never asks the observer: a locked Keychain must not look like
 * a deleted key, or the purge would delete live artefacts. */
function keyExists(home: string, day: string): boolean {
  return existsSync(wrappedBrainKeyPath(home, day)) || existsSync(brainKeyPath(home, day));
}

/** Writes `text` sealed under the key of the local day of `at` (0600, atomic). Throws BrainKeyError when the
 * observer cannot provide a key. */
export function sealText(home: string, path: string, text: string, at: number, env: ObserverEnv = process.env): void {
  const day = localDay(at);
  const key = keyFor(home, day, true, env)!;
  writeAtomic(path, `${MAGIC} ${day}\n${encryptLine(key, text)}\n`);
}

/** The day a sealed file belongs to, or null when it is not a sealed file. */
export function sealedDay(path: string): string | null {
  try {
    const head = readFileSync(path, "utf8").slice(0, 32).split("\n")[0] ?? "";
    const m = /^OBV1 (\d{4}-\d{2}-\d{2})$/.exec(head);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Plain text of a sealed file; null when missing, expired (then it is deleted), unsealed or undecryptable. A key the
 * observer cannot unwrap is logged on stderr and reads as null; the file is kept. */
export function openText(home: string, path: string, now: number, env: ObserverEnv = process.env): string | null {
  if (!existsSync(path)) return null;
  const [head, body] = readFileSync(path, "utf8").split("\n");
  const m = /^OBV1 (\d{4}-\d{2}-\d{2})$/.exec(head ?? "");
  if (m?.[1] === undefined || body === undefined) return null;
  const day = m[1];
  if (isExpired(day, now)) {
    rmSync(path, { force: true });
    return null;
  }
  const keys: Buffer[] = [];
  try {
    const k = keyFor(home, day, false, env);
    if (k !== null) keys.push(k);
  } catch (err) {
    if (!(err instanceof BrainKeyError)) throw err;
    console.error(`brain: cannot open a sealed file of ${day}: ${err.message}`);
  }
  // A raw key kept after a failed migration (conflict) still opens what was sealed under it.
  const raw = readRaw(home, day);
  if (raw !== null && !keys.some((k) => k.equals(raw))) keys.push(raw);
  for (const key of keys) {
    try {
      return decryptLine(key, body);
    } catch {
      // Try the next key.
    }
  }
  return null;
}

export interface MigrateResult {
  migrated: number;
  errors: string[];
}

/** Keychain mode: wraps every raw brain key file that is not expired (expired ones are the purge's) and deletes it.
 * OFFLOAD_KEYS=file: does nothing. */
export function migrateBrainKeys(home: string, now: number, env: ObserverEnv = process.env): MigrateResult {
  const res: MigrateResult = { migrated: 0, errors: [] };
  if (brainKeyMode(env) === "file" || !existsSync(brainKeysDir(home))) return res;
  for (const n of readdirSync(brainKeysDir(home)).sort()) {
    const m = /^(\d{4}-\d{2}-\d{2})\.key$/.exec(n);
    if (m?.[1] === undefined || isExpired(m[1], now)) continue;
    const day = m[1];
    const raw = readRaw(home, day);
    if (raw === null) {
      res.errors.push(`brain key ${day}: ${n} is not a raw ${KEY_BYTES}-byte key; left in place`);
      continue;
    }
    try {
      cache.set(cacheKey(home, day), migrateDay(home, day, raw, env));
      res.migrated += 1;
    } catch (err) {
      if (!(err instanceof BrainKeyError)) throw err;
      res.errors.push(err.message);
    }
  }
  return res;
}

// ---------- purge ----------

export interface PurgeResult {
  /** Artefact files deleted (expired, or debris whose key is gone). */
  files: number;
  /** Day keys deleted. */
  keys: number;
  /** Legacy plaintext files sealed in place. */
  sealed: number;
  days: string[];
}

const SEALED_SUFFIX = ".enc";

/** Every place a brain artefact with OCR or mail text can live. Plain = written before s05b. */
function artefacts(home: string): Array<{ path: string; plain: boolean; dryRunBatch?: boolean }> {
  const out: Array<{ path: string; plain: boolean; dryRunBatch?: boolean }> = [];
  const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
  const wfRoot = join(home, "workflows");
  for (const id of ls(wfRoot)) {
    if (!/^wf_[a-z0-9]{4,40}$/.test(id)) continue;
    const dir = join(wfRoot, id);
    for (const n of ["dry-run.json", "dry-run.json.enc"]) if (existsSync(join(dir, n))) out.push({ path: join(dir, n), plain: !n.endsWith(SEALED_SUFFIX) });
    for (const n of ls(join(dir, "dry-runs"))) if (/^\d+\.json(\.enc)?$/.test(n)) out.push({ path: join(dir, "dry-runs", n), plain: !n.endsWith(SEALED_SUFFIX) });
    for (const n of ls(join(dir, "batches"))) {
      if (/^[0-9a-f]{64}\.json\.enc$/.test(n)) out.push({ path: join(dir, "batches", n), plain: false });
      else if (/^[0-9a-f]{64}\.json$/.test(n)) {
        // Only dry-run batches carry OCR-parsed recipients and subjects; live batches are the send record.
        try {
          if ((JSON.parse(readFileSync(join(dir, "batches", n), "utf8")) as { kind?: string }).kind === "dry_run") out.push({ path: join(dir, "batches", n), plain: true, dryRunBatch: true });
        } catch {
          // Not JSON: not ours to judge.
        }
      }
    }
  }
  const tone = join(home, "tone");
  for (const n of ["corpus.jsonl", "corpus.jsonl.enc"]) if (existsSync(join(tone, n))) out.push({ path: join(tone, n), plain: !n.endsWith(SEALED_SUFFIX) });
  for (const run of ls(join(tone, "blind-test"))) {
    for (const n of ls(join(tone, "blind-test", run))) if (/^(pairs\.md|key\.json)(\.enc)?$/.test(n)) out.push({ path: join(tone, "blind-test", run, n), plain: !n.endsWith(SEALED_SUFFIX) });
  }
  return out;
}

export interface PurgeOptions {
  log?: (line: string) => void;
}

/** Deletes expired brain keys and artefacts, seals legacy plaintext ones, and logs what it did. */
export function purgeExpired(home: string, now: number, opts: PurgeOptions = {}): PurgeResult {
  const res: PurgeResult = { files: 0, keys: 0, sealed: 0, days: [] };
  const perDay = new Map<string, number>();
  const gone = (day: string) => perDay.set(day, (perDay.get(day) ?? 0) + 1);

  for (const a of artefacts(home)) {
    if (a.plain) {
      const mday = localDay(statSync(a.path).mtimeMs);
      if (isExpired(mday, now)) {
        rmSync(a.path, { force: true });
        res.files += 1;
        gone(mday);
      } else {
        const text = readFileSync(a.path, "utf8");
        const target = a.path + SEALED_SUFFIX;
        try {
          sealText(home, target, text, statSync(a.path).mtimeMs);
        } catch (err) {
          // No key from the observer: keep the plaintext for the next run rather than lose it, and say so.
          if (!(err instanceof BrainKeyError)) throw err;
          (opts.log ?? console.log)(`brain: purge could not seal a legacy file: ${err.message}`);
          continue;
        }
        rmSync(a.path, { force: true });
        res.sealed += 1;
      }
      continue;
    }
    const day = sealedDay(a.path);
    if (day === null || isExpired(day, now) || !keyExists(home, day)) {
      rmSync(a.path, { force: true });
      res.files += 1;
      gone(day ?? "unknown");
    }
  }
  const dropKey = (path: string, day: string) => {
    rmSync(path, { force: true });
    cache.delete(cacheKey(home, day));
    res.keys += 1;
    perDay.set(day, perDay.get(day) ?? 0);
  };
  const kdir = brainKeysDir(home);
  if (existsSync(kdir)) {
    for (const n of readdirSync(kdir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.key$/.exec(n);
      if (m?.[1] !== undefined && isExpired(m[1], now)) dropKey(join(kdir, n), m[1]);
    }
  }
  // Wrapped brain keys: the observer's retention leaves them to the brain (engine/README.md "Brain keys").
  const wdir = join(home, "keys");
  if (existsSync(wdir)) {
    for (const n of readdirSync(wdir)) {
      const m = /^brain-(\d{4}-\d{2}-\d{2})\.key$/.exec(n);
      if (m?.[1] !== undefined && isExpired(m[1], now)) dropKey(join(wdir, n), m[1]);
    }
  }
  // Empty blind-test run folders go too.
  const blind = join(home, "tone", "blind-test");
  if (existsSync(blind)) for (const run of readdirSync(blind)) if (readdirSync(join(blind, run)).length === 0) rmdirSync(join(blind, run));

  res.days = [...perDay.keys()].sort();
  for (const day of res.days) {
    appendFileSync(join(home, "purge-log.jsonl"), JSON.stringify({ day, deletedAt: now, events: 0, files: perDay.get(day) ?? 0, by: "brain" }) + "\n", { mode: 0o600 });
  }
  if (res.files + res.keys + res.sealed > 0) {
    (opts.log ?? console.log)(`brain: purge removed ${res.files} artefact(s) and ${res.keys} key(s) older than ${KEEP_DAYS} days${res.days.length > 0 ? ` (${res.days.join(", ")})` : ""}; sealed ${res.sealed} plaintext file(s)`);
  }
  return res;
}

export interface ScheduleDeps {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
  log: (line: string) => void;
}

/** Purges now and every hour. Returns a stop function. Errors are logged, never thrown into the timer. */
export function startPurgeSchedule(home: string, now: () => number, deps: Partial<ScheduleDeps> = {}): () => void {
  const log = deps.log ?? ((l: string) => console.log(l));
  const run = () => {
    try {
      purgeExpired(home, now(), { log });
    } catch (err) {
      log(`brain: purge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  run();
  if (deps.setInterval !== undefined) {
    const t = deps.setInterval(run, PURGE_INTERVAL_MS);
    return () => (deps.clearInterval ?? (() => {}))(t);
  }
  const t = setInterval(run, PURGE_INTERVAL_MS);
  t.unref?.();
  return () => clearInterval(t);
}
