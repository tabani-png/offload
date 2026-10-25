import type { Jwk } from "./auth/jwt.ts";

export interface Config {
  /** offload_app connection (not owner, no BYPASSRLS). */
  appPgUrl: string;
  /** offload_migrator connection, used only by the migration runner. */
  migratorPgUrl: string;
  dbSchema?: string;
  workos: {
    apiKey: string;
    clientId: string;
    redirectUri: string;
    webhookSecret: string;
    /** `iss` every AuthKit access token must carry. */
    issuer: string;
    /** When set, `aud` must contain it; otherwise an `aud` claim, if present, must contain clientId. */
    audience?: string;
  };
  /** Private ES256 JWK that signs device access tokens. */
  deviceSigningJwk?: Jwk;
  /** Validate every response against its schema (on in tests, cheap enough to leave on). */
  validateResponses: boolean;
  /** Where /auth/callback sends the browser after login. */
  afterLoginPath: string;
}

function need(env: Record<string, string | undefined>, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    appPgUrl: need(env, "OFFLOAD_APP_PG_URL"),
    migratorPgUrl: need(env, "OFFLOAD_PG_URL"),
    ...(env.OFFLOAD_DB_SCHEMA ? { dbSchema: env.OFFLOAD_DB_SCHEMA } : {}),
    workos: {
      apiKey: need(env, "WORKOS_API_KEY"),
      clientId: need(env, "WORKOS_CLIENT_ID"),
      redirectUri: need(env, "WORKOS_REDIRECT_URI"),
      webhookSecret: need(env, "WORKOS_WEBHOOK_SECRET"),
      // Required, not guessed: the issuer differs between the default and a custom AuthKit domain. Copy it from a
      // decoded access token of the environment.
      issuer: need(env, "WORKOS_ISSUER"),
      ...(env.WORKOS_AUDIENCE ? { audience: env.WORKOS_AUDIENCE } : {}),
    },
    deviceSigningJwk: JSON.parse(need(env, "OFFLOAD_DEVICE_SIGNING_JWK")) as Jwk,
    validateResponses: env.OFFLOAD_VALIDATE_RESPONSES !== "0",
    afterLoginPath: env.OFFLOAD_AFTER_LOGIN_PATH ?? "/",
  };
}

/** Session lifetimes (ADR 0102 §2). */
export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
export const SESSION_IDLE_PRIVILEGED_MS = 30 * 60_000;
export const SESSION_IDLE_MS = 8 * 3600_000;
/** Device auth (ADR 0102 §3). */
export const ENROLLMENT_CODE_TTL_MS = 10 * 60_000;
export const DEVICE_NONCE_TTL_MS = 5 * 60_000;
/** Live (unexpired) challenge nonces one device may hold; more is 429 until the oldest expires. */
export const DEVICE_NONCES_PER_WINDOW = 10;
export const DEVICE_TOKEN_TTL_MS = 15 * 60_000;
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
