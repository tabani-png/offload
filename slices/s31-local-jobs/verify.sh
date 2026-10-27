#!/usr/bin/env bash
# s31-local-jobs done-signal. Contract: slices/s31-local-jobs/SPEC.md.
# 1. Swift tags   2. brain tags   3. build engine + app outside the repo, copy it, read-only
# 4. seed a home (repo bun, OFFLOAD_KEYS=file: test state only)   5. start the brain THE WAY THE APP DOES from the copy
#    (`Offload --brain-check --hold`, env -i, temp HOME, PATH without bun, no OFFLOAD_REPO)
# 6. PURGE SCHED CAPTION OBSERVER TIME WAKE RESTART KEYRESTART QUIT   7. AGENT + CONSENT (operator decision)   8. scope
# One "FAIL ..." line per failing check. Bash 3.2 compatible. Never touches the real Keychain (OFFLOAD_KEYS=file), the
# real LaunchAgents folder (OFFLOAD_LAUNCH_AGENTS_DIR) or launchd. Cleans its temp folder (the app is ~400 MB of clones).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE=30a0fa1   # origin/main when s31 started
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
mkdir -p /tmp/s31-tmp
export TMPDIR=/tmp/s31-tmp
T="$(mktemp -d /tmp/s31-tmp/verify.XXXXXX)"
CHECK=""
cleanup() {
  [ -n "$CHECK" ] && kill -9 "$CHECK" 2>/dev/null
  chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"
}
trap cleanup EXIT
STRIPPED_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# wait_for SECONDS CMD...: true as soon as CMD succeeds (polled every 0.5 s).
wait_for() { local n=$(($1 * 2)); shift; while [ $n -gt 0 ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; n=$((n - 1)); done; return 1; }

echo "== Swift suite (app/build.sh test)"
st="$(OFFLOAD_BUILD_DIR="$T/testbuild" "$ROOT/app/build.sh" test 2>&1)"; scode=$?
echo "$st" | grep -E "Test run with [0-9]+ tests" | tail -1
[ $scode -eq 0 ] || { echo "$st" | grep -E "failed|error:" | head -20; fail "app/build.sh test exited $scode"; }
for tag in PURGESPEC OBSLOC CHECKOPTS CONSENT AGENTCMD; do
  n="$(echo "$st" | grep -cE "Test \"$tag: .*\" passed")"
  [ "$n" -gt 0 ] && echo "$tag: $n passing" || fail "no passing Swift test named \"$tag: ...\""
done
rm -rf "$T/testbuild"

echo "== brain (tests/s31-local-jobs)"
bt="$(cd "$ROOT/brain" && bun test tests/s31-local-jobs 2>&1)"; bcode=$?
echo "$bt" | grep -E "^ *[0-9]+ (pass|fail)"
[ $bcode -eq 0 ] || fail "brain s31 tests exited $bcode"
ot="$(cd "$ROOT/brain" && bun test tests/s31-local-jobs -t "OBSBIN: " 2>&1)"; ocode=$?
n="$(echo "$ot" | sed -n 's/^ *\([0-9][0-9]*\) pass.*/\1/p' | head -1)"
[ $ocode -eq 0 ] && [ "${n:-0}" -gt 0 ] && echo "OBSBIN: $n passing" || fail "no passing brain test named \"OBSBIN: ...\""

