// The device signing key (ADR 0103 §3, ADR 0102 §3): P-256 / ES256 through WebCrypto. The private key is the 32-byte
// scalar stored as the brain key `device-signing` (sync/keys.ts: observer-wrapped, or a raw file under
// OFFLOAD_KEYS=file in tests); it is imported as a non-extractable CryptoKey and held in memory while the brain runs.
// `DeviceSigner` is the seam for a hardware key: a Secure Enclave signer (the private key never leaves the enclave)
// implements the same two calls through a bridge the Swift app provides. Secure Enclave keys are a later hardening.
import { createECDH } from "node:crypto";
import { b64url, fromB64url } from "./encoding.ts";
import { DEVICE_SIGNING, syncKey } from "./keys.ts";
import type { ObserverEnv } from "../store/observer.ts";

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface DeviceSigner {
  readonly kind: "software" | "secure_enclave";
  publicJwk(): Promise<PublicJwk>;
  /** ES256 over `data`: 64 bytes r || s (JWS form). */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;
// Order of the P-256 group: a valid private scalar is in [1, n-1].
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** A software P-256 key from its 32-byte private scalar. */
export class SoftwareSigner implements DeviceSigner {
  readonly kind = "software" as const;
  private readonly jwk: PublicJwk;
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly d: Uint8Array) {
    if (d.length !== 32) throw new Error("device key must be 32 bytes");
    const n = BigInt(`0x${Buffer.from(d).toString("hex")}`);
    if (n === 0n || n >= P256_N) throw new Error("device key is not a valid P-256 scalar");
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(d));
    const pub = ecdh.getPublicKey(); // 0x04 | x(32) | y(32)
    this.jwk = { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) };
  }

  async publicJwk(): Promise<PublicJwk> {
    return { ...this.jwk };
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    this.key ??= crypto.subtle.importKey("jwk", { ...this.jwk, d: b64url(this.d), ext: false }, ALG, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign(SIG, await this.key, Uint8Array.from(data)));
  }
}

/** What the app's Secure Enclave code provides (S2-13 / later hardening): the public point and a signature. */
export interface SecureEnclaveBridge {
  publicPoint(): Promise<{ x: Uint8Array; y: Uint8Array }>;
  signEs256(data: Uint8Array): Promise<Uint8Array>;
}

export class SecureEnclaveSigner implements DeviceSigner {
  readonly kind = "secure_enclave" as const;
  constructor(private readonly bridge: SecureEnclaveBridge) {}
  async publicJwk(): Promise<PublicJwk> {
    const p = await this.bridge.publicPoint();
    return { kty: "EC", crv: "P-256", x: b64url(p.x), y: b64url(p.y) };
  }
  async sign(data: Uint8Array): Promise<Uint8Array> {
    const s = await this.bridge.signEs256(data);
    if (s.length !== 64) throw new Error("secure enclave signature must be 64 bytes r || s");
    return s;
  }
}

/** The device's signer from the stored `device-signing` key (created on first use when `create`). */
export function loadDeviceSigner(home: string, opts: { create: boolean; env?: ObserverEnv }): SoftwareSigner | null {
  const d = syncKey(home, DEVICE_SIGNING, opts);
  return d === null ? null : new SoftwareSigner(d);
}

/** ES256 verification with a public JWK (the control plane's check; used by tests and the fake server). */
export async function verifyEs256(jwk: PublicJwk, data: Uint8Array, sig: Uint8Array | string): Promise<boolean> {
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, ALG, false, ["verify"]);
  return crypto.subtle.verify(SIG, key, Uint8Array.from(typeof sig === "string" ? fromB64url(sig) : sig), Uint8Array.from(data));
}
