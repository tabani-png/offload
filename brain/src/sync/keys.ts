// Named brain keys for sync: `device-signing` (the P-256 private scalar) and `device-evidence` (the HMAC key behind
// instance refs). Same store contract as the brain's day keys (docs/store-contract.md "Brain keys"): by default the
// observer keeps them wrapped with its Keychain master key (`offload-observer wrap-key --name NAME`, never replacing a
// stored key; `unwrap-key --name NAME`), base64 on stdout. OFFLOAD_KEYS=file (tests, fixtures): raw 32-byte files in
// $OFFLOAD_HOME/brain-keys/NAME.key (0600). Names are not dates, so the 7-day purge keeps them (otherBrainKeys).
// Unwrapped bytes stay in this process's memory only.
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runObserverSync, type ObserverEnv } from "../store/observer.ts";
import { brainKeyMode, brainKeysDir, BrainKeyError } from "../store/vault.ts";

export const DEVICE_SIGNING = "device-signing";
export const DEVICE_EVIDENCE = "device-evidence";
const KEY_BYTES = 32;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const cache = new Map<string, Uint8Array>();
export const clearSyncKeyCache = () => cache.clear();

export const rawKeyPath = (home: string, name: string) => join(brainKeysDir(home), `${name}.key`);
export const wrappedKeyPath = (home: string, name: string) => join(home, "keys", `brain-${name}.key`);

function rawKey(home: string, name: string, create: boolean): Uint8Array | null {
  const p = rawKeyPath(home, name);
  if (!existsSync(p)) {
    if (!create) return null;
    mkdirSync(brainKeysDir(home), { recursive: true, mode: 0o700 });
    chmodSync(brainKeysDir(home), 0o700);
    // Create-if-absent, atomically: a stored key is never replaced (that would orphan what it signed or keyed).
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600 });
    try {
      linkSync(tmp, p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const k = readFileSync(p);
  if (k.length !== KEY_BYTES) throw new BrainKeyError(`brain key ${name}: not a ${KEY_BYTES}-byte key file`);
  return new Uint8Array(k);
}

function observerKey(home: string, name: string, create: boolean, env: ObserverEnv): Uint8Array | null {
  if (!create && !existsSync(wrappedKeyPath(home, name))) return null;
  const r = runObserverSync(home, [create ? "wrap-key" : "unwrap-key", "--name", name], env, { drop: ["OFFLOAD_KEYS"] });
  if (!r.ok) throw new BrainKeyError(`brain key ${name}: ${r.error}`);
  const line = r.stdout.trim();
  const k = /^[A-Za-z0-9+/]+=*$/.test(line) ? Buffer.from(line, "base64") : Buffer.alloc(0);
  if (k.length !== KEY_BYTES) throw new BrainKeyError(`brain key ${name}: the observer did not print a ${KEY_BYTES}-byte base64 key`);
  return new Uint8Array(k);
}

/** The named key, created on first use when `create`. null when absent and not created. Throws BrainKeyError when the
 * observer cannot provide it (never falls back to a raw file in keychain mode). */
export function syncKey(home: string, name: string, opts: { create: boolean; env?: ObserverEnv }): Uint8Array | null {
  if (!NAME_RE.test(name)) throw new Error(`bad key name ${name}`);
  const env = opts.env ?? process.env;
  const ck = `${home}\u0000${name}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  const k = brainKeyMode(env, home) === "file" ? rawKey(home, name, opts.create) : observerKey(home, name, opts.create, env);
  if (k !== null) cache.set(ck, k);
  return k;
}
