#!/usr/bin/env bash
# s05c-brain-ui-gaps done-signal. Contract: slices/s05c-brain-ui-gaps/SPEC.md.
# 1. all brain tests pass, at least MIN_TESTS; 2. strict typecheck; 3. every s05c tag has passing tests;
# 4. the real `serve` prints OFFLOAD_BRAIN_READY first and answers with that token.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
MIN_TESTS=285
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

# 1. All brain tests.
out="$(cd "$BRAIN" && bun test 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)" | head -20; fail "bun test exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ -n "$ran" ] || { ran=0; fail "could not read the test count"; }
[ "${failed:-1}" = "0" ] || fail "${failed:-?} failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran tests ran, need at least $MIN_TESTS"

# 2. Typecheck.
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# 3. Every acceptance tag has named, passing tests.
for tag in "H4c" "READY" "TONE" "SKILL" "RUNS" "OBSERVER"; do
  grep -rqE "test\(\"$tag: " "$BRAIN"/tests/s05c-* || { fail "no test named \"$tag: ...\" in brain/tests/s05c-*"; continue; }
  t="$(cd "$BRAIN" && bun test tests/s05c-keys tests/s05c-serve tests/s05c-routes -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: ${n} passing" || fail "tests for $tag did not pass"
done

# 4. The real serve: first stdout line is the ready line, and its token works.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/offload-s05c-XXXXXX")"
PID=""
trap '[ -n "$PID" ] && { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }; rm -rf "$TMP"' EXIT
(cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file exec bun run brain/src/cli.ts serve --home "$TMP/home" --port 0 >"$TMP/out" 2>"$TMP/err") &
PID=$!
for _ in $(seq 1 100); do [ -s "$TMP/out" ] && grep -q $'\n' "$TMP/out" 2>/dev/null && break; sleep 0.1; done
first="$(head -1 "$TMP/out")"
if echo "$first" | grep -qE '^OFFLOAD_BRAIN_READY \{"port":[0-9]+,"token":"[A-Za-z0-9_-]{32,}"\}$'; then
  port="$(echo "$first" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
  token="$(echo "$first" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  st="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://127.0.0.1:$port/status")"
  [ "$st" = "200" ] || fail "GET /status with the ready-line token returned $st"
  ob="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://127.0.0.1:$port/observer")"
  [ "$ob" = "200" ] || fail "GET /observer returned $ob"
  echo "serve: ready line first (port $port), /status and /observer answer with its token"
else
  fail "first stdout line of serve is not the ready line: $(echo "$first" | cut -c1-80)"
fi

if [ $fails -ne 0 ]; then echo "s05c verify: $fails check(s) failed"; exit 1; fi
echo "s05c verify: PASS ($ran tests)"
