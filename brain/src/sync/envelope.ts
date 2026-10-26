// SyncEnvelope (ADR 0103 §3): { v: 1, deviceId, seq, sentAt, objects[] }, at most 500 objects and 1 MiB of JCS bytes,
// signed ES256 over exactly those bytes, sent as `Offload-Signature: keyid=<deviceId>, sig=<b64url>`. The body on the
// wire IS the canonical text, so the server verifies the bytes it received.
import { b64url } from "./encoding.ts";
import { canonicalize } from "./jcs.ts";
import type { DeviceSigner } from "./device.ts";
import type { SyncEnvelope, SyncObject } from "./types.ts";

export const MAX_OBJECTS = 500;
export const MAX_BYTES = 1024 * 1024;
export const SIGNATURE_HEADER = "Offload-Signature";

const utf8Len = (s: string) => Buffer.byteLength(s, "utf8");

/** Groups objects (in order) into envelopes that each fit the limits. The envelope's fixed part is counted, with the
 * widest seq/sentAt it can have, so a later seq cannot push a full envelope over 1 MiB. */
export function splitObjects(objects: readonly SyncObject[], deviceId: string, maxObjects = MAX_OBJECTS, maxBytes = MAX_BYTES): SyncObject[][] {
  const frame = utf8Len(canonicalize({ v: 1, deviceId, seq: Number.MAX_SAFE_INTEGER, sentAt: Number.MAX_SAFE_INTEGER, objects: [] }));
  const out: SyncObject[][] = [];
  let cur: SyncObject[] = [];
  let bytes = frame;
  for (const o of objects) {
    const n = utf8Len(canonicalize(o));
    if (frame + n > maxBytes) throw new Error(`sync object ${o.id} alone is over ${maxBytes} bytes`);
    const add = n + (cur.length > 0 ? 1 : 0); // the comma
    if (cur.length >= maxObjects || bytes + add > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = frame;
    }
    bytes += n + (cur.length > 0 ? 1 : 0);
    cur.push(o);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export interface SignedEnvelope {
  envelope: SyncEnvelope;
  /** The JCS text: the exact request body. */
  body: string;
  signature: string;
  header: string;
}

export const signatureHeader = (deviceId: string, sig: string) => `keyid=${deviceId}, sig=${sig}`;

/** Parses `keyid=<id>, sig=<b64url>`; null when malformed. */
export function parseSignatureHeader(h: string | null): { keyid: string; sig: string } | null {
  const m = /^keyid=([0-9a-f-]{36}),\s*sig=([A-Za-z0-9_-]+)$/.exec((h ?? "").trim());
  return m === null ? null : { keyid: m[1]!, sig: m[2]! };
}

export async function signEnvelope(envelope: SyncEnvelope, signer: DeviceSigner): Promise<SignedEnvelope> {
  const body = canonicalize(envelope);
  if (utf8Len(body) > MAX_BYTES) throw new Error("envelope over 1 MiB");
  if (envelope.objects.length > MAX_OBJECTS || envelope.objects.length === 0) throw new Error("an envelope holds 1-500 objects");
  const signature = b64url(await signer.sign(new TextEncoder().encode(body)));
  return { envelope, body, signature, header: signatureHeader(envelope.deviceId, signature) };
}
