// s24 trusted harness (written read-only into builds/<run>/frozen/, runs inside the OS sandbox). Two jobs:
//
// 1. COMPLETION PROOF. Exit 0 alone is never PASS. The runner hands the harness a random nonce on stdin (read in
//    full, then closed; no child gets it) and reads a final "OFFLOAD_PROOF {json}" stdout line; only a line carrying
//    the nonce counts, so builder output cannot forge one. The harness runs the check in a child process that NEVER loads builder code (python: an
//    audit hook + import guard refuse any module, compile, exec or dlopen of a file in the workspace outside accept/;
//    bun: a preload plugin refuses resolving workspace files), so the check runs the built tool as a subprocess and
//    builder code cannot reach the check's memory or exit early on its behalf. Python: the child writes "DONE <code>"
//    on a private non-inheritable pipe only after the check's own code returned (SystemExit included, os._exit not).
//    Bun: bun's JUnit report (written after all tests finish) is parsed, never stdout. The harness prints
//    {nonce, status, ...} as that line; the runner accepts PASS only for exit 0 + its nonce + status "pass" + a clean sweep.
//
// 2. NO SURVIVORS. After the check or a builder command ends (or on SIGTERM), the harness SIGSTOPs then SIGKILLs every
//    pid it may signal. The sandbox only allows signals to processes of the SAME sandbox instance, i.e. exactly the
//    tree started under this harness - fork + setsid daemons included - and nothing else on the machine. Before
//    sweeping it proves the restriction holds (signalling its unsandboxed parent must fail), otherwise it refuses and
//    reports clean=false (never PASS). In a declared container the sweep is the container's job (mode "nosweep").

export const BUILDER_IMPORT_REFUSED =
  "the check may not load builder code into its own process (it could fake the result): run the built tool as a subprocess, e.g. subprocess.run([sys.executable, 'tool.py', ...]) or Bun.spawnSync([process.execPath, 'run', 'tool.ts', ...])";

