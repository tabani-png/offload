// Deterministic ids and hashes for fixtures. No clock, no randomness: the same fixture every run.

export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-shaped id: a fixed time prefix plus `n` in Crockford base32. */
export function ulid(n: number): string {
  let s = "";
  let v = n;
  for (let i = 0; i < 16; i++) {
    s = CROCKFORD[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return `01K8D2Q4M0${s}`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 64 hex chars derived from `seed`. Fixture stand-in for sha256; never used for security. */
export function hex64(seed: string): string {
  let out = "";
  for (let i = 0; out.length < 64; i++) out += fnv1a(`${seed}:${i}`).toString(16).padStart(8, "0");
  return out.slice(0, 64);
}

export const hex32 = (seed: string): string => hex64(seed).slice(0, 32);
