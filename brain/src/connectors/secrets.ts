// s13: a credential for the direct-API method is only ever a REFERENCE: an env var name, or a macOS Keychain generic
// password item (service + account). The value is read in memory for one request and dropped. It is never written to
// a file, put in a log line, an error message, a DTO or a child process environment. `redact` removes any value that
// slipped into a text before it leaves the module.
import type { Env } from "./config.ts";
import { linkEnv, type LinkRunner } from "./link.ts";

import type { SecretRef } from "./api-config.ts";

export { secretRefError, type SecretRef } from "./api-config.ts";

export class SecretUnavailable extends Error {}

/** Reads a secret value by reference. Tests inject a fake; the default reads env or runs `security`. */
export interface SecretReader {
  read(ref: SecretRef): Promise<string>;
}

export const SECURITY_TIMEOUT_MS = 5_000;

/** Plain words for where the secret was expected, never the value. */
export const describeRef = (ref: SecretRef) => ("fromEnv" in ref ? `the setting ${ref.fromEnv}` : `the Keychain item ${ref.keychain.service}`);

export class DefaultSecretReader implements SecretReader {
  constructor(
    private readonly env: Env,
    private readonly runner: LinkRunner,
  ) {}

  async read(ref: SecretRef): Promise<string> {
    if ("fromEnv" in ref) {
      const v = this.env[ref.fromEnv];
      if (v === undefined || v === "") throw new SecretUnavailable(`${describeRef(ref)} is not set`);
      return v;
    }
    // `security find-generic-password -w` prints only the password on stdout. The argv names the item, not the value.
    const r = await this.runner.run(["security", "find-generic-password", "-s", ref.keychain.service, "-a", ref.keychain.account, "-w"], { timeoutMs: SECURITY_TIMEOUT_MS, env: linkEnv(this.env) });
    const v = r.stdout.replace(/\r?\n$/, "");
    if (r.code !== 0 || v === "") throw new SecretUnavailable(`${describeRef(ref)} could not be read (exit ${String(r.code)})`);
    return v;
  }
}

/** Replaces every occurrence of each secret (and its base64 form) with [redacted]. Values under 4 chars are skipped. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 4) continue;
    for (const form of [s, Buffer.from(s).toString("base64"), encodeURIComponent(s)]) out = out.split(form).join("[redacted]");
  }
  return out;
}
