import { WorkOS } from "@workos-inc/node";
import type { Jwk } from "./jwt.ts";

/** The narrow slice of WorkOS the control plane uses (ADR 0110). Tests use a fake; nothing else calls WorkOS. */
export interface WorkOSIdentity {
  authorizationUrl(opts: { state: string; redirectUri: string }): string;
  authenticateWithCode(code: string): Promise<{
    user: { id: string; email: string; firstName: string | null; lastName: string | null };
    organizationId: string | null;
    accessToken: string;
  }>;
  /** JWKS that signs AuthKit access tokens. */
  jwks(): Promise<{ keys: Jwk[] }>;
  revokeSession(sessionId: string): Promise<void>;
  sendInvitation(email: string, organizationId: string): Promise<void>;
}

/** Production adapter over the WorkOS Node SDK. */
export function workosSdk(opts: { apiKey: string; clientId: string }): WorkOSIdentity {
  const client = new WorkOS(opts.apiKey, { clientId: opts.clientId });
  let cached: { at: number; jwks: { keys: Jwk[] } } | null = null;
  return {
    authorizationUrl: ({ state, redirectUri }) =>
      client.userManagement.getAuthorizationUrl({ provider: "authkit", clientId: opts.clientId, redirectUri, state }),
    async authenticateWithCode(code) {
      const r = await client.userManagement.authenticateWithCode({ clientId: opts.clientId, code });
      return {
        user: { id: r.user.id, email: r.user.email, firstName: r.user.firstName, lastName: r.user.lastName },
        organizationId: r.organizationId ?? null,
        accessToken: r.accessToken,
      };
    },
    async jwks() {
      if (cached && Date.now() - cached.at < 3600_000) return cached.jwks;
      const res = await fetch(client.userManagement.getJwksUrl(opts.clientId));
      if (!res.ok) throw new Error(`WorkOS JWKS ${res.status}`);
      cached = { at: Date.now(), jwks: (await res.json()) as { keys: Jwk[] } };
      return cached.jwks;
    },
    revokeSession: (sessionId) => client.userManagement.revokeSession({ sessionId }),
    async sendInvitation(email, organizationId) {
      await client.userManagement.sendInvitation({ email, organizationId });
    },
  };
}
