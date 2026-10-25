// base64url without padding (RFC 7515 §2), hex, and the Crockford base32 ULIDs every sync object id uses.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return new Uint8Array(Buffer.from(s, "base64url"));
}
export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
export const hmacHex = (key: Uint8Array, msg: string): string => createHmac("sha256", key).update(msg, "utf8").digest("hex");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** ULID of time `ts` (ms) with 80 bits from `entropy` (at least 10 bytes; default random). */
export function ulid(ts: number, entropy: Uint8Array = randomBytes(10)): string {
  if (!Number.isInteger(ts) || ts < 0 || ts > 2 ** 48 - 1) throw new Error(`ulid: bad time ${ts}`);
  if (entropy.length < 10) throw new Error("ulid: needs 10 bytes of entropy");
  let time = "";
  let t = ts;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  // 80 bits = 16 base32 digits, 5 bits each, most significant first.
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(entropy[i]!);
  let rand = "";
  for (let i = 15; i >= 0; i--) rand += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)]!;
  return time + rand;
}

/** The time (ms) encoded in a ULID's first 10 characters. */
export function ulidTime(id: string): number {
  if (!ULID_RE.test(id)) throw new Error("ulidTime: not a ULID");
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/** A deterministic ULID: the same (key, seed, ts) gives the same id, so re-projecting an object never duplicates it. */
export const ulidFrom = (key: Uint8Array, seed: string, ts: number): string => ulid(ts, createHmac("sha256", key).update(`ulid\u0000${seed}`, "utf8").digest().subarray(0, 10));
