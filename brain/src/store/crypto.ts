// Line encryption per docs/store-contract.md: base64( nonce(12) | AES-256-GCM ciphertext | tag(16) ) over UTF-8 JSON.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export type CryptoFailure = "invalid_base64" | "decrypt_failed" | "invalid_key";

export class LineCryptoError extends Error {
  constructor(
    readonly reason: CryptoFailure,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "LineCryptoError";
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new LineCryptoError("invalid_key", `key must be ${KEY_BYTES} bytes, got ${key.length}`);
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Encrypts one line. `nonce` is only for deterministic fixtures; production callers omit it. */
export function encryptLine(key: Uint8Array, plaintext: string, nonce: Uint8Array = randomBytes(NONCE_BYTES)): string {
  assertKey(key);
  if (nonce.length !== NONCE_BYTES) throw new LineCryptoError("invalid_key", `nonce must be ${NONCE_BYTES} bytes`);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

export function decryptLine(key: Uint8Array, line: string): string {
  assertKey(key);
  const trimmed = line.trim();
  if (!BASE64_RE.test(trimmed) || trimmed.length % 4 !== 0) throw new LineCryptoError("invalid_base64", "line is not base64");
  const raw = Buffer.from(trimmed, "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new LineCryptoError("decrypt_failed", "line shorter than nonce + tag");
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new LineCryptoError("decrypt_failed", err instanceof Error ? err.message : String(err));
  }
}
