#!/usr/bin/env bash
# s09b-brain-polish done-signal. Contract: slices/s09b-brain-polish/SPEC.md.
# 1. all brain tests pass, at least MIN_TESTS; 2. strict typecheck; 3. every s09b tag has passing tests;
# 4. the suite passes in America/Toronto and Asia/Karachi; 5. real `serve --model stub` is labelled stub.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
MIN_TESTS=320
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

count() { # $1 = bun test output; prints "ran failed"
  local ran failed
  ran="$(echo "$1" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
  failed="$(echo "$1" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
  echo "${ran:-0} ${failed:-1}"
}

# 1. All brain tests.
out="$(cd "$BRAIN" && bun test 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)" | head -20; fail "bun test exited $code"; }
set -- $(count "$out"); ran=$1; failed=$2
[ "$failed" = "0" ] || fail "$failed failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran tests ran, need at least $MIN_TESTS"

# 2. Typecheck.
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# 3. Every acceptance tag has named, passing tests.
for tag in MODEL LATEST OBSCTL TASKID NEEDSYOU TZ SCHED; do
  grep -rqE "test\(\"$tag: |test\(\`$tag: " "$BRAIN"/tests/s09b-* || { fail "no test named \"$tag: ...\" in brain/tests/s09b-*"; continue; }
  t="$(cd "$BRAIN" && bun test tests/s09b-brain -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: ${n} passing" || fail "tests for $tag did not pass"
done

# 4. The whole brain suite in two zones either side of UTC.
for tz in America/Toronto Asia/Karachi; do
  o="$(cd "$BRAIN" && TZ="$tz" bun test 2>&1)"
  set -- $(count "$o")
  [ "$2" = "0" ] && [ "$1" -ge "$MIN_TESTS" ] && echo "TZ=$tz: $1 tests pass" || { echo "$o" | grep -E "\(fail\)" | head -10; fail "brain suite under TZ=$tz ($2 failing)"; }
done

# 5. Real serve --model stub: ready line first, /status labelled stub (body and header).
TMP="$(mktemp -d "${TMPDIR:-/tmp}/offload-s09b-XXXXXX")"
PID=""
trap '[ -n "$PID" ] && { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }; rm -rf "$TMP"' EXIT
(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file exec bun run brain/src/cli.ts serve --home "$TMP/home" --port 0 --model stub >"$TMP/out" 2>"$TMP/err") &
PID=$!
for _ in $(seq 1 100); do [ -s "$TMP/out" ] && break; sleep 0.1; done
sleep 0.2
first="$(head -1 "$TMP/out")"
if echo "$first" | grep -qE '^OFFLOAD_BRAIN_READY \{"port":[0-9]+,"token":"[A-Za-z0-9_-]{32,}"\}$'; then
  port="$(echo "$first" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
  token="$(echo "$first" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  body="$(curl -s -D "$TMP/h" -H "Authorization: Bearer $token" "http://127.0.0.1:$port/status")"
  echo "$body" | grep -q '"model":"stub"' || fail "/status body is not labelled model stub"
  grep -qi '^x-offload-model: stub' "$TMP/h" || fail "/status has no x-offload-model: stub header"
  echo "serve --model stub: ready line first (port $port), /status labelled stub"
else
  fail "first stdout line of serve --model stub is not the ready line: $(echo "$first" | cut -c1-80)"
fi

if [ $fails -ne 0 ]; then echo "s09b verify: $fails check(s) failed"; exit 1; fi
echo "s09b verify: PASS ($ran tests)"
