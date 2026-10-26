// s24 brief runner: the outcome loop the Cindy eval asked for (EVAL.md "BORROW"). After the exact single-use build
// approval (approval.ts), each try is one Agent SDK query() (ADR 0004) in a fresh workspace with the builder prompt;
// then the RUNNER, not the model, verifies the frozen check's sha256 and runs it. PASS = exit 0 AND the trusted
// harness's completion proof carrying this run's nonce (harness.ts); exit 0 alone never passes. A failure feeds the
// exact (truncated) check output into the next try. Caps: tries, USD, turns per try, wall time. DRY RUN: the files
// stay in the workspace; installing them on the user's system is a separate approval (not here).
// Isolation: the frozen master lives OUTSIDE the workspace (builds/<run>/frozen/). The check executes as
// workspace/accept/<file>, which the OS sandbox makes read-only and which is hash-checked against the master right
// before and after every run. The check never loads builder code into its own process (it runs the built tool as a
// subprocess with cwd = workspace); the harness refuses such imports and, when the check or any builder command ends,
// kills every process left in that sandbox instance (fork + setsid daemons included). The check runs async, bounded
// by the remaining wall budget and stopped by the wall abort; a result after the deadline never counts. The
// workspace is hashed at the verdict (record.artifactSha256, verifyArtifact). The approval is verified first and
// claimed atomically LAST, after setup, so a setup failure does not burn it. Builder Bash commands are rewritten
// into the same sandbox + harness. No usable sandbox = UnsafeProfileError before the approval is consumed. Check output is
// secret-redacted before it is stored or fed into the next prompt. Limits are validated before the approval is used.
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TIER_MODELS } from "../models/router.ts";
import { BriefError, type SolutionBrief } from "../solutions/brief.ts";
import { resolveAnthropicKey } from "../vision/claude.ts";
import { ensureDir } from "../workflows/store.ts";
import { claimBuildApproval, peekBuildApproval } from "./approval.ts";
import { GUARD_TS, HARNESS_PY } from "./harness.ts";
import { startSupervisor, supervisorSocket, type Supervisor } from "./supervisor.ts";
import { checkSha, identityMask, type CheckFile, type Mask } from "./checks.ts";
import { artifactDigestAsync, buildsDir, checkArtifactLimits, removeDisposables, scanArtifactForSecretsAsync, DEFAULT_LIMITS, truncateOutput, writeRunRecord, type BuildLimits, type BuildOutcome, type RunRecord, type TryRecord } from "./record.ts";
import {
  assertSafeExecutionProfile,
  BASH_ALLOW,
  BUILDER_TOOLS,
  builderEnv,
  builderPermissions,
  CHECK_DIR,
  checkEnv,
  commandWrapper,
  DISALLOWED_TOOLS,
  launchEnv,
  secretEnvNames,
  harnessArgv,
  sweepMode,
  UnsafeProfileError,
  redactSecrets,
  resolveSandbox,
  SANDBOX_EXEC,
  sandboxProfile,
  secretValues,
  toolchain,
  type ExecutionProfile,
  type SandboxRuntime,
} from "./sandbox.ts";

/** The SDK boundary: `query` from @anthropic-ai/claude-agent-sdk, or a fake with recorded messages in tests. */
export type BuilderQuery = (args: { prompt: string; options: Options }) => AsyncIterable<unknown>;

export const BUILD_SYSTEM_APPEND = [
  "You are building a small tool from a brief, in the current folder only. There is no network.",
  `The acceptance check in ${CHECK_DIR}/ decides when you are done. It is read-only: never change, move or delete it.`,
  "Run one plain command at a time (no pipes, redirects or chaining). Stop when the check passes.",
].join("\n");

export function checkCommand(file: CheckFile): string {
  return file === "accept.py" ? `python3 ${CHECK_DIR}/accept.py` : `bun test ./${CHECK_DIR}/accept.test.ts`;
}

export function tryPrompt(b: SolutionBrief, file: CheckFile, prior: { n: number; output: string } | null, mask: Mask = identityMask): string {
  const s = b.spec;
  const lines = [
    mask(s.builderPrompt),
    "",
    "Inputs:",
    ...s.inputs.map((x) => `- ${mask(x)}`),
    "Outputs:",
    ...s.outputs.map((x) => `- ${mask(x)}`),
    `Runs where: ${mask(s.runsWhere)}`,
    "",
    `The acceptance check is ${CHECK_DIR}/${file} (read-only). Run it with: ${checkCommand(file)}`,
    "Build until it passes.",
  ];
  if (prior !== null) lines.push("", `The check failed after try ${prior.n}. Its exact output:`, "<check_output>", prior.output, "</check_output>", "Fix the build so the check passes. Do not change the check.");
  return lines.join("\n");
}

