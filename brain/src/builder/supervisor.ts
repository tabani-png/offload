// s24 per-run supervisor (node side). The supervisor is harness.py "serve", started once per run inside the OS
// sandbox; every builder Bash command is a client that asks it to run the argv as ITS child, so all builder processes
// share one sandbox instance and one sweep reaches them all (fork + setsid daemons, commands whose client was killed).
// The runner sweeps before every check and before hashing the artifact; a supervisor that is gone, does not answer,
// or reports an unclean sweep means the workspace cannot be shown quiescent, so the run cannot PASS.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

export interface SweepResult {
  clean: boolean;
  killed: number;
  why?: string;
}

export interface Supervisor {
  socket: string;
  /** Stops every process left in the supervisor's sandbox instance. */
  sweep(): Promise<SweepResult>;
  stop(): Promise<void>;
}

/** A short socket path (macOS limits unix socket paths to 104 bytes), in a private 0700 folder. */
export function supervisorSocket(): { dir: string; socket: string } {
  const dir = mkdtempSync("/tmp/ofl-");
  return { dir, socket: join(dir, "s") };
}

function control(socket: string, msg: Record<string, unknown>, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const end = (v: string) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      c.destroy();
      resolve(v);
    };
    const c = createConnection(socket);
    const t = setTimeout(() => end(""), timeoutMs);
    c.on("connect", () => c.write(JSON.stringify(msg) + "\n"));
    c.on("data", (b) => {
      buf += b.toString("utf8");
      if (buf.includes("\n")) end(buf.split("\n")[0]!);
    });
    c.on("error", () => end(""));
    c.on("close", () => end(buf.split("\n")[0] ?? ""));
  });
}

export async function startSupervisor(o: { argv: string[]; cwd: string; env: Record<string, string>; dir: string; socket: string; readyMs?: number }): Promise<Supervisor> {
  const token = randomBytes(24).toString("hex");
  const child: ChildProcess = spawn(o.argv[0]!, o.argv.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  child.stdin!.end(token);
  let log = "";
  const ready = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), o.readyMs ?? 15_000);
    const onData = (b: Buffer) => {
      log += b.toString("utf8");
      if (log.includes("OFFLOAD_SUPERVISOR_READY")) {
        clearTimeout(t);
        resolve(true);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (b: Buffer) => (log += b.toString("utf8")));
    child.on("exit", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  const kill = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // gone
    }
  };
  if (!ready) {
    kill();
    rmSync(o.dir, { recursive: true, force: true });
    throw new Error(`the sandbox supervisor did not start: ${log.slice(0, 500)}`);
  }
  // Keep draining its output so it never blocks on a full pipe.
  child.stdout!.resume();
  child.stderr!.resume();
  const alive = () => child.exitCode === null && child.signalCode === null;
  return {
    socket: o.socket,
    async sweep() {
      if (!alive()) return { clean: false, killed: 0, why: "the sandbox supervisor is gone" };
      const line = await control(o.socket, { op: "sweep", token }, 20_000);
      try {
        const v = JSON.parse(line) as { clean?: unknown; killed?: unknown; why?: unknown };
        return { clean: v.clean === true, killed: typeof v.killed === "number" ? v.killed : 0, ...(typeof v.why === "string" ? { why: v.why } : {}) };
      } catch {
        return { clean: false, killed: 0, why: "the sandbox supervisor did not answer" };
      }
    },
    async stop() {
      // The runner's final sweep already ran; the supervisor itself just goes.
      kill();
      rmSync(o.dir, { recursive: true, force: true });
    },
  };
}
