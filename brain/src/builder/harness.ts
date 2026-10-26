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
    me, total, last = os.getpid(), 0, -1
    for _ in range(6):
        hit = 0
        for sig in (signal.SIGSTOP, signal.SIGKILL):
            for pid in range(2, 100000):
                if pid == me:
                    continue
                try:
                    os.kill(pid, sig)
                    if sig == signal.SIGKILL:
                        hit += 1
                except OSError:
                    pass
        total += hit
        last = hit
        if hit == 0:
            break
    return {"swept": True, "killed": total, "clean": last == 0}

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

def drain(fd):
    os.set_blocking(fd, False)
    out = b""
    while True:
        try:
            b = os.read(fd, 65536)
        except BlockingIOError:
            break
        if not b:
            break
        out += b
    os.close(fd)
    return out.decode("utf8", "replace")

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

nonce = read_nonce()
r, w = os.pipe()
if mode == "check-py":
    check, ws = sys.argv[3], sys.argv[4]
    argv = [sys.executable, "-I", "-c", CHILD_BOOT, check, ws, str(w), MSG]
    env = dict(os.environ)
elif mode == "check-bun":
    check, ws, bunfig, bun = sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    argv = [bun, "test", "--config=" + bunfig, "--no-env-file", "--reporter=junit", "--reporter-outfile=/dev/fd/%d" % w, check]
    env = dict(os.environ, OFFLOAD_WS=os.path.realpath(ws), OFFLOAD_REFUSED=MSG)
else:
    print("unknown harness mode", file=sys.stderr)
    sys.exit(2)
CHILD["p"] = subprocess.Popen(argv, pass_fds=(w,), env=env, stdin=subprocess.DEVNULL)
os.close(w)
rc = CHILD["p"].wait()
CHILD["p"] = None
report = drain(r)
sw = sweep(MODE_SWEEP)
if mode == "check-py":
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
const MSG = process.env.OFFLOAD_REFUSED ?? "builder code may not be imported by the check";
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const builder = (p: string) => (p === WS || p.startsWith(WS + "/")) && !p.startsWith(WS + "/accept/");
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
  },
});
`;