export interface CheckRun {
  exit: number | null;
  output: string;
  /** The harness's JSON completion proof (its "OFFLOAD_PROOF" stdout line with this run's nonce), if any. */
  proof?: string;
}
export interface CheckRunArgs {
  ws: string;
  file: CheckFile;
  /** The check to execute: workspace/accept/<file>. Read-only at the OS level (sandbox deny + 0444) and byte-identical
   * to the frozen master (hash-checked right before and after). */
  checkPath: string;
  /** The frozen dir outside the workspace: master copy, harness.py, guard.ts, bunfig.toml. */
  frozenDir: string;
  /** The allow-list env (checkEnv), never process.env. */
  env: Record<string, string>;
  /** argv prefix: OS sandbox with exactly `env`, then `python3 -I <frozen>/harness.py` (harnessArgv). */
  harness: string[];
  /** "sweep" under sandbox-exec, "nosweep" in a declared container. */
  sweep: "sweep" | "nosweep";
  /** Random per check run; only the harness gets it (stdin) and must echo it in its proof line. */
  nonce: string;
  /** Never above the remaining wall budget. */
  timeoutMs: number;
  /** The run's wall-time abort: stops the check when it fires. */
  signal?: AbortSignal;
}
export type CheckRunner = (a: CheckRunArgs) => CheckRun | Promise<CheckRun>;

export function checkArgv(a: Pick<CheckRunArgs, "ws" | "file" | "checkPath" | "frozenDir" | "harness" | "sweep">): string[] {
  return a.file === "accept.py" ? [...a.harness, "check-py", a.sweep, a.checkPath, a.ws] : [...a.harness, "check-bun", a.sweep, a.checkPath, a.ws, join(a.frozenDir, "bunfig.toml"), process.execPath];
}

/** The proof is valid only for this nonce, status "pass", a finished check and a clean sweep. */
export function proofPasses(proof: string | undefined, nonce: string): { ok: boolean; why: string } {
  if (proof === undefined || proof.trim() === "") return { ok: false, why: "no completion proof from the harness" };
  let v: { nonce?: unknown; status?: unknown; completed?: unknown; why?: unknown; sweep?: { clean?: unknown } };
  try {
    v = JSON.parse(proof.trim().split("\n")[0]!);
  } catch {
    return { ok: false, why: "unreadable completion proof" };
  }
  if (v.nonce !== nonce) return { ok: false, why: "completion proof for another run" };
  if (v.sweep?.clean !== true) return { ok: false, why: "builder processes could not be stopped" };
  if (v.status !== "pass" || v.completed !== true) return { ok: false, why: typeof v.why === "string" ? v.why : "the check did not complete" };
  return { ok: true, why: "completed" };
}

const MAX_OUT = 4 * 1024 * 1024;

/** Runs the check (cwd = workspace) through the sandboxed harness, async, in its own process group. On the timeout or
 * the run's abort: SIGTERM first (the harness then sweeps its sandbox), SIGKILL 300 ms later. */
