// s27 round 13: the ONE way an Agent SDK (Claude Code) child signs in, for every caller (the workflow executor,
// AgentSdkModel; the builder keeps its own sandboxed path, see the SPEC). Manager decision (BYOK API key first):
//   an API key (Keychain reference OFFLOAD_ANTHROPIC_KEYCHAIN, or ANTHROPIC_API_KEY in the brain's env) -> a 0700
//     apiKeyHelper script (the builder's writeCredentialHelper, reused) in a fresh 0700 folder; no key and no OAuth
//     token in the child env;
//   no API key but a Claude Code OAuth token -> the token in the child env, never through apiKeyHelper (that is
//     API-key auth), with one warning line in the brain log;
//   neither -> NoClaudeKeyError ("add a key in Settings"): nothing starts.
// The env is baseChildEnv (a pure allowlist) plus, for OAuth only, CLAUDE_CODE_OAUTH_TOKEN.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentialHelper } from "../builder/runner.ts";
import { baseChildEnv } from "./child-env.ts";

export const NO_KEY_WORDS = "No Claude key is set up: add a key in Settings.";
const OAUTH_WARNING = "brain: Claude Code signs in with an OAuth token passed in its environment (no API key is set up; add one in Settings to use the Keychain instead)";

export class NoClaudeKeyError extends Error {
  constructor() {
    super(NO_KEY_WORDS);
  }
}

export interface AgentSdkAuth {
  kind: "api_key" | "oauth";
  /** The child's whole environment. */
  env: Record<string, string>;
  /** Set for an API key: Claude Code runs it to get the key. */
  settings?: { apiKeyHelper: string };
  /** For api_key: the helper script (tests). */
  helper?: string;
  /** Removes the helper folder (a no-op for OAuth). Always call it when the child is done. */
  cleanup: () => void;
}

/** The Claude sign-in for one Agent SDK child. Throws NoClaudeKeyError when neither a key nor a token is set up. */
export function agentSdkAuth(env: Readonly<Record<string, string | undefined>> = process.env, log: (line: string) => void = (l) => console.error(l)): AgentSdkAuth {
  const base = baseChildEnv(env);
  // The OAuth token is never handed to the helper as if it were an API key.
  const keyEnv = { ...env, CLAUDE_CODE_OAUTH_TOKEN: undefined };
  const dir = mkdtempSync(join(tmpdir(), "offload-key-"));
  chmodSync(dir, 0o700);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let c: ReturnType<typeof writeCredentialHelper>;
  try {
    c = writeCredentialHelper(join(dir, "cred"), keyEnv);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (c !== null) return { kind: "api_key", env: base, settings: { apiKeyHelper: c.command }, helper: c.helper, cleanup };
  cleanup();
  const token = (env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (token !== "") {
    log(OAUTH_WARNING);
    return { kind: "oauth", env: { ...base, CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN! }, cleanup: () => {} };
  }
  throw new NoClaudeKeyError();
}