echo "== build engine + app (outside the repo)"
eb="$(OFFLOAD_BUILD_DIR="$ROOT/engine/.build" "$ROOT/engine/build.sh" 2>&1)" || { echo "$eb" | tail -20; fail "engine/build.sh exited non-zero"; }
b="$(OFFLOAD_BUILD_DIR="$T/build" "$ROOT/app/build.sh" 2>&1)" || { echo "$b" | tail -20; fail "app/build.sh exited non-zero"; }
[ -x "$T/build/Offload.app/Contents/MacOS/offload-observer" ] || fail "the observer is not in the bundle"
[ -x "$T/build/Offload.app/Contents/Helpers/bun" ] || { fail "no bundled brain"; echo "s31-local-jobs: $fails failing check(s)"; exit 1; }
I="$T/install"; mkdir -p "$I" "$T/home" "$T/tmp" "$T/agents"
cp -cR "$T/build/Offload.app" "$I/" 2>/dev/null || cp -R "$T/build/Offload.app" "$I/"
rm -rf "$T/build"
C="$I/Offload.app"
case "$C" in "$ROOT"/*) fail "the copy is inside the repo" ;; esac
chmod -R a-w "$C"
env -i PATH="$STRIPPED_PATH" sh -c 'command -v bun' >/dev/null 2>&1 && fail "bun is on the stripped PATH"

echo "== seed (test state, repo bun, OFFLOAD_KEYS=file)"
H="$T/home/offload"
seed="$(cd "$ROOT" && OFFLOAD_KEYS=file bun run slices/s31-local-jobs/seed.ts "$H" 2>&1 | tail -1)"
echo "$seed"
WF="$(echo "$seed" | sed -n 's/.*"workflowId":"\([^"]*\)".*/\1/p')"
OLD="$(echo "$seed" | sed -n 's/.*"oldDay":"\([^"]*\)".*/\1/p')"
KEEP="$(echo "$seed" | sed -n 's/.*"keepDay":"\([^"]*\)".*/\1/p')"
[ -n "$WF" ] && [ -n "$OLD" ] && [ -n "$KEEP" ] || { fail "seed did not finish"; echo "s31-local-jobs: $fails failing check(s)"; exit 1; }
[ -f "$H/frame-notes/$OLD.jsonl.enc" ] && [ -f "$H/frames/$OLD.jsonl" ] && [ -f "$H/frames/$KEEP.jsonl" ] || fail "seed did not write the purge targets"

echo "== start the brain the way the app does (from the read-only copy)"
OUT="$T/check.out"
cd "$T" || exit 1
env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" OFFLOAD_KEYS=file OFFLOAD_LAUNCH_AGENTS_DIR="$T/agents" \
  "$C/Contents/MacOS/Offload" --brain-check --home "$H" --hold 600 --captioner stub >"$OUT" 2>"$T/check.err" &
CHECK=$!
bunpids() { ps -axo pid=,comm= | awk -v b="$C/Contents/Helpers/bun" '$2 == b { print $1 }'; }
endpoints() { grep -c "^brain endpoint: " "$OUT" 2>/dev/null; }
url() { sed -n 's/^brain endpoint: //p' "$OUT" | tail -1 | sed 's:/$::'; }
api() { curl -s --max-time 10 -H "authorization: Bearer $(cat "$H/.brain-check-token" 2>/dev/null)" "$(url)$1"; }
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 -H "authorization: Bearer $(cat "$H/.brain-check-token" 2>/dev/null)" "$(url)$1"; }
up() { [ "$(endpoints)" -ge "$1" ] && [ -s "$H/.brain-check-token" ] && [ "$(code /status)" = 200 ]; }
if ! wait_for 60 up 1; then
  sed "s|$T|\$T|g" "$OUT" | head -20; tail -20 "$H/brain-check.err.log" 2>/dev/null
  fail "the brain did not come up from the copy"; echo "s31-local-jobs: $fails failing check(s)"; exit 1
fi
grep -E "^(brain (source|status)|purge):" "$OUT" | sed "s|$T|\$T|g"
grep -qF "brain source: bundled $C/Contents/Helpers/bun $C/Contents/Resources/offload" "$OUT" || fail "the brain did not come from the copy"
grep -q "sk-ant-" "$OUT" && fail "the check printed key material"
P1="$(bunpids | head -1)"
[ -n "$P1" ] && echo "brain pid $P1 (bundled bun)" || fail "no bundled bun process"
py() { python3 -I -c "$1"; }
# Stub only: no Claude call can happen even with a key in the login Keychain (model stub, captioner stub).
api /status | py "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('model')=='stub' and d['captioner']['captioner']=='stub' else 1)" \
  && echo "model stub, captioner stub" || fail "the check brain is not stub-only"

echo "== PURGE (the app's launch purge, before serve)"
grep -qE "^purge: exit 0 purged [1-9][0-9]* artefact" "$OUT" || fail "PURGE: the launch purge did not run or deleted nothing"
[ -e "$H/frame-notes/$OLD.jsonl.enc" ] && fail "PURGE: frame-notes/$OLD (older than 7 days) is still there"
[ -e "$H/frames/$OLD.jsonl" ] && fail "PURGE: frames/$OLD.jsonl (older than 7 days) is still there"
[ -f "$H/frames/$KEEP.jsonl" ] || fail "PURGE: frames/$KEEP.jsonl (6 days old) was deleted"
grep -q "\"day\":\"$OLD\"" "$H/purge-log.jsonl" 2>/dev/null && echo "purge-log names $OLD" || fail "PURGE: purge-log.jsonl does not name $OLD"

echo "== SCHED (a weekday 09:00 slot missed while closed: one pending batch on the first tick, nothing sent)"
sched() { api /dashboard | py "import json,sys; a=[x for x in json.load(sys.stdin)['automations'] if x['id']=='$WF'][0]; sys.exit(0 if 'A new batch of 3 is ready for review.' in (a.get('needsYou') or []) and a.get('pendingBatch') else 1)"; }
if wait_for 45 sched; then
  HASH="$(api /dashboard | py "import json,sys; print([x for x in json.load(sys.stdin)['automations'] if x['id']=='$WF'][0]['pendingBatch']['hash'])")"
  echo "pending batch ${HASH:0:12}…"
else
  api /dashboard | head -c 600; echo; fail "SCHED: no pending batch from the missed slot"
fi
grep -q '"lastScheduledAt"' "$H/workflows/$WF/workflow.json" || fail "SCHED: the slot was not marked handled"
nb() { ls "$H/workflows/$WF/batches/" 2>/dev/null | grep -c '\.json\.enc$'; }
NB="$(nb)"
[ -f "$H/workflows/$WF/done-log.csv" ] && grep -q "@" "$H/workflows/$WF/done-log.csv" && fail "SCHED: something was sent"

echo "== CAPTION (stub captioner, both keyframes)"
processed() { api /status | py "import json,sys; print(json.load(sys.stdin)['captioner']['processed'])"; }
capt() { [ "$(processed)" -ge "$1" ]; }
wait_for 30 capt 2 && echo "captioned $(processed)" || fail "CAPTION: the worker did not caption 2 frames (processed $(processed))"
[ -f "$H/frame-notes/$(date +%F).jsonl.enc" ] || fail "CAPTION: no sealed frame-notes/$(date +%F).jsonl.enc"

echo "== OBSERVER + TIME (bundled observer through the app's path; time breakdown on request)"
[ "$(code /observer)" = 200 ] && echo "GET /observer 200" || fail "OBSERVER: GET /observer answered $(code /observer)"
[ "$(code /time)" = 200 ] && echo "GET /time 200" || fail "TIME: GET /time answered $(code /time)"

echo "== WAKE (suspended past one run-loop interval, a keyframe arrives, resumed)"
kill -STOP "$P1"
sleep 35
(cd "$ROOT" && OFFLOAD_KEYS=file bun run slices/s31-local-jobs/seed.ts --frame "$H" >/dev/null 2>&1) || fail "WAKE: could not add a frame"
kill -CONT "$P1"
wait_for 40 capt 3 && echo "after resume: captioned $(processed)" || fail "WAKE: the resumed worker did not caption the new frame"
[ "$(bunpids | head -1)" = "$P1" ] && echo "same brain process" || fail "WAKE: the brain process changed across the suspend"

echo "== RESTART (the brain dies; the supervisor starts a new one; no duplicate batch)"
kill -9 "$P1"
if wait_for 30 up 2; then
  P2="$(bunpids | head -1)"
  [ -n "$P2" ] && [ "$P2" != "$P1" ] && echo "new brain pid $P2" || fail "RESTART: no new brain process"
  sleep 3
  [ "$(nb)" = "$NB" ] || fail "RESTART: batches went from $NB to $(nb)"
  sched || fail "RESTART: the pending batch is gone after the restart"
else
  fail "RESTART: the supervisor did not bring the brain back"; P2="$P1"
fi

echo "== KEYRESTART (SIGUSR1: the s29 key-change restart path)"
kill -USR1 "$CHECK"
if wait_for 30 up 3; then
  P3="$(bunpids | head -1)"
  [ -n "$P3" ] && [ "$P3" != "$P2" ] && echo "replaced by pid $P3" || fail "KEYRESTART: the brain process was not replaced"
  kill -0 "$P2" 2>/dev/null && fail "KEYRESTART: the old brain $P2 is still running"
  grep -q "^brain check: restarting the brain" "$OUT" || fail "KEYRESTART: no restart line"
else
  fail "KEYRESTART: no new endpoint after the restart"
fi

echo "== QUIT (the app process dies; the orphan guard stops the brain)"
U="$(url)"
kill -9 "$CHECK"; CHECK=""
gone() { [ -z "$(bunpids)" ]; }
wait_for 5 gone && echo "brain stopped with the app" || fail "QUIT: the brain outlived the app: $(bunpids)"
curl -s -o /dev/null --max-time 3 "$U/status" && fail "QUIT: the brain still answers"

echo "== AGENT + CONSENT (contract extension after the operator decision: login agent only after the person's Yes)"
# Never the real LaunchAgents folder or launchd: OFFLOAD_LAUNCH_AGENTS_DIR is set on every run below and above.
PL="$T/agents/ai.offload.observer.plist"
[ -e "$PL" ] && fail "CONSENT: a LaunchAgent exists before consent (after a full brain run)" || echo "no plist before consent"
agent() { env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" OFFLOAD_LAUNCH_AGENTS_DIR="$T/agents" "$C/Contents/MacOS/Offload" --observer-agent "$1" --home "$H" 2>&1; }
a="$(agent on)" || fail "AGENT: --observer-agent on failed: $a"
echo "$a" | sed "s|$T|\$T|g"
plutil -lint "$PL" >/dev/null 2>&1 && echo "plist lint ok" || fail "AGENT: the plist does not lint"
prog="$(plutil -extract ProgramArguments.0 raw "$PL" 2>/dev/null)"
creal="$(cd "$C" && pwd -P)"
case "$prog" in "$C"/Contents/MacOS/offload-observer|"$creal"/Contents/MacOS/offload-observer) echo "program inside the copy" ;; *) fail "AGENT: the agent runs '$prog', not the bundle's observer" ;; esac
[ "$(plutil -extract RunAtLoad raw "$PL" 2>/dev/null)" = true ] || fail "AGENT: RunAtLoad is not true"
[ "$(plutil -extract KeepAlive.SuccessfulExit raw "$PL" 2>/dev/null)" = false ] || fail "AGENT: KeepAlive does not restart after a crash"
plutil -extract EnvironmentVariables raw "$PL" >/dev/null 2>&1 && fail "AGENT: the plist carries environment overrides"
a="$(agent off)" || fail "AGENT: --observer-agent off failed: $a"
[ -e "$PL" ] && fail "AGENT: the plist is still there after the switch went off" || echo "gone after off"
env -i HOME="$T/home" PATH="$STRIPPED_PATH" OFFLOAD_KEYS=file "$C/Contents/MacOS/offload-observer" status --json --home "$H" >/dev/null 2>&1 \
  && echo "bundled observer runs (status --json)" || fail "AGENT: the bundled observer does not run"
# The login-agent commands live in one file; only the consent paths (the Yes, the Settings switch, the CLI) reach them.
others="$(grep -rlE "install-agent|launchctl|SMAppService" "$ROOT/app/Sources" | grep -v "/Core/ObserverAgent.swift$")"
[ -z "$others" ] || fail "CONSENT: login-agent commands outside ObserverAgent.swift: $others"
calls="$(grep -rnE "\.install\(\)" "$ROOT/app/Sources" | grep -v "/Core/ObserverAgent.swift:")"
echo "$calls" | sed "s|$ROOT/||"
[ "$(echo "$calls" | grep -c .)" -eq 2 ] || fail "CONSENT: expected exactly 2 install() callers (the switch and the CLI)"
grep -q "if yes { setObserverAtLogin(true) }" "$ROOT/app/Sources/App/OffloadApp.swift" || fail "CONSENT: the first-run question does not gate the install"

echo "== scope"
. "$ROOT/scripts/lib/slice-changes.sh"
SLICE_GREP='^[a-z]+\(s31-local-jobs\)' slice_files --allow-skip "$BASE"; scope_rc=$?
case $scope_rc in
  0) while IFS= read -r p; do
       [ -n "$p" ] || continue
       case "$p" in
         app/Sources/Core/BrainSupervisor.swift|app/Sources/Core/BrainCheck.swift|app/Sources/App/OffloadApp.swift|app/build.sh) ;;
         app/Sources/Core/ObserverAgent.swift|app/Sources/Surfaces/DashboardModel.swift|app/Sources/Surfaces/DashboardView.swift) ;;
         brain/src/store/observer.ts|brain/tests/s31-local-jobs/*|slices/s31-local-jobs/*) ;;
         agent-control/rework-ledger.md) ;;   # review rework rows (coordinator request, PR #38)
         *) fail "out-of-scope path changed: $p" ;;
       esac
     done <<< "$SLICE_FILES"
     echo "scope checked ($(printf '%s\n' "$SLICE_FILES" | grep -c .) files)" ;;
  3) echo "scope: SKIPPED ($SLICE_ERROR)" ;;
  *) fail "scope check could not run: $SLICE_ERROR" ;;
esac

[ "$fails" -eq 0 ] && echo "s31-local-jobs: PASS" || { echo "s31-local-jobs: $fails failing check(s)"; exit 1; }