export const runCheckProcess: CheckRunner = (a) =>
  new Promise<CheckRun>((done) => {
    const argv = checkArgv(a);
    let out = "";
    let finished = false;
    let killed: string | null = null;
    const child = spawn(argv[0]!, argv.slice(1), { cwd: a.ws, env: a.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    // The first MAX_OUT of output is kept for the record; the proof line comes last, so a rolling tail is kept too.
    let tail = "";
    const add = (b: Buffer) => {
      const t = b.toString("utf8");
      if (out.length < MAX_OUT) out += t;
      tail = (tail + t).slice(-256 * 1024);
    };
    child.stdout!.on("data", add);
    child.stderr!.on("data", add);
    child.stdin!.on("error", () => {});
    child.stdin!.end(a.nonce);
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const stop = (why: string) => {
      if (killed === null) killed = why;
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), 300);
    };
    const finish = (exit: number | null, extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      a.signal?.removeEventListener("abort", onAbort);
      child.stdout!.destroy();
      child.stderr!.destroy();
      // The proof is the harness's stdout line with this nonce; every OFFLOAD_PROOF line is cut from the output.
      const proof = tail
        .split("\n")
        .filter((l) => l.startsWith("OFFLOAD_PROOF "))
        .map((l) => l.slice("OFFLOAD_PROOF ".length))
        .filter((j) => j.includes(`"${a.nonce}"`))
        .pop();
      const shown = out
        .split("\n")
        .filter((l) => !l.startsWith("OFFLOAD_PROOF "))
        .join("\n");
      done({ exit: killed === null ? exit : null, output: shown + extra + (killed === null ? "" : `\n[check stopped: ${killed}]`), ...(proof === undefined ? {} : { proof }) });
    };
    const onAbort = () => stop("wall time");
    const timer = setTimeout(() => stop(`timeout ${a.timeoutMs} ms`), Math.max(0, a.timeoutMs));
    if (a.signal?.aborted) stop("wall time");
    else a.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => finish(null, `\n${err.message}`));
    child.on("exit", (code) => {
      signalGroup("SIGKILL");
      // Normally "close" (all output read) comes first; the harness stopped every process that could hold the pipes,
      // so this bounded fallback only matters if something still does.
      setTimeout(() => finish(code), 2000);
    });
    child.on("close", (code) => finish(code));
  });

function sdkVersion(): string {
  try {
    const p = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface RunBuildOptions {
  home: string;
  briefId: string;
  token: string;
  query: BuilderQuery;
  profile: ExecutionProfile;
  limits?: Partial<BuildLimits>;
  model?: string;
  mask?: Mask;
  runCheck?: CheckRunner;
  env?: Readonly<Record<string, string | undefined>>;
  /** The sandbox-exec binary (tests point it at a missing file to prove the run fails closed). */
  sandboxExec?: string;
  now?: () => number;
}

/** The apiKeyHelper for Claude Code: prints the credential when Claude Code calls it. From the run's env object (API
 * route / tests): a 0600 file next to the 0700 helper; from the Keychain reference: `security` reads it at call time.
 * Both live in builds/<run>/cred/, which no sandbox profile can read; removed at the end of the run. */
export function writeCredentialHelper(dir: string, env: Readonly<Record<string, string | undefined>>): { helper: string; command: string; value: string | null } | null {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const direct = (env.ANTHROPIC_API_KEY ?? "").trim() || (env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  let body: string;
  let value: string | null = null;
  if (direct !== "") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "key"), direct, { mode: 0o600 });
    body = `exec /bin/cat ${q(join(dir, "key"))}`;
    value = direct;
  } else {
    const ref = (env.OFFLOAD_ANTHROPIC_KEYCHAIN ?? "").trim();
    const [service, account] = ref.split("/", 2);
    if (service === undefined || account === undefined || !/^[\w .@-]{1,120}$/.test(service) || !/^[\w .@-]{1,120}$/.test(account)) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    body = `exec /usr/bin/security find-generic-password -s ${q(service)} -a ${q(account)} -w`;
    // Known to the artifact scan (in memory only).
    try {
      value = resolveAnthropicKey({ OFFLOAD_ANTHROPIC_KEYCHAIN: ref }).key;
    } catch {
      value = null;
    }
  }
  const helper = join(dir, "key-helper.sh");
  // OFFLOAD_KEY_HELPER_CHECK=1: the dry run (checkCredentialHelper) answers without touching the key or the Keychain.
  writeFileSync(helper, `#!/bin/sh\n[ "\${OFFLOAD_KEY_HELPER_CHECK:-}" = 1 ] && { echo offload-key-helper-ok; exit 0; }\n${body}\n`, { mode: 0o700 });
  // The settings value is a SHELL COMMAND: the path is single-quoted (homes with spaces or quotes).
  return { helper, command: q(helper), value };
}

/** Runs the apiKeyHelper command the way Claude Code does (through /bin/sh) in dry-run mode; refuses if it fails. */
export function checkCredentialHelper(command: string): void {
  const r = spawnSync("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", OFFLOAD_KEY_HELPER_CHECK: "1" }, encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0 || (r.stdout ?? "").trim() !== "offload-key-helper-ok") throw new BriefError(`the Claude key helper did not run (${String(r.stderr ?? "").trim().slice(0, 200) || `exit ${r.status}`})`, "conflict");
}

