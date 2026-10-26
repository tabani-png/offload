import { safeEqual } from "../schema/encoding.ts";
import { WEBHOOK_TOLERANCE_MS } from "../config.ts";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))).toString("hex");
}

/** `WorkOS-Signature: t=<ms>, v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. */
export async function signWebhook(secret: string, rawBody: string, t: number): Promise<string> {
  return `t=${t}, v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

export async function verifyWebhook(secret: string, header: string | undefined, rawBody: string, now: number): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || typeof v1 !== "string" || Math.abs(now - t) > WEBHOOK_TOLERANCE_MS) return false;
  return safeEqual(v1, await hmacHex(secret, `${t}.${rawBody}`));
}
