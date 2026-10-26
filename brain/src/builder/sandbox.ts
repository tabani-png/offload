// s24 builder sandbox: what the builder agent may touch. Borrowed from Cindy (EVAL.md): "bypass only inside a
// container" (assertSafeExecutionProfile) and the telemetry-off env for Claude Code subprocesses. Everything else is
// ours: a small tool set with no network tools, a Bash allowlist with no shell operators, every path inside the
// workspace, and the frozen check folder (accept/) read-only. On a user Mac the mode is "default" with this allowlist
// as canUseTool; bypassPermissions is refused unless the profile says it runs in a container sandbox.
//
// The allowlist alone does not contain a subprocess (codex review of 72cd137): `python3 file.py` can do anything. So
// every piece of builder-controlled code - the builder's Bash commands and the frozen acceptance check - runs under a
// REAL OS sandbox: macOS sandbox-exec with a deny-default profile (workspace read-write, toolchain read-only, the
// frozen check folder read-only, accept/ read-only, no network) and `env -i` with an explicit allow-list env, so the
// SDK auth in the Claude Code process never reaches a child. In a declared container the container is the sandbox
// (env -i still applies). With neither, the run is refused (fail closed) before the approval is used.
import type { HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { executorEnv } from "../workflows/executor.ts";

/** Built-in tools the builder gets. No WebFetch, WebSearch, Task or MCP. */
export const BUILDER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;
/** Named explicitly so a CLI default can never bring them back. */
export const DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "TodoWrite", "KillShell", "BashOutput"] as const;
export const NETWORK_TOOLS = ["WebFetch", "WebSearch"] as const;
/** First word of an allowed Bash command (bun only as `bun test` / `bun run`). */
export const BASH_ALLOW = ["python3", "bun", "node", "ls", "mkdir", "mv", "cp", "cat", "head", "tail", "wc", "echo"] as const;
export const CHECK_DIR = "accept";

export type ExecutionMode = "allowlist" | "bypass";
export interface ExecutionProfile {
  mode: ExecutionMode;
  /** True only when the caller runs inside a throwaway container (OFFLOAD_BUILDER_SANDBOX=container). */
  containerSandbox: boolean;
}

export class UnsafeProfileError extends Error {}

/** Cindy's rule: bypassPermissions (no prompts, no canUseTool) only inside a container sandbox. */
export function assertSafeExecutionProfile(p: ExecutionProfile): void {
  if (p.mode === "bypass" && !p.containerSandbox) throw new UnsafeProfileError("bypass mode is refused outside a container sandbox; use the allowlist mode on this machine");
}

export function profileFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, mode: ExecutionMode = "allowlist"): ExecutionProfile {
  return { mode, containerSandbox: env.OFFLOAD_BUILDER_SANDBOX === "container" };
}

/** Credentials that must never sit in a process environment during a build: same-user processes, sandboxed builder
 * code included, can read any process's environment through sysctl KERN_PROCARGS2 (the sandbox does not filter it,
 * and `delete process.env.X` does not erase the original). */
export const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Names of credentials present in an environment. */
export function credentialsInEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return CREDENTIAL_ENV.filter((k) => (env[k] ?? "").trim() !== "");
}

const SECRET_NAME = [/(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET_?KEY|AUTH)(_|$)/i, /PASSWORD|PASSWD|SECRET/i, /_KEY$/i];
/** Names that look secret but are not, or that a build tolerates:
 * - TERM_SESSION_ID, SECURITYSESSIONID: terminal / login session ids.
 * - SSH_AUTH_SOCK: a socket path; the sandbox denies connecting to any unix socket but the runner's own.
 * - OFFLOAD_TOKEN: the brain's per-launch bearer for its 127.0.0.1 API, set by the app; sandboxed code has no network,
 *   and its value is a known secret for the artifact scan (secretValues), so copying it fails the build. */
export const SECRET_NAME_ALLOW = new Set(["TERM_SESSION_ID", "SECURITYSESSIONID", "SSH_AUTH_SOCK", "OFFLOAD_TOKEN"]);

/** Names of secret-bearing variables in an environment: a secret-looking name, or a secret-shaped value. */
export function secretEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME_ALLOW.has(k) || v === undefined || v === "") continue;
    if (SECRET_NAME.some((re) => re.test(k)) || findSecret(v) !== null) out.push(k);
  }
  return out.sort();
}