const leakReason = (leak: string) => (leak.includes("too large to scan") ? `artifact file too large to scan (${leak})` : `artifact contains a secret (${leak})`);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
/** Rounds DOWN to a micro-dollar: a budget handed to the SDK never exceeds what is left. */
const floorUsd = (n: number) => Math.max(0, Math.floor(n * 1e6 + 1e-6) / 1e6);

/** Limits with every cap a finite positive number (whole numbers for tries, turns and ms), or a bad_request. */
export function validateLimits(partial: Partial<BuildLimits> | undefined): BuildLimits {
  const l: BuildLimits = { ...DEFAULT_LIMITS, ...(partial ?? {}) };
  for (const k of ["maxTries", "maxTurns", "wallMs"] as const) {
    if (typeof l[k] !== "number" || !Number.isSafeInteger(l[k]) || l[k] < 1) throw new BriefError(`limit ${k} must be a whole number of at least 1 (got ${String(l[k])})`, "bad_request");
  }
  if (typeof l.maxUsd !== "number" || !Number.isFinite(l.maxUsd) || l.maxUsd <= 0) throw new BriefError(`limit maxUsd must be a finite number above 0 (got ${String(l.maxUsd)})`, "bad_request");
  return l;
}

export async function runBuild(o: RunBuildOptions): Promise<RunRecord> {
  assertSafeExecutionProfile(o.profile);
  const now = o.now ?? Date.now;
  // Everything that can refuse runs BEFORE the single-use approval is consumed.
  const limits = validateLimits(o.limits);
  const rt: SandboxRuntime = resolveSandbox(o.profile, o.sandboxExec ?? SANDBOX_EXEC);
  const model = o.model ?? TIER_MODELS.sonnet;
  const runCheck = o.runCheck ?? runCheckProcess;
  // Absolute before any path is derived: workspace, profile and check paths are used with cwd = workspace.
  const home = resolve(o.home);
  const parentEnv = o.env ?? process.env;
  // Off unless the operator opts in: macOS sandbox-exec cannot stop builder code from reading other same-user
  // processes' argv and environment (sysctl KERN_PROCARGS2 is not mediated by the sandbox at all). See API.md.
  if (process.env.OFFLOAD_BUILDER_ENABLED !== "1")
    throw new UnsafeProfileError(
      "the builder is off by default: builder code runs in a sandbox that cannot stop it from reading the command line and environment of your other processes (sysctl KERN_PROCARGS2); set OFFLOAD_BUILDER_ENABLED=1 to accept that and build",
    );
  // Any secret in this process's ORIGINAL environment is readable by every same-user process (sysctl KERN_PROCARGS2,
  // which the sandbox does not filter; deleting it from process.env does not erase it). Refuse rather than build.
  // Names only in the message, never values.
  const exposed = secretEnvNames(launchEnv.read());
  if (exposed.length > 0)
    throw new UnsafeProfileError(
      `the brain was started with secret-bearing variables in its environment (${exposed.join(", ")}), which sandboxed builder code can read (sysctl KERN_PROCARGS2). Start Offload from the app (Finder), or remove them from the shell that starts the brain; keep the Claude key in the Keychain (OFFLOAD_ANTHROPIC_KEYCHAIN)`,
    );
  const tc = toolchain(parentEnv);
  if (!tc.pathDirs.some((d) => existsSync(join(d, "python3")))) throw new UnsafeProfileError("python3 is required for the sandbox harness (it stops every builder process); refusing to run");
  // The gate first: the token is verified (not used) before anything exists on disk; it is claimed after setup.
  const { checks: c0, content: content0 } = peekBuildApproval(home, o.briefId, o.token);
  const id = `run_${randomBytes(8).toString("hex")}`;
  const runDir = join(buildsDir(home), id);
  const ws = join(runDir, "workspace");
  const frozenDir = join(runDir, "frozen");
  const profilePath = join(runDir, "sandbox.sb");
  const harnessPath = join(frozenDir, "harness.py");
  let claimed: ReturnType<typeof claimBuildApproval>;
  let credential: { helper: string; command: string; value: string | null } | null = null;
  const sock = supervisorSocket();
  let sup: Supervisor | null = null;
  const childEnv = checkEnv(ws, parentEnv);
  try {
    ensureDir(join(ws, CHECK_DIR));
    mkdirSync(join(ws, ".tmp"), { recursive: true, mode: 0o700 });
    ensureDir(frozenDir);
    // The builder reads accept/<file>; the check executes there (read-only); the master stays outside the workspace.
    for (const f of [join(ws, CHECK_DIR, c0.file), join(frozenDir, c0.file)]) {
      writeFileSync(f, content0, { mode: 0o444 });
      chmodSync(f, 0o444);
    }
    writeFileSync(harnessPath, HARNESS_PY, { mode: 0o444 });
    writeFileSync(join(frozenDir, "guard.ts"), GUARD_TS, { mode: 0o444 });
    const guard = JSON.stringify(join(frozenDir, "guard.ts"));
    writeFileSync(join(frozenDir, "bunfig.toml"), `preload = [${guard}]\n\n[test]\npreload = [${guard}]\n`, { mode: 0o444 });
    writeFileSync(profilePath, sandboxProfile({ ws, frozenDir, readOnly: tc.readOnly, socket: sock.socket }), { mode: 0o444 });
    // One supervisor per run: every builder command runs as its child, in one sandbox instance it can sweep.
    // The key reaches Claude Code only through apiKeyHelper: a script in a 0700 folder outside every sandbox read
    // path, called by Claude Code itself; no credential is in any process environment or argv.
    credential = writeCredentialHelper(join(runDir, "cred"), parentEnv);
    // Claude Code runs apiKeyHelper through a shell: prove the quoted command runs before the approval is used.
    if (credential !== null) checkCredentialHelper(credential.command);
    // Nothing secret and no socket path in its argv (argv is readable by same-user processes).
    sup = await startSupervisor({ argv: [...harnessArgv(rt, profilePath, childEnv, harnessPath), "serve", sweepMode(rt), ws], cwd: ws, env: childEnv, dir: sock.dir, socket: sock.socket, ws });
    // Last: use the single-use approval (atomic claim). The inputs are re-verified against what was written above.
    claimed = claimBuildApproval(home, o.briefId, o.token, now());
    if (claimed.checks.sha256 !== c0.sha256 || claimed.content !== content0) throw new BriefError("the check script changed during setup", "conflict");
  } catch (err) {
    // Every cleanup step on its own: one failing (e.g. a path that is not a folder) must not skip the others.
    const quietly = (f: () => unknown) => {
      try {
        f();
      } catch {
        // best effort
      }
    };
    rmSync(sock.dir, { recursive: true, force: true });
    if (sup !== null) await sup.stop().catch(() => {});
    quietly(() => rmSync(join(runDir, "cred"), { recursive: true, force: true }));
    quietly(() => rmSync(runDir, { recursive: true, force: true }));
    throw err;
  }
  const supervisor: Supervisor = sup!;
  const { brief, checks } = claimed;
  const startedAt = now();
  const checkPath = join(ws, CHECK_DIR, checks.file);
  const frozenPath = join(frozenDir, checks.file);
  const harness = harnessArgv(rt, profilePath, childEnv, harnessPath);
  const sweep = sweepMode(rt);
  const known = [...secretValues(parentEnv), ...secretValues(process.env), ...(credential?.value ? [credential.value] : [])];
  const scrub = (t: string) => redactSecrets(t, known);
  // accept/ is locked as a whole: exactly the check file, nothing added (a module there would shadow the check's
  // imports), nothing swapped for a link.
  const acceptListing = () => {
    try {
      const dir = join(ws, CHECK_DIR);
      if (lstatSync(dir).isSymbolicLink()) return "symlink";
      return readdirSync(dir, { withFileTypes: true })
        .map((e) => `${e.isFile() ? "f" : e.isSymbolicLink() ? "l" : "o"}:${e.name}`)
        .sort()
        .join("/");
    } catch {
      return "missing";
    }
  };
  const lockedListing = acceptListing();
  const intact = () => acceptListing() === lockedListing && [checkPath, frozenPath].every((f) => existsSync(f) && checkSha(readFileSync(f, "utf8")) === checks.sha256);

  // SDK auth stays in the Claude Code process env; every Bash child it starts is wrapped in `env -i` + the sandbox.
  const env = builderEnv(parentEnv);
  const perms = builderPermissions(ws, commandWrapper(rt, profilePath, childEnv, harnessPath, supervisor.socket), { maxCommandMs: limits.wallMs });
  const bypass = o.profile.mode === "bypass";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("wall time")), limits.wallMs);
  const tries: TryRecord[] = [];
  const reported = new Set<string>();
  let claudeCode: string | null = null;
  /** Unrounded spend: the cap compares against what the SDK reported, not a rounded copy. */
  let spent = 0;
  let outcome: BuildOutcome = "CAP";
  let reason: string | null = null;
  let prior: { n: number; output: string } | null = null;
  let passedSha: string | null = null;
  let artifactSha256 = "";
  // Hashing and scanning read every workspace file; builder code can make one unreadable (chmod 0). That is a
  // recorded FAIL, never an escape from the run's cleanup.
  class ArtifactUnreadable extends Error {}
  class ArtifactRejected extends Error {}
  // Sized from metadata first (no reads): a sparse file, a file over the scan cap or a workspace over the total cap
  // fails closed. Then read asynchronously in chunks, bounded by the wall budget plus a short grace for the verdict.
  // Real clock (an injected `now` is for records and tests, not for bounding I/O).
  const realStart = Date.now();
  const inspectDeadline = () => realStart + limits.wallMs + 30_000;
  const sized = () => {
    let problem: string | null;
    try {
      problem = checkArtifactLimits(ws);
    } catch (err) {
      throw new ArtifactUnreadable(String((err as Error)?.message ?? err));
    }
    if (problem !== null) throw new ArtifactRejected(problem);
  };
  const hash = async () => {
    sized();
    try {
      return await artifactDigestAsync(ws, inspectDeadline());
    } catch (err) {
      throw new ArtifactUnreadable(String((err as Error)?.message ?? err));
    }
  };
  const scan = async () => {
    sized();
    try {
      return await scanArtifactForSecretsAsync(ws, known, inspectDeadline());
    } catch (err) {
      throw new ArtifactUnreadable(String((err as Error)?.message ?? err));
    }
  };
  // SIGTERM / SIGINT / SIGHUP to this process: release what can be released synchronously (the socket folder, cred/,
  // a stopped supervisor is resumed so it sees its stdin close at our exit, sweeps its instance and exits), then let
  // the signal take its normal course.
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (sig: NodeJS.Signals) => {
    supervisor.releaseNow();
    try {
      rmSync(join(runDir, "cred"), { recursive: true, force: true });
    } catch {
      // best effort
    }
    for (const s of SIGNALS) process.off(s, onSignal);
    process.kill(process.pid, sig);
  };
  for (const s of SIGNALS) process.on(s, onSignal);

  try {
   try {
    for (let n = 1; ; n++) {
      if (n > limits.maxTries) {
        reason = `${limits.maxTries} tries without a passing check`;
        break;
      }
      if (spent >= limits.maxUsd || floorUsd(limits.maxUsd - spent) <= 0) {
        reason = `cost cap $${limits.maxUsd} reached ($${round(spent)})`;
        break;
      }
      if (abort.signal.aborted) {
        reason = `wall time ${limits.wallMs} ms reached`;
        break;
      }
      const t0 = now();
      const options: Options = {
        model,
        cwd: ws,
        systemPrompt: { type: "preset", preset: "claude_code", append: BUILD_SYSTEM_APPEND },
        tools: [...BUILDER_TOOLS],
        allowedTools: [],
        disallowedTools: [...DISALLOWED_TOOLS],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: bypass ? "bypassPermissions" : "default",
        ...(bypass ? { allowDangerouslySkipPermissions: true } : { canUseTool: perms.canUseTool }),
        hooks: { PreToolUse: [{ hooks: [perms.preToolUse] }] },
        ...(credential === null ? {} : { settings: { apiKeyHelper: credential.command } }),
        maxTurns: limits.maxTurns,
        maxBudgetUsd: floorUsd(limits.maxUsd - spent),
        env,
        abortController: abort,
      };
      let rawCost = 0;
      const rec: TryRecord = { n, result: "no result", turns: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, checkExit: null, checkOutput: "", checkHashOk: true, ms: 0 };
      try {
        for await (const raw of o.query({ prompt: tryPrompt(brief, checks.file, prior, o.mask), options })) {
          const m = raw as Record<string, any>;
          if (m.type === "system" && m.subtype === "init") {
            if (typeof m.claude_code_version === "string") claudeCode = m.claude_code_version;
            if (typeof m.model === "string") reported.add(m.model);
          } else if (m.type === "result") {
            rec.result = String(m.subtype);
            rec.turns = Number(m.num_turns) || 0;
            rawCost = Math.max(0, Number(m.total_cost_usd) || 0);
            rec.costUsd = round(rawCost);
            const u = m.usage ?? {};
            rec.tokens = { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0 };
            for (const k of Object.keys(m.modelUsage ?? {})) reported.add(k);
          }
        }
      } catch (err) {
        rec.result = abort.signal.aborted ? "aborted: wall time" : `error: ${scrub(String((err as Error)?.message ?? err)).slice(0, 200)}`;
      }
      spent += rawCost;
      // Tamper check before the check runs: the file must be the approved bytes.
      rec.checkHashOk = intact();
      if (!rec.checkHashOk) {
        rec.ms = now() - t0;
        tries.push(rec);
        outcome = "TAMPER";
        reason = "the acceptance check changed during the build";
        break;
      }
      if (abort.signal.aborted) {
        rec.ms = now() - t0;
        tries.push(rec);
        reason = `wall time ${limits.wallMs} ms reached`;
        break;
      }
      if (rec.result.startsWith("error:")) {
        rec.ms = now() - t0;
        tries.push(rec);
        outcome = "FAIL";
        reason = `the builder failed: ${rec.result.slice(7)}`;
        break;
      }
      // The check gets only what is left of the wall budget (no floor), runs async so the abort timer can kill it.
      const left = limits.wallMs - (now() - startedAt);
      if (left <= 0) {
        rec.ms = now() - t0;
        tries.push(rec);
        reason = `wall time ${limits.wallMs} ms reached`;
        break;
      }
      // Quiescent first: nothing the builder started may still run (and write) while the check runs.
      const quiet = await supervisor.sweep();
      if (!quiet.clean) {
        rec.ms = now() - t0;
        tries.push(rec);
        outcome = "FAIL";
        reason = `builder processes could not be stopped before the check (${quiet.why ?? "sweep not clean"})`;
        break;
      }
      // Secrets anywhere, disposable folders included, BEFORE they are deleted.
      const early = await scan();
      if (early !== null) {
        rec.ms = now() - t0;
        tries.push(rec);
        outcome = "FAIL";
        reason = leakReason(early);
        break;
      }
      // The artifact going in: sweep -> drop disposables -> hash -> check -> sweep -> drop disposables -> hash; both
      // hashes must match for a PASS. Nothing that remains is exempt.
      // Hashed exactly as it would be kept (no disposables, no .tmp); the builder's TMPDIR comes back for the check.
      removeDisposables(ws, false);
      const before = await hash();
      mkdirSync(join(ws, ".tmp"), { recursive: true, mode: 0o700 });
      const nonce = randomBytes(16).toString("hex");
      // bun runs the frozen copy (resolution root outside the workspace); python runs accept/<file> (cwd workspace).
      const c = await runCheck({ ws, file: checks.file, checkPath: checks.file === "accept.py" ? checkPath : frozenPath, frozenDir, env: childEnv, harness, sweep, nonce, timeoutMs: Math.min(120_000, left), signal: abort.signal });
      // Exit 0 is only half: the harness must prove the check's own code completed (and nothing survived it).
      const proof = proofPasses(c.proof, nonce);
      rec.checkOutput = truncateOutput(scrub(c.exit === 0 && !proof.ok ? `${c.output}\n[not a pass: ${proof.why}]` : c.output));
      rec.ms = now() - t0;
      // And after: a check that changed while it ran proves nothing.
      if (!intact()) {
        rec.checkHashOk = false;
        tries.push(rec);
        outcome = "TAMPER";
        reason = "the acceptance check changed while it ran";
        break;
      }
      // A result that lands after the deadline does not count, pass or fail.
      if (abort.signal.aborted || now() - startedAt > limits.wallMs) {
        tries.push(rec);
        reason = `wall time ${limits.wallMs} ms reached during the check`;
        break;
      }
      // Quiescent again, and the artifact the check saw is the one we keep.
      const after = await supervisor.sweep();
      if (!after.clean) {
        tries.push(rec);
        outcome = "FAIL";
        reason = `builder processes could not be stopped after the check (${after.why ?? "sweep not clean"})`;
        break;
      }
      removeDisposables(ws, false);
      const changed = (await hash()) !== before;
      mkdirSync(join(ws, ".tmp"), { recursive: true, mode: 0o700 });
      if (changed && c.exit === 0 && proof.ok) rec.checkOutput = truncateOutput(`${rec.checkOutput}\n[not a pass: the workspace changed while the check ran; write fixtures and outputs to a temporary folder]`);
      // An exit 0 without a valid proof (or that changed the artifact) is recorded as "did not complete" (null).
      rec.checkExit = c.exit === 0 && (!proof.ok || changed) ? null : c.exit;
      tries.push(rec);
      const leak = c.exit === 0 && proof.ok && !changed ? await scan() : null;
      if (leak !== null) {
        outcome = "FAIL";
        reason = leakReason(leak);
        break;
      }
      if (c.exit === 0 && proof.ok && !changed) {
        outcome = "PASS";
        reason = null;
        passedSha = before;
        break;
      }
      prior = { n, output: rec.checkOutput };
    }
   } finally {
    clearTimeout(timer);
   }

    // The artifact at the verdict: sweep once more, then hash twice with a gap; any change means something still writes.
    const fin = await supervisor.sweep();
    // Scan everything (disposables included), then drop the disposable folders for good and hash what remains.
    const early = outcome === "PASS" ? await scan() : null;
    if (early !== null) {
      outcome = "FAIL";
      reason = leakReason(early);
    }
    removeDisposables(ws, false);
    const d1 = await hash();
    await new Promise((r) => setTimeout(r, 150));
    artifactSha256 = await hash();
    if (outcome === "PASS" && !fin.clean) {
      outcome = "FAIL";
      reason = `builder processes could not be stopped after the check (${fin.why ?? "sweep not clean"})`;
    } else if (outcome === "PASS" && (d1 !== artifactSha256 || artifactSha256 !== passedSha)) {
      outcome = "FAIL";
      reason = "the workspace was still changing after the check";
    } else if (outcome === "PASS") {
      const leak = await scan();
      if (leak !== null) {
        outcome = "FAIL";
        reason = leakReason(leak);
      }
    }
  } catch (err) {
    // Any error after setup is a recorded FAIL; the run record below is always written.
    outcome = "FAIL";
    const msg = scrub(String((err as Error)?.message ?? err)).slice(0, 300);
    reason = err instanceof ArtifactRejected ? `artifact rejected (${msg})` : err instanceof ArtifactUnreadable ? `artifact unreadable (${msg})` : `the run stopped on an error: ${msg}`;
  } finally {
    clearTimeout(timer);
    for (const s of SIGNALS) process.off(s, onSignal);
    // Always: the supervisor sweeps and goes (stop() also removes the socket folder), and cred/ is removed.
    await supervisor.stop().catch(() => {});
    try {
      rmSync(join(runDir, "cred"), { recursive: true, force: true });
    } catch {
      // best effort; checked by the tests
    }
  }

  const totals = tries.reduce(
    (t, r) => ({ costUsd: round(t.costUsd + r.costUsd), turns: t.turns + r.turns, tokens: { input: t.tokens.input + r.tokens.input, output: t.tokens.output + r.tokens.output, cacheRead: t.tokens.cacheRead + r.tokens.cacheRead } }),
    { costUsd: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0 } },
  );
  const record: RunRecord = {
    version: 1,
    id,
    briefId: brief.id,
    briefHash: brief.hash,
    checkHash: checks.sha256,
    checkFile: checks.file,
    dryRun: true,
    models: { checkWriter: checks.model, builder: model, reported: [...reported].sort() },
    versions: { sdk: sdkVersion(), claudeCode },
    profile: { mode: o.profile.mode, containerSandbox: o.profile.containerSandbox, sandbox: rt.kind, tools: [...BUILDER_TOOLS], disallowedTools: [...DISALLOWED_TOOLS], bashAllow: [...BASH_ALLOW], limits },
    tries,
    totals,
    startedAt,
    wallMs: now() - startedAt,
    outcome,
    reason,
    artifactPath: ws,
    // Taken at the verdict, after the harness stopped every builder process.
    artifactSha256,
    denials: perms.denials.slice(0, 50),
  };
  writeRunRecord(home, record);
  return record;
}
