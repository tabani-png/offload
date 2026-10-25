import { b64url, fromB64url } from "../schema/encoding.ts";


export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
  ext?: boolean;
  key_ops?: string[];
}

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** WebCrypto's JsonWebKey type is DOM-only; our Jwk is structurally the same. */
function importJwk(jwk: Jwk, algo: typeof ES256 | typeof RS256, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return crypto.subtle.importKey("jwk", jwk as any, algo, false, usages);
}

export async function importEs256Public(jwk: { kty: string; crv: string; x: string; y: string }): Promise<CryptoKey> {
  return importJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, ES256, ["verify"]);
}

/** Verifies a raw (r||s, 64 byte) base64url ES256 signature over the UTF-8 bytes of `message`. */
export async function verifyEs256(key: CryptoKey, message: string, sigB64url: string): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromB64url(sigB64url);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(message));
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Jwk;
}

export async function generateEs256SigningKey(kid = "control-1"): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(ES256, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  return { kid, privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: "ES256" } };
}

export async function importEs256SigningKey(privateJwk: Jwk): Promise<SigningKey> {
  const kid = privateJwk.kid ?? "control-1";
  const privateKey = await importJwk(privateJwk, ES256, ["sign"]);
  const { d: _d, key_ops: _k, ...pub } = privateJwk;
  return { kid, privateKey, publicJwk: { ...pub, kid, alg: "ES256" } };
}

function enc(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}

export async function signJwt(claims: Record<string, unknown>, key: SigningKey): Promise<string> {
  const alg = key.privateKey.algorithm.name === "ECDSA" ? "ES256" : "RS256";
  const input = `${enc({ alg, typ: "JWT", kid: key.kid })}.${enc(claims)}`;
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : RS256;
  const sig = await crypto.subtle.sign(params, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

export interface VerifyOpts {
  audience?: string;
  issuer?: string;
  now: number;
}

/** Verifies an ES256 or RS256 JWT against a JWKS. Returns the claims or null; never throws on bad input. */
export async function verifyJwt(
  token: string,
  jwks: { keys: Jwk[] },
  opts: VerifyOpts,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as Record<string, unknown>;
    if (header.alg !== "ES256" && header.alg !== "RS256") return null;
    const jwk = jwks.keys.find((k) => (header.kid ? k.kid === header.kid : true));
    if (!jwk) return null;
    const algo = header.alg === "ES256" ? ES256 : RS256;
    if ((header.alg === "ES256") !== (jwk.kty === "EC")) return null;
    const { d: _d, ...pub } = jwk;
    const key = await importJwk(pub, algo, ["verify"]);
    const params = header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : RS256;
    const ok = await crypto.subtle.verify(
      params,
      key,
      fromB64url(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const exp = claims.exp;
    if (typeof exp !== "number" || exp * 1000 <= opts.now) return null;
    if (typeof claims.nbf === "number" && claims.nbf * 1000 > opts.now + 30_000) return null;
    if (opts.audience !== undefined) {
      const aud = claims.aud;
      if (!(aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience)))) return null;
    }
    if (opts.issuer !== undefined && claims.iss !== opts.issuer) return null;
    return claims;
  } catch {
    return null;
  }
}