export const HARNESS_PY = String.raw`# Offload s24 trusted harness. Never imports builder code. See brain/src/builder/harness.ts.
import json, os, signal, subprocess, sys

MSG = ${JSON.stringify(BUILDER_IMPORT_REFUSED)}

CHILD_BOOT = r'''
import os, sys
check, ws, fd = sys.argv[1], os.path.realpath(sys.argv[2]), int(sys.argv[3])
os.set_inheritable(fd, False)
MSG = sys.argv[4]
ACC = os.path.join(ws, "accept") + os.sep
def builder(p):
    try:
        p = os.fsdecode(p)
        if not p or p.startswith("<"):
            return False
        p = os.path.realpath(p)
    except Exception:
        return False
    return (p == ws or p.startswith(ws + os.sep)) and not p.startswith(ACC)
def refuse(what):
    raise ImportError(MSG + " (" + str(what) + ")")
def hook(event, args):
    if event == "compile" and len(args) > 1 and isinstance(args[1], (str, bytes)) and args[1] and builder(args[1]):
        refuse(args[1])
    elif event == "exec" and args and builder(getattr(args[0], "co_filename", "") or "/"):
        refuse(args[0].co_filename)
    elif event == "ctypes.dlopen" and args and args[0] and builder(args[0]):
        refuse(args[0])
    elif event == "open" and args and isinstance(args[0], (str, bytes)) and str(args[0]).endswith((".pyc", ".so")) and builder(args[0]):
        refuse(args[0])
sys.addaudithook(hook)
import importlib.abc, importlib.machinery
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is not None and spec.origin and builder(spec.origin):
            refuse(spec.origin)
        if spec is None and path is None:
            for cand in (os.path.join(ws, name + ".py"), os.path.join(ws, name)):
                if os.path.exists(cand):
                    refuse(cand)
        return None
sys.meta_path.insert(0, Guard())
sys.argv = [check]
sys.path = [os.path.dirname(check)] + [p for p in sys.path if p and not builder(p)]
import runpy
code = 0
try:
    runpy.run_path(check, run_name="__main__")
except SystemExit as e:
    c = e.code
    if c is None:
        code = 0
    elif isinstance(c, int):
        code = c
    else:
        print(c, file=sys.stderr)
        code = 1
except BaseException:
    import traceback
    traceback.print_exc()
    code = 1
try:
    sys.stdout.flush(); sys.stderr.flush()
except Exception:
    pass
os.write(fd, ("DONE %d\n" % code).encode())
os._exit(code if 0 <= code < 256 else 1)
'''

def sweep(enabled):
    if not enabled:
        return {"swept": False, "killed": 0, "clean": True, "why": "container"}
    try:
        os.kill(os.getppid(), 0)
        return {"swept": False, "killed": 0, "clean": False, "why": "the sandbox lets this process signal its parent; refusing to sweep"}
    except PermissionError:
        pass
    except ProcessLookupError:
        return {"swept": False, "killed": 0, "clean": False, "why": "parent gone; cannot prove the signal restriction"}
    import time
    me, total, hits = os.getpid(), 0, []
    # Repeat until a pass finds nothing. macOS lets kill() "succeed" on ANY zombie (dead, unreaped, anywhere on the
    # machine), so a target counts only if it is also alive (getpgid works on live processes, fails on zombies).
    # Zombies cannot run or write. About 3 s in total before giving up (clean = false, never PASS).
    def alive(pid):
        try:
            os.getpgid(pid)
            return True
        except OSError:
            return False
    for attempt in range(40):
        hits = []
        for pid in range(2, 100000):
            if pid == me:
                continue
            try:
                os.kill(pid, signal.SIGSTOP)
            except OSError:
                continue
            if alive(pid):
                hits.append(pid)
        for pid in hits:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        if attempt == 0:
            total = len(hits)
        if not hits:
            break
        time.sleep(0.02 if attempt < 3 else 0.08)
    out = {"swept": True, "killed": total, "clean": not hits}
    if hits:
        out["why"] = "still present after the sweep: pids " + ",".join(str(p) for p in hits[:10])
    return out

def read_nonce():
    try:
        data = b""
        while len(data) < 256:
            b = os.read(0, 256)
            if not b:
                break
            data += b
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
        return data.decode().strip()
    except OSError:
        return ""

def write_proof(obj):
    try:
        sys.stdout.flush(); sys.stderr.flush()
        os.write(1, ("\nOFFLOAD_PROOF " + json.dumps(obj) + "\n").encode())
    except OSError:
        pass

CHILD = {"p": None}
def on_signal(signum, frame):
    p = CHILD["p"]
    if p is not None:
        try:
            p.kill()
        except Exception:
            pass
    sweep(MODE_SWEEP)
    os._exit(128 + signum)

REPORT_CAP = 8 * 1024 * 1024

def start_reader(fd):
    # Reads the report pipe WHILE the child runs (a big JUnit report would otherwise fill the pipe and block bun).
    # Past the cap it keeps reading and discards, so the writer never blocks; the report then counts as too large.
    import threading
    state = {"chunks": [], "size": 0, "too_large": False}
    def loop():
        while True:
            try:
                b = os.read(fd, 65536)
            except OSError:
                break
            if not b:
                break
            if state["size"] + len(b) > REPORT_CAP:
                state["too_large"] = True
            else:
                state["chunks"].append(b)
            state["size"] += len(b)
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t, state

def finish_reader(t, state, fd):
    # Bounded: a builder process that inherited the write end could hold it open forever.
    t.join(2.0)
    try:
        os.close(fd)
    except OSError:
        pass
    return b"".join(state["chunks"]).decode("utf8", "replace"), state["too_large"]

def junit_pass(xml):
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(xml)
    except Exception:
        return False, "no complete JUnit report"
    if root.tag != "testsuites":
        return False, "unexpected JUnit root"
    try:
        tests, failures, skipped = int(root.get("tests", "0")), int(root.get("failures", "0")), int(root.get("skipped", "0"))
        errors = int(root.get("errors", "0"))
    except ValueError:
        return False, "bad JUnit counts"
    if failures or errors:
        return False, "%d failing test(s)" % (failures + errors)
    if tests - skipped < 1:
        return False, "no test ran"
    return True, "%d test(s) passed" % (tests - skipped)

# ---- per-run supervisor: every builder Bash command runs as ITS child, inside ONE sandbox instance, so a sweep
# reaches every builder process ever started (fork + setsid daemons and commands whose client was SIGKILLed).
import socket, threading

def _send(conn, kind, data=b""):
    conn.sendall(kind + str(len(data)).encode() + b"\n" + data)

def _recv_line(f):
    line = f.readline(1 << 20)
    return line.decode("utf8", "replace") if line else ""

def serve():
    # Requests arrive ONLY on stdin and replies leave ONLY on stdout: private pipes from the runner, never inherited by
    # the commands (they get /dev/null and their own pipe). Every reply echoes the request's id and nonce.
    import base64
    ws = os.path.realpath(sys.argv[3])
    out_lock = threading.Lock()
    cur = {"p": None, "id": None}

    def emit(obj):
        data = (json.dumps(obj) + "\n").encode()
        with out_lock:
            while data:
                n = os.write(1, data)
                data = data[n:]

    def run(req):
        rid, nonce = req.get("id"), req.get("nonce")
        argv = req.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            emit({"id": rid, "nonce": nonce, "type": "exit", "code": 2}); return
        cwd = os.path.realpath(str(req.get("cwd") or ws))
        if not (cwd == ws or cwd.startswith(ws + os.sep)):
            cwd = ws
        try:
            p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except (FileNotFoundError, PermissionError):
            emit({"id": rid, "nonce": nonce, "type": "data", "b64": base64.b64encode(("command not found: %s\n" % argv[0]).encode()).decode()})
            emit({"id": rid, "nonce": nonce, "type": "exit", "code": 127}); return
        cur["p"], cur["id"] = p, rid

        # Output is relayed on its own thread: a background child that inherited stdout must not hold the command
        # open after the command itself has exited. Wait for the direct child, sweep (which stops any such holder),
        # then let the relay finish, bounded.
        def relay():
            try:
                for chunk in iter(lambda: p.stdout.read1(65536), b""):
                    emit({"id": rid, "nonce": nonce, "type": "data", "b64": base64.b64encode(chunk).decode()})
            except (OSError, ValueError):
                pass
        t = threading.Thread(target=relay, daemon=True)
        t.start()
        rc = p.wait()
        cur["p"], cur["id"] = None, None
        sw = sweep(MODE_SWEEP)
        t.join(2.0)
        if sw.get("killed"):
            emit({"id": rid, "nonce": nonce, "type": "data", "b64": base64.b64encode(("[offload sandbox: stopped %d leftover process(es)]\n" % sw["killed"]).encode()).decode()})
        emit({"id": rid, "nonce": nonce, "type": "exit", "code": rc})

    emit({"type": "ready"})
    for line in sys.stdin.buffer:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        op = req.get("op")
        if op == "run":
            threading.Thread(target=run, args=(req,), daemon=True).start()
        elif op == "cancel":
            p = cur["p"]
            if p is not None and req.get("id") == cur["id"]:
                try:
                    p.kill()
                except Exception:
                    pass
        elif op == "sweep":
            p = cur["p"]
            if p is not None:
                try:
                    p.kill()
                except Exception:
                    pass
            res = sweep(MODE_SWEEP)
            emit(dict(res, id=req.get("id"), nonce=req.get("nonce"), type="sweep"))
    # The runner is gone: leave nothing behind.
    sweep(MODE_SWEEP)
    os._exit(0)

def client():
    sock_path = sys.argv[3]
    argv = sys.argv[5:] if sys.argv[4:5] == ["--"] else sys.argv[4:]
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(sock_path)
    except OSError as e:
        print("offload sandbox supervisor is not running (%s)" % e, file=sys.stderr); sys.exit(255)
    s.sendall((json.dumps({"op": "run", "argv": argv, "cwd": os.getcwd()}) + "\n").encode())
    f = s.makefile("rb")
    out = sys.stdout.buffer
    while True:
        kind = f.read(1)
        if not kind:
            print("offload sandbox supervisor closed the connection", file=sys.stderr); sys.exit(255)
        n = int(_recv_line(f).strip() or "0")
        data = f.read(n) if n else b""
        if kind == b"D":
            out.write(data); out.flush()
        elif kind == b"X":
            sys.exit(int(data or b"1"))

mode, MODE_SWEEP = sys.argv[1], sys.argv[2] == "sweep"
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(s, on_signal)

if mode == "run":
    argv = sys.argv[4:] if sys.argv[3:4] == ["--"] else sys.argv[3:]
    try:
        CHILD["p"] = subprocess.Popen(argv)
        rc = CHILD["p"].wait()
    except FileNotFoundError:
        print("command not found: " + (argv[0] if argv else ""), file=sys.stderr)
        rc = 127
    CHILD["p"] = None
    sw = sweep(MODE_SWEEP)
    if sw.get("killed"):
        print("[offload sandbox: stopped %d leftover process(es)]" % sw["killed"], file=sys.stderr)
    sys.exit(rc)

if mode == "serve":
    serve()
    sys.exit(0)
if mode == "client":
    client()

CHILD_CWD = [None]
nonce = read_nonce()
r, w = os.pipe()
if mode == "check-py":
    check, ws = sys.argv[3], sys.argv[4]
    argv = [sys.executable, "-I", "-c", CHILD_BOOT, check, ws, str(w), MSG]
    env = dict(os.environ)
elif mode == "check-bun":
    # The FROZEN copy runs with cwd = the frozen dir, so bun's module resolution root (node_modules, tsconfig,
    # package.json lookups) never reaches the workspace; the preload then chdirs to the workspace for the check's
    # own file and subprocess work, and refuses any module whose resolved path is inside the workspace.
    check, ws, bunfig, bun = sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    argv = [bun, "test", "--config=" + bunfig, "--no-env-file", "--reporter=junit", "--reporter-outfile=/dev/fd/%d" % w, check]
    env = dict(os.environ, OFFLOAD_WS=os.path.realpath(ws), OFFLOAD_WS_RAW=os.path.abspath(ws), OFFLOAD_REFUSED=MSG)
    CHILD_CWD[0] = os.path.dirname(os.path.abspath(check))
else:
    print("unknown harness mode", file=sys.stderr)
    sys.exit(2)
CHILD["p"] = subprocess.Popen(argv, pass_fds=(w,), env=env, stdin=subprocess.DEVNULL, cwd=CHILD_CWD[0])
os.close(w)
reader, rstate = start_reader(r)
rc = CHILD["p"].wait()
CHILD["p"] = None
report, too_large = finish_reader(reader, rstate, r)
sw = sweep(MODE_SWEEP)
if too_large:
    completed, why = False, "report too large (over %d MB)" % (REPORT_CAP // (1024 * 1024))
elif mode == "check-py":
    completed = report.strip().splitlines()[:1] == ["DONE 0"]
    why = "the check finished" if completed else ("the check did not finish normally" if "DONE" not in report else "the check reported failure")
else:
    completed, why = junit_pass(report)
status = "pass" if rc == 0 and completed and sw["clean"] else "fail"
write_proof({"nonce": nonce, "status": status, "exit": rc, "completed": completed, "why": why, "sweep": sw})
sys.exit(rc)
`;

