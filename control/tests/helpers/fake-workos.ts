import type { WorkOSIdentity } from "../../src/auth/workos.ts";
import type { Jwk, SigningKey } from "../../src/auth/jwt.ts";
import { signJwt } from "../../src/auth/jwt.ts";
import { signWebhook } from "../../src/auth/webhook.ts";
import { randomToken } from "../../src/schema/encoding.ts";

export const FAKE_AUTHKIT_URL = "https://authkit.fake.test/authorize";
export const WEBHOOK_SECRET = "whsec_test_offload";

export interface FakeLogin {
  userId: string;
  email: string;
  orgId: string | null;
  firstName?: string;
  lastName?: string;
}

/**
 * In-memory WorkOS: AuthKit authorization URL + code exchange, an RS256 JWKS for access tokens (as WorkOS signs
 * them), session revocation, invitations and signed Directory Sync webhooks. No network.
 */
export class FakeWorkOS implements WorkOSIdentity {
  private codes = new Map<string, FakeLogin & { sid: string }>();
  readonly revokedSessions: string[] = [];
  readonly invitations: Array<{ email: string; organizationId: string }> = [];
  private constructor(private key: SigningKey, private now: () => number) {}

  static async create(now: () => number): Promise<FakeWorkOS> {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
    return new FakeWorkOS({ kid: "fake-workos-1", privateKey: pair.privateKey, publicJwk: { ...pub, kid: "fake-workos-1", alg: "RS256" } }, now);
  }

  /** What AuthKit would redirect back with after the user signed in. */
  issueCode(login: FakeLogin): string {
    const code = randomToken(16);
    this.codes.set(code, { ...login, sid: `session_${randomToken(8)}` });
    return code;
  }

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    return `${FAKE_AUTHKIT_URL}?${new URLSearchParams({ provider: "authkit", state, redirect_uri: redirectUri })}`;
  }

  async authenticateWithCode(code: string) {
    const l = this.codes.get(code);
    if (!l) throw new Error("invalid_grant");
    this.codes.delete(code);
    const iat = Math.floor(this.now() / 1000);
    const accessToken = await signJwt(
      { sub: l.userId, sid: l.sid, ...(l.orgId ? { org_id: l.orgId } : {}), iat, exp: iat + 300 },
      this.key,
    );
    return {
      user: { id: l.userId, email: l.email, firstName: l.firstName ?? null, lastName: l.lastName ?? null },
      organizationId: l.orgId,
      accessToken,
    };
  }

  async jwks() {
    return { keys: [this.key.publicJwk] };
  }

  async revokeSession(sessionId: string) {
    this.revokedSessions.push(sessionId);
  }

  async sendInvitation(email: string, organizationId: string) {
    this.invitations.push({ email, organizationId });
  }

  /** A Directory Sync webhook request body + headers, signed like WorkOS does. */
  async webhook(event: string, data: Record<string, unknown>, opts: { secret?: string; at?: number } = {}) {
    const body = JSON.stringify({ id: `event_${randomToken(8)}`, event, data, created_at: new Date(this.now()).toISOString() });
    const sig = await signWebhook(opts.secret ?? WEBHOOK_SECRET, body, opts.at ?? this.now());
    return { body, headers: { "WorkOS-Signature": sig, "Content-Type": "application/json" } };
  }
}