/** This process's ORIGINAL environment as other same-user processes see it (sysctl KERN_PROCARGS2, via `ps -E`):
 * unsetting a variable later does not remove it there. Falls back to process.env if ps cannot answer. */
export function readLaunchEnv(): Record<string, string> {
  const r = spawnSync("/bin/ps", ["-wwE", "-o", "command=", "-p", String(process.pid)], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  if (r.status !== 0 || typeof r.stdout !== "string" || r.stdout.trim() === "") return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const line = r.stdout.replace(/\n$/, "");
  const starts = [...line.matchAll(/(?:^| )([A-Za-z_][A-Za-z0-9_]*)=/g)];
  const env: Record<string, string> = {};
  starts.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : line.length;
    env[m[1]!] = line.slice(from, to);
  });
  return env;
}

/** Test seam: tests run in shells that carry unrelated tokens and give the preflight a clean launch environment. */
export const launchEnv = { read: readLaunchEnv };

/** Env for the Claude Code subprocess: the executor's allowlist minus every credential, plus telemetry off. The key
 * reaches Claude Code through apiKeyHelper instead (runner.ts). */
export function builderEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out = executorEnv(env);
  for (const k of CREDENTIAL_ENV) delete out[k];
  return { ...out, DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

const SHELL_OPS = /[;&|`$<>(){}\\\n\r*?!~'"#]/;

/** realpath of p, or of its nearest existing ancestor with the rest appended (for files not written yet). */
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The path, resolved against the workspace, or null when it leaves the workspace - lexically or through a symlink
 * (the SDK's Read/Write/Edit run in the unsandboxed Claude Code process, so a symlink planted by sandboxed code must
 * not let them reach outside). */
export function insideWorkspace(ws: string, p: string): string | null {
  const abs = resolve(ws, p);
  if (!within(ws, abs)) return null;
  return within(realish(ws), realish(abs)) ? abs : null;
}

/** True when the path is accept/ or inside it - lexically OR canonically (a symlinked alias of accept/ is accept/). */
const inCheckDir = (ws: string, abs: string) => {
  const rel = relative(ws, abs);
  if (rel === CHECK_DIR || rel.startsWith(`${CHECK_DIR}/`)) return true;
  return within(realish(join(ws, CHECK_DIR)), realish(abs));
};

/** True when any existing component of the path below the workspace is a symlink. Writes through one are refused:
 * the SDK file tools run unsandboxed, so a decision on a symlinked path could be swapped after the check. (Sandboxed
 * builder code cannot create symlinks or hard links at all - see sandboxProfile - so this is defence in depth.) */
export function throughSymlink(ws: string, abs: string): boolean {
  const parts = relative(ws, abs).split("/").filter((x) => x !== "" && x !== ".");
  let cur = ws;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false; // the rest does not exist yet
    }
  }
  return false;
}

const writeRefusal = (ws: string, abs: string): string | null => (inCheckDir(ws, abs) ? "the acceptance check is read-only" : throughSymlink(ws, abs) ? "writes through a symlink are refused" : null);

export interface ToolDecision {
  allow: boolean;
  reason: string;
}

export function decideBashCommand(ws: string, command: string): ToolDecision {
  const cmd = command.trim();
  if (cmd === "") return { allow: false, reason: "empty command" };
  if (SHELL_OPS.test(cmd)) return { allow: false, reason: "shell operators are not allowed; run one plain command" };
  const words = cmd.split(/\s+/);
  const head = words[0]!;
  if (!(BASH_ALLOW as readonly string[]).includes(head)) return { allow: false, reason: `${head} is not on the builder's command allowlist (${BASH_ALLOW.join(", ")})` };
  if (head === "bun" && words[1] !== "test" && words[1] !== "run") return { allow: false, reason: "only bun test and bun run are allowed" };
  if (head === "python3" && (words.includes("-m") || words.includes("-c"))) return { allow: false, reason: "python3 runs a file in the workspace, not -m or -c" };
  for (const w of words.slice(1)) {
    if (w.startsWith("-")) continue;
    const abs = insideWorkspace(ws, w);
    if (abs === null) return { allow: false, reason: `${w} is outside the workspace` };
    if (head === "mv" || head === "cp" || head === "mkdir") {
      const no = writeRefusal(ws, abs);
      if (no !== null) return { allow: false, reason: no };
    }
  }
  return { allow: true, reason: "allowlisted command" };
}

export interface ToolLimits {
  /** A Bash call may not ask for a timeout longer than this (the run's wall cap). */
  maxCommandMs?: number;
}

/** The allowlist for one tool call. Unknown tool = deny. */
export function decideTool(ws: string, tool: string, input: Record<string, unknown>, limits: ToolLimits = {}): ToolDecision {
  if ((DISALLOWED_TOOLS as readonly string[]).includes(tool) || tool.startsWith("mcp__")) return { allow: false, reason: `${tool} is not available to the builder` };
  if (!(BUILDER_TOOLS as readonly string[]).includes(tool)) return { allow: false, reason: `${tool} is not on the builder's tool allowlist` };
  if (tool === "Bash") {
    // A background command would outlive the call that started it; every command runs to completion under the
    // supervisor instead.
    if (input.run_in_background === true) return { allow: false, reason: "background commands are not allowed" };
    if (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || (limits.maxCommandMs !== undefined && input.timeout > limits.maxCommandMs)))
      return { allow: false, reason: `a command timeout must be a positive number of ms up to ${limits.maxCommandMs ?? "the run's wall time"}` };
    return typeof input.command === "string" ? decideBashCommand(ws, input.command) : { allow: false, reason: "no command" };
  }
  if (tool === "Glob" && typeof input.pattern === "string" && (isAbsolute(input.pattern) || input.pattern.split("/").includes(".."))) return { allow: false, reason: "the pattern leaves the workspace" };
  const raw = input.file_path ?? input.path ?? ".";
  if (typeof raw !== "string") return { allow: false, reason: "bad path" };
  const abs = insideWorkspace(ws, raw);
  if (abs === null) return { allow: false, reason: `${raw} is outside the workspace` };
  if (tool === "Write" || tool === "Edit") {
    const no = writeRefusal(ws, abs);
    if (no !== null) return { allow: false, reason: no };
  }
  return { allow: true, reason: "inside the workspace" };
}

