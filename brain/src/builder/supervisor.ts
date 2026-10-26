// s24 per-run supervisor (node side). The supervisor is harness.py "serve", started once per run inside the OS
// sandbox; every builder Bash command runs as ITS child, so all builder processes share one sandbox instance and one
// sweep reaches them all (fork + setsid daemons, commands whose client was killed).
//
// Channels (security review of b307fa4):
// - Runner <-> supervisor: ONLY the supervisor's stdin/stdout pipes, created by this process and never inherited by
//   the commands it runs (they get /dev/null and their own pipe). Every request carries a fresh nonce the reply must
//   echo. Sweep verdicts travel here and nowhere else; nothing secret is in any argv (argv is readable by same-user
//   processes through sysctl KERN_PROCARGS2, which the sandbox cannot block).
// - Builder command clients -> runner: a unix socket OWNED AND LISTENED ON BY THIS (unsandboxed) PROCESS, in a 0700
//   /tmp folder; sandboxed processes may only connect to it (no bind, no unlink). It accepts `run` only: the same
//   power the builder already has. Its path is not a secret.
// A supervisor that is gone, stopped beyond recovery or not answering with the right nonce = not quiescent = no PASS.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve as resolvePath } from "node:path";

export interface SweepResult {
  clean: boolean;
  killed: number;
  why?: string;
}

export interface Supervisor {
  socket: string;
  /** Stops every process left in the supervisor's sandbox instance (any running command included). */
  sweep(): Promise<SweepResult>;
  stop(): Promise<void>;
}

/** A short socket path (macOS limits unix socket paths to 104 bytes), in a private 0700 folder. */
export function supervisorSocket(): { dir: string; socket: string } {
  const dir = mkdtempSync("/tmp/ofl-");
  return { dir, socket: join(dir, "s") };
}

const frame = (kind: "D" | "X", data: Buffer) => Buffer.concat([Buffer.from(`${kind}${data.length}\n`), data]);

interface Pending {
  nonce: string;
  onData?: (b: Buffer) => void;
  done: (msg: Record<string, unknown>) => void;
}

export async function startSupervisor(o: { argv: string[]; cwd: string; env: Record<string, string>; dir: string; socket: string; ws: string; readyMs?: number; sweepMs?: number }): Promise<Supervisor> {
  const child: ChildProcess = spawn(o.argv[0]!, o.argv.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  child.stderr!.resume();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let readyResolve: ((ok: boolean) => void) | null = null;
  let buf = "";
  child.stdout!.on("data", (b: Buffer) => {
    buf += b.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (m.type === "ready") {
        readyResolve?.(true);
        continue;
      }
      const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
      if (p === undefined || m.nonce !== p.nonce) continue; // stale or forged: ignored
      if (m.type === "data" && typeof m.b64 === "string") p.onData?.(Buffer.from(m.b64, "base64"));
      else {
        pending.delete(m.id as number);
        p.done(m);
      }
    }
  });
  const alive = () => child.exitCode === null && child.signalCode === null;
  child.on("exit", () => {
    for (const [id, p] of pending) {
      pending.delete(id);
      p.done({ type: "gone" });
    }
  });
  const killAll = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // gone
    }
  };
  const send = (req: Record<string, unknown>) => {
    if (alive()) child.stdin!.write(JSON.stringify(req) + "\n");
  };
  const request = (op: Record<string, unknown>, onData?: (b: Buffer) => void): { id: number; reply: Promise<Record<string, unknown>> } => {
    const id = nextId++;
    const nonce = randomBytes(16).toString("hex");
    const reply = new Promise<Record<string, unknown>>((done) => pending.set(id, { nonce, ...(onData ? { onData } : {}), done }));
    send({ ...op, id, nonce });
    return { id, reply };
  };

  const ready = await new Promise<boolean>((res) => {
    readyResolve = res;
    const t = setTimeout(() => res(false), o.readyMs ?? 15_000);
    child.on("exit", () => {
      clearTimeout(t);
      res(false);
    });
  });
  if (!ready) {
    killAll();
    rmSync(o.dir, { recursive: true, force: true });
    throw new Error("the sandbox supervisor did not start");
  }

  // Command clients: one command at a time, relayed to the supervisor over the private pipe.
  let chain: Promise<void> = Promise.resolve();
  let current: number | null = null;
  const conns = new Set<Socket>();
  const server: Server = createServer((conn: Socket) => {
    conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    let head = "";
    let started = false;
    conn.on("error", () => {});
    conn.on("data", (b) => {
      if (started) return;
      head += b.toString("utf8");
      const nl = head.indexOf("\n");
      if (nl < 0) {
        if (head.length > 1 << 20) conn.destroy();
        return;
      }
      started = true;
      let hdr: { op?: unknown; argv?: unknown; cwd?: unknown };
      try {
        hdr = JSON.parse(head.slice(0, nl)) as typeof hdr;
      } catch {
        conn.destroy();
        return;
      }
      // `run` only; anything else (sweep, shutdown, verdicts) is never accepted here.
      if (hdr.op !== "run" || !Array.isArray(hdr.argv) || hdr.argv.length === 0 || !hdr.argv.every((a) => typeof a === "string")) {
        conn.destroy();
        return;
      }
      const cwd = typeof hdr.cwd === "string" ? resolvePath(hdr.cwd) : o.ws;
      chain = chain.then(async () => {
        if (conn.destroyed) return;
        const { id, reply } = request({ op: "run", argv: hdr.argv, cwd }, (d) => conn.write(frame("D", d)));
        current = id;
        const onClose = () => {
          if (pending.has(id)) send({ op: "cancel", id });
        };
        conn.on("close", onClose);
        const r = await reply;
        current = null;
        conn.off("close", onClose);
        conn.end(frame("X", Buffer.from(String(typeof r.code === "number" ? r.code : 255))));
      });
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(o.socket, () => res());
  });

  return {
    socket: o.socket,
    async sweep() {
      if (current !== null) send({ op: "cancel", id: current });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!alive()) return { clean: false, killed: 0, why: "the sandbox supervisor is gone" };
        const { id, reply } = request({ op: "sweep" });
        // Builder code can SIGSTOP the supervisor (same sandbox); keep resuming it while waiting. Its sweep stops
        // every other process in the instance first, which ends any stopper.
        const cont = setInterval(() => {
          try {
            if (child.pid !== undefined) process.kill(child.pid, "SIGCONT");
          } catch {
            // gone
          }
        }, 50);
        const r = await Promise.race([reply, new Promise<null>((res) => setTimeout(() => res(null), o.sweepMs ?? 8000))]);
        clearInterval(cont);
        if (r === null) {
          pending.delete(id);
          continue;
        }
        if (r.type !== "sweep") return { clean: false, killed: 0, why: "the sandbox supervisor is gone" };
        return { clean: r.clean === true, killed: typeof r.killed === "number" ? r.killed : 0, ...(typeof r.why === "string" ? { why: r.why } : {}) };
      }
      return { clean: false, killed: 0, why: "the sandbox supervisor did not answer" };
    },
    async stop() {
      for (const c of conns) c.destroy();
      await new Promise<void>((res) => server.close(() => res()));
      try {
        child.stdin!.end();
      } catch {
        // gone
      }
      killAll();
      rmSync(o.dir, { recursive: true, force: true });
    },
  };
}
