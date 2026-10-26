// The plain process basics a child process may get: a pure allowlist, never a sign-in, a token, OFFLOAD_* or a
// connector secret (REVIEW-1 L5, REVIEW-2 N6). Sign-in for an Agent SDK child is decided ONLY by
// models/agent-auth.ts agentSdkAuth (s27 round 13); the connector runners (linkEnv) and the builder start from here.
const CHILD_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

export function baseChildEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOW) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}