export interface BuilderPermissions {
  canUseTool: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** Runs in every mode, bypass included: the last line that keeps the check folder read-only, and the place a Bash
   * command is rewritten into the OS sandbox (hooks run before the permission check, for every call). */
  preToolUse: HookCallback;
  denials: Array<{ tool: string; reason: string }>;
}

/** Wraps a plain command so it runs in the OS sandbox with a clean env. `unwrap` recognises an already wrapped one. */
export interface CommandWrapper {
  wrap: (command: string) => string;
  unwrap: (command: string) => string | null;
}

export function builderPermissions(ws: string, wrapper?: CommandWrapper, limits: ToolLimits = {}): BuilderPermissions {
  const denials: BuilderPermissions["denials"] = [];
  const check = (tool: string, input: Record<string, unknown>): ToolDecision & { input: Record<string, unknown> } => {
    let cur = input;
    if (tool === "Bash" && wrapper !== undefined && typeof input.command === "string") {
      const inner = wrapper.unwrap(input.command.trim());
      if (inner !== null) cur = { ...input, command: inner };
    }
    const d = decideTool(ws, tool, cur, limits);
    if (!d.allow) {
      denials.push({ tool, reason: redactSecrets(d.reason) });
      return { ...d, input: cur };
    }
    if (tool === "Bash" && wrapper !== undefined) return { ...d, input: { ...cur, command: wrapper.wrap(String(cur.command).trim()) } };
    return { ...d, input: cur };
  };
  return {
    denials,
    canUseTool: async (tool, input) => {
      const d = check(tool, input);
      return d.allow ? { behavior: "allow", updatedInput: d.input } : { behavior: "deny", message: d.reason };
    },
    preToolUse: async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const d = check(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (!d.allow) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
      // Bash: the same allow decision canUseTool would make, with the sandboxed command.
      if (input.tool_name === "Bash" && wrapper !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "allowlisted command, run in the OS sandbox", updatedInput: d.input } };
      return {};
    },
  };
}