/** Bun preload: refuses resolving any workspace file outside accept/ (builder code stays out of the check process). */
export const GUARD_TS = String.raw`// Offload s24 bun check guard (preloaded from the frozen folder). See brain/src/builder/harness.ts.
import { plugin } from "bun";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
const WS = process.env.OFFLOAD_WS ?? "/nonexistent-offload-ws";
const WS_RAW = process.env.OFFLOAD_WS_RAW ?? WS;
const MSG = process.env.OFFLOAD_REFUSED ?? "builder code may not be imported by the check";
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const inside = (p: string, root: string) => p === root || p.startsWith(root + "/");
const builder = (p: string) => inside(p, WS) || inside(p, WS_RAW) || inside(real(p), WS);
const esc = (s: string) => s.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
// The check's own working directory is the workspace (its subprocess and file work); module resolution started from
// the frozen dir before this preload ran.
if (process.env.OFFLOAD_WS_RAW) process.chdir(process.env.OFFLOAD_WS_RAW);
plugin({
  name: "offload-check-guard",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const raw = isAbsolute(a.path) ? a.path : (a.path.startsWith(".") && a.importer) ? resolve(dirname(a.importer), a.path) : null;
      if (raw === null) return undefined;
      for (const p of [raw, raw + ".ts", raw + ".tsx", raw + ".js", raw + ".mjs", raw + ".cjs", raw + ".json", raw + "/index.ts", raw + "/index.js"].map(real)) {
        if (builder(p)) throw new Error(MSG + " (" + p + ")");
      }
      return undefined;
    });
    // The RESOLVED path decides, however it was reached (bare specifier, node_modules, tsconfig paths, symlink):
    // nothing inside the workspace is ever loaded into the check.
    for (const root of new Set([WS, WS_RAW])) {
      b.onLoad({ filter: new RegExp("^" + esc(root) + "(/|$)") }, (a) => {
        throw new Error(MSG + " (" + a.path + ")");
      });
    }
  },
});
`;
