// SyncEnvelope checks (ADR 0103 §3) that run before any database work: the signature header, the exact signed bytes,
// RFC 8785 canonical form and the envelope frame. Per-object schema checks happen in ingest, one object at a time.
import { importEs256Public } from "../../auth/jwt.ts";
import { fromB64url, jcs } from "../../schema/encoding.ts";
import { HttpError, invalid } from "../../schema/http.ts";

export const SIGNATURE_HEADER = "Offload-Signature";
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_OBJECTS = 500;
/** sentAt must be within this of server time (ADR 0103 §3). */
export const SENT_AT_WINDOW_MS = 10 * 60_000;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_KEYS = ["deviceId", "objects", "sentAt", "seq", "v"];

export const badSignature = (m = "envelope signature does not verify") => new HttpError(401, "bad_signature", m);
export const replay = (m: string) => new HttpError(409, "replay", m);

/**
 * The request body, at most MAX_ENVELOPE_BYTES. A declared Content-Length over the cap is refused before reading;
 * otherwise the stream is read with a running count and cancelled as soon as it passes the cap, so an oversize body
 * is never buffered whole.
 */
export async function readCapped(req: Request, max = MAX_ENVELOPE_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const tooBig = () => invalid("envelope is over 1 MiB");
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) throw tooBig();
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = req.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(n));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** `keyid=<deviceId>, sig=<b64url>` (the form brain/src/sync/envelope.ts sends); null when malformed. */
export function parseSignatureHeader(h: string | undefined): { keyid: string; sig: string } | null {
  const m = /^keyid=([0-9a-f-]{36}),\s*sig=([A-Za-z0-9_-]+)$/.exec((h ?? "").trim());
  return m === null ? null : { keyid: m[1]!, sig: m[2]! };
}

/** ES256 (raw r || s, 64 bytes) over exactly `bytes` with the device's registered public key. */
export async function verifyBytes(
  jwk: { kty: string; crv: string; x: string; y: string },
  bytes: Uint8Array<ArrayBuffer>,
  sigB64url: string,
): Promise<boolean> {
  const sig = fromB64url(sigB64url);
  if (sig.length !== 64) return false;
  try {
    const key = await importEs256Public(jwk);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, bytes);
  } catch {
    return false;
  }
}

export interface Envelope {
  v: 1;
  deviceId: string;
  seq: number;
  sentAt: number;
  objects: Array<Record<string, unknown> & { id: string }>;
}

/**
 * The signed bytes must be UTF-8 JSON in RFC 8785 form: re-canonicalising them gives the same text. Then the frame:
 * exactly {v: 1, deviceId, seq, sentAt, objects[1..500]}, each object a JSON object with a ULID id. Anything else is
 * 400 for the whole envelope (a receipt cannot name an object without an id).
 */
export function parseEnvelope(bytes: Uint8Array<ArrayBuffer>): Envelope {
  let text: string;
  let data: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    data = JSON.parse(text);
  } catch {
    throw invalid("body is not UTF-8 JSON");
  }
  if (jcs(data) !== text) throw invalid("body is not RFC 8785 (JCS) canonical JSON");
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw invalid("envelope must be an object");
  const e = data as Record<string, unknown>;
  const keys = Object.keys(e).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) {
    throw invalid("envelope fields must be exactly v, deviceId, seq, sentAt, objects");
  }
  if (e.v !== 1) throw invalid("envelope v must be 1");
  if (typeof e.deviceId !== "string" || !UUID.test(e.deviceId)) throw invalid("deviceId must be a uuid");
  if (!Number.isSafeInteger(e.seq) || (e.seq as number) < 1) throw invalid("seq must be an integer >= 1");
  if (!Number.isSafeInteger(e.sentAt) || (e.sentAt as number) < 0) throw invalid("sentAt must be epoch ms");
  const objects = e.objects;
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > MAX_OBJECTS) {
    throw invalid(`objects must hold 1..${MAX_OBJECTS} items`);
  }
  for (const o of objects) {
    if (typeof o !== "object" || o === null || Array.isArray(o) || typeof (o as { id?: unknown }).id !== "string" || !ULID.test((o as { id: string }).id)) {
      throw invalid("every object needs a ULID id");
    }
  }
  return e as unknown as Envelope;
}