// ---------- the OS sandbox ----------

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const ENV_BIN = "/usr/bin/env";

/** Where builder code may execute: macOS sandbox-exec, or a declared container. */
export type SandboxRuntime = { kind: "sandbox-exec"; bin: string } | { kind: "container" };

const probed = new Map<string, boolean>();
function sandboxExecWorks(bin: string): boolean {
  if (!probed.has(bin)) {
    let ok = false;
    if (process.platform === "darwin" && existsSync(bin)) {
      const r = spawnSync(bin, ["-p", "(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow sysctl-read)(allow mach-lookup)", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
      ok = r.status === 0;
    }
    probed.set(bin, ok);
  }
  return probed.get(bin)!;
}

/** The OS sandbox to run builder code in, or UnsafeProfileError (fail closed: nothing executes unsandboxed). */
export function resolveSandbox(p: ExecutionProfile, bin: string = SANDBOX_EXEC): SandboxRuntime {
  if (p.containerSandbox) return { kind: "container" };
  if (sandboxExecWorks(bin)) return { kind: "sandbox-exec", bin };
  throw new UnsafeProfileError(`no OS sandbox: ${bin} is not usable on this machine (${process.platform}) and the profile is not a container; refusing to run builder code unsandboxed`);
}

function which(cmd: string, env: Readonly<Record<string, string | undefined>>): string | null {
  for (const d of (env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    if (d === "" || !isAbsolute(d)) continue;
    const f = join(d, cmd);
    if (existsSync(f)) return f;
  }
  return null;
}

/** The toolchain the sandbox may read and run: python3, node and this bun, resolved from the parent PATH. */
export function toolchain(env: Readonly<Record<string, string | undefined>> = process.env): { pathDirs: string[]; readOnly: string[] } {
  const bins = [which("python3", env), which("node", env), process.execPath].filter((b): b is string => b !== null);
  const pathDirs = [...new Set([...bins.map((b) => dirname(b)), "/usr/bin", "/bin"])];
  const home = env.HOME === undefined ? null : realish(env.HOME);
  // System dirs by name (not all of /usr: /usr/local is a package prefix with config and data).
  const readOnly = new Set(["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", "/bin", "/sbin", "/System", "/Library/Apple", "/Library/Developer/CommandLineTools", "/private/var/db/dyld", "/private/var/db/timezone", "/dev"]);
  // Package prefixes: binaries, kegs and libraries only - never etc/ or var/ (configs, databases, keys).
  for (const r of ["/opt/homebrew", "/usr/local"]) for (const sub of ["bin", "Cellar", "opt", "lib", "Frameworks"]) if (existsSync(join(r, sub))) readOnly.add(join(r, sub));
  const prefixRoots = new Set(["/", "/usr", "/usr/local", "/opt/homebrew", "/Users", home ?? "/"]);
  for (const b of bins) {
    for (const x of [b, realish(b)]) {
      // The binary's own install prefix (bin/..), never a package root, the home folder or / itself.
      const prefix = dirname(dirname(x));
      readOnly.add(prefixRoots.has(prefix) ? dirname(x) : prefix);
    }
  }
  return { pathDirs, readOnly: [...readOnly].map(realish) };
}

/** The env every builder-controlled process gets: an explicit allow-list, never copied from process.env. */
export function checkEnv(ws: string, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const lang = env.LANG !== undefined && /^[A-Za-z0-9_.@-]{1,40}$/.test(env.LANG) ? env.LANG : "en_US.UTF-8";
  return { PATH: toolchain(env).pathDirs.join(":"), HOME: ws, LANG: lang, TMPDIR: join(ws, ".tmp") };
}

const sbStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Deny-default sandbox-exec profile: workspace read-write (accept/ read-only), frozen checks and toolchain read-only,
 * no network, no other files. */
export function sandboxProfile(o: { ws: string; frozenDir: string; readOnly: readonly string[]; socket?: string }): string {
  const ws = realish(o.ws);
  // Directory listings (names only) of the workspace's ancestors: bun walks up from cwd and refuses to start without.
  const ancestors: string[] = [];
  for (let d = dirname(ws); d !== dirname(d); d = dirname(d)) ancestors.push(d);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    `(allow file-read* (literal "/") ${o.readOnly.map((r) => `(subpath ${sbStr(r)})`).join(" ")})`,
    `(allow file-read* (subpath ${sbStr(realish(o.frozenDir))}))`,
    `(allow file-read* file-write* (subpath ${sbStr(ws)}))`,
    `(deny file-write* (subpath ${sbStr(join(ws, CHECK_DIR))}) (subpath ${sbStr(realish(o.frozenDir))}))`,
    // No links at all: a symlink or hard link made by sandboxed code could steer the unsandboxed SDK file tools.
    "(deny file-write-create (vnode-type SYMLINK))",
    "(deny file-link)",
    '(allow file-write* file-ioctl (literal "/dev/null") (literal "/dev/tty"))',
    // A process may reopen its own already-open descriptors (bun writes its JUnit report to the harness pipe).
    '(allow file-read* file-write* (regex #"^/dev/fd/[0-9]+$"))',
    ...(ancestors.length > 0 ? [`(allow file-read-data ${ancestors.map((a) => `(literal ${sbStr(a)})`).join(" ")})`] : []),
    "(deny file-write-create (vnode-type FIFO))",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    // The runner's command socket: sandboxed processes may CONNECT to it, nothing else (no bind, no unlink, no
    // write); the unsandboxed runner owns and listens on it. It accepts `run` only.
    ...(o.socket === undefined ? [] : [`(allow network-outbound (remote unix-socket (path-literal ${sbStr(realish(o.socket))})))`]),
    "(deny network*)",
    "",
  ].join("\n");
}

const shq = (s: string) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** argv prefix that runs a program in the sandbox with exactly `env`. */
export function sandboxArgv(rt: SandboxRuntime, profilePath: string, env: Record<string, string>): string[] {
  const envArgs = [ENV_BIN, "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  return rt.kind === "sandbox-exec" ? [rt.bin, "-f", profilePath, ...envArgs] : envArgs;
}

/** argv prefix for a builder command: the sandbox, then the trusted harness, which sweeps every process the command
 * left behind (harness.ts) when it ends. */
export function harnessArgv(rt: SandboxRuntime, profilePath: string, env: Record<string, string>, harnessPath: string): string[] {
  return [...sandboxArgv(rt, profilePath, env), "python3", "-I", harnessPath];
}
export const sweepMode = (rt: SandboxRuntime) => (rt.kind === "sandbox-exec" ? "sweep" : "nosweep");

/** A builder command becomes a sandboxed client that hands the argv to the runner's command socket; the runner relays
 * it over a private pipe to the per-run supervisor (harness.ts "serve"), which runs it as its own child inside the
 * one supervisor sandbox instance and sweeps that instance afterwards. */
export function commandWrapper(rt: SandboxRuntime, profilePath: string, env: Record<string, string>, harnessPath: string, socket: string): CommandWrapper {
  const prefix = [...harnessArgv(rt, profilePath, env, harnessPath), "client", sweepMode(rt), socket, "--"].map(shq).join(" ") + " ";
  return { wrap: (c) => prefix + c, unwrap: (c) => (c.startsWith(prefix) ? c.slice(prefix.length) : null) };
}

// ---------- secret redaction ----------

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KV = /\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^\s"']{8,})/gi;

/** The first secret in a text: an exact known value, or a secret-shaped string (keys, tokens, private keys). Used to
 * scan artifacts, so the loose NAME=value pattern of redactSecrets is not applied (it would flag ordinary code). */
export function findSecret(text: string, known: readonly string[] = []): string | null {
  for (const v of known) if (v.length >= 8 && text.includes(v)) return "a known secret value";
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      return "a secret-shaped string";
    }
  }
  return null;
}

/** Values of secret-named variables in an env (for exact-value redaction). */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v !== undefined && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL/i.test(k))
    .map(([, v]) => v!);
}

/** Text with secret-shaped strings and the given exact values replaced by [REDACTED]. For anything persisted or fed
 * back into a prompt. */
export function redactSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const v of [...known].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)) out = out.split(v).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  out = out.replace(BEARER, (_m, kind: string) => `${kind} [REDACTED]`);
  out = out.replace(KV, (m, _k: string, v: string) => (v === "[REDACTED]" ? m : m.replace(v, "[REDACTED]")));
  return out;
}
