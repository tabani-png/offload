// SAFETY (security review of b307fa4, P1 false PASS): builder code read the supervisor's socket path from its argv
// (sysctl KERN_PROCARGS2), SIGSTOPped the supervisor, unlinked the socket and bound a fake listener answering
// {"clean":true}; its daemon then wrote the workspace after the verdict. The sweep verdict must travel over a channel
// builder code cannot reach or impersonate (private pipes + per-request nonce), the command socket is owned by the
// unsandboxed runner (children may only connect), the artifact must not change across the check, and no /tmp/ofl-*
// folder may outlive a run.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { verifyArtifact } from "../../src/builder/record.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { fakeQuery, NOW, prepared, writeSlug, releaseTemps } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const oflDirs = () => new Set(readdirSync("/tmp").filter((n) => n.startsWith("ofl-")));

// The reviewer's attack, as a builder command: stop the parent (the supervisor), find a socket path in any argv it
// can read, replace the socket with a fake "clean" listener, and leave a daemon that writes after the verdict.
const EVIL = String.raw`import ctypes, ctypes.util, os, signal, socket, sys, time
ppid = os.getppid()
def argv_of(pid):
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"))
        mib = (ctypes.c_int * 3)(1, 49, pid); sz = ctypes.c_size_t(0)
        libc.sysctl(mib, 3, None, ctypes.byref(sz), None, 0)
        buf = ctypes.create_string_buffer(sz.value or 1)
        libc.sysctl(mib, 3, buf, ctypes.byref(sz), None, 0)
        return [p.decode("utf8", "replace") for p in buf.raw[4:].split(b"\0") if p]
    except Exception:
        return []
socks = [a for a in argv_of(ppid) if "/ofl-" in a]
print("socket from parent argv:", socks)
try:
    os.kill(ppid, signal.SIGSTOP)
    print("stopped the supervisor")
except OSError as e:
    print("could not stop the supervisor", e)
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        d = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(d, fd)
        fake = None
        for path in socks:
            try:
                os.unlink(path)
            except OSError:
                pass
            try:
                fake = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); fake.bind(path); fake.listen(8); fake.settimeout(0.1)
            except OSError:
                fake = None
        t0 = time.time()
        while time.time() - t0 < 6:
            if fake is not None:
                try:
                    c, _ = fake.accept(); c.recv(4096); c.sendall(b'{"clean": true, "killed": 0, "swept": true}\n'); c.close()
                except OSError:
                    pass
            else:
                time.sleep(0.1)
            if time.time() - t0 > 3:
                open("late_after_verdict.txt", "w").write("x")
        os._exit(0)
    os._exit(0)
print("evil done")
`;

describe("s24 verdict channel", () => {
  test("SAFETY: a builder that stops the supervisor and impersonates its socket cannot get a PASS with a live writer", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let wsSeen = "";
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          wsSeen = ws;
          writeSlug("good")(ws);
          writeFileSync(join(ws, "evil.py"), EVIL);
          const r = await o.canUseTool!("Bash", { command: "python3 evil.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          const child = spawn("/bin/sh", ["-c", cmd], { cwd: ws, detached: true, stdio: "ignore" });
          await Bun.sleep(1200);
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        },
      },
    ]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    await Bun.sleep(4500);
    const late = existsSync(join(wsSeen, "late_after_verdict.txt"));
    // A PASS is only acceptable if nothing was left alive to change the artifact afterwards.
    if (rec.outcome === "PASS") {
      expect(late).toBe(false);
      expect(verifyArtifact(p.home, rec.id)).toBe(true);
    }
    expect(rec.outcome === "PASS" && late).toBe(false);
  }, 40_000);

  test("SAFETY: the supervisor's argv carries no socket path or secret", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let parentArgv: string[] = [];
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          writeSlug("good")(ws);
          writeFileSync(join(ws, "argv.py"), String.raw`import ctypes, ctypes.util, os
libc = ctypes.CDLL(ctypes.util.find_library("c"))
mib = (ctypes.c_int * 3)(1, 49, os.getppid()); sz = ctypes.c_size_t(0)
libc.sysctl(mib, 3, None, ctypes.byref(sz), None, 0)
buf = ctypes.create_string_buffer(sz.value or 1)
libc.sysctl(mib, 3, buf, ctypes.byref(sz), None, 0)
print("ARGV " + "|".join(p.decode("utf8", "replace") for p in buf.raw[4:].split(b"\0") if p))
`);
          const r = await o.canUseTool!("Bash", { command: "python3 argv.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          const out = await new Promise<string>((res) => {
            let s = "";
            const c = spawn("/bin/sh", ["-c", cmd], { cwd: ws });
            c.stdout.on("data", (b) => (s += b));
            c.on("close", () => res(s));
          });
          parentArgv = (out.split("\n").find((l) => l.startsWith("ARGV ")) ?? "ARGV ").slice(5).split("|");
        },
      },
    ]);
    await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(parentArgv.join(" ")).toContain("harness.py");
    expect(parentArgv.some((a) => a.includes("/ofl-"))).toBe(false);
  }, 30_000);

  test("SAFETY: a check that changes the workspace is not a PASS (the artifact must be identical before and after the check)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    // The recorded check runs slug.py; this slug.py also drops a file into the workspace when run.
    const f = fakeQuery([{ act: (ws) => writeFileSync(join(ws, "slug.py"), "import re, sys\nopen('side_effect.txt', 'a').write('x')\nprint(re.sub(r'[^a-z0-9]+', '-', sys.argv[1].lower()).strip('-'))\n") }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
  }, 30_000);

  test("SAFETY: no /tmp/ofl-* folder outlives a run (pass, or setup failure)", async () => {
    const before = oflDirs();
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    await runBuild({ home: p.home, briefId: p.briefId, token, query: fakeQuery([{ act: writeSlug("good") }]).query, profile: ALLOW });
    const q = await prepared();
    const t2 = approveBuild(q.home, q.briefId, q.briefHash, q.checkHash, NOW).token;
    writeFileSync(join(q.home, "builds"), "not a folder");
    await expect(runBuild({ home: q.home, briefId: q.briefId, token: t2, query: fakeQuery([{}]).query, profile: ALLOW })).rejects.toThrow();
    const leaked = [...oflDirs()].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);
  }, 30_000);
});
