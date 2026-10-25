#!/usr/bin/env bash
# Done-signal for s10c-review2-engine (REVIEW-2 N4, N7, observer-log rows of the privacy table): builds the engine,
# runs the FULL Swift Testing suite (S01, S02, S02B, S02C, S10C), checks that at least MIN_TESTS ran and that the
# S10C suites passed, and that engine/Sources holds no network code, no key-value access and no process spawning.
# Exits non-zero on any failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s10c}"
MIN_TESTS=135

status=0
out="$("$ROOT/engine/build.sh" test 2>&1)" || status=$?
plain="$(printf '%s\n' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E '✘|error:' | grep -v 'offload-observer \[' | head -n 60 || true
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true

ran="$(printf '%s\n' "$plain" | sed -n 's/.*Test run with \([0-9][0-9]*\) tests\{0,1\}.*/\1/p' | tail -n 1)"
if [ "${ran:-0}" -lt "$MIN_TESTS" ]; then
  echo "verify s10c: expected at least $MIN_TESTS tests to run, got ${ran:-0}"
  exit 1
fi
[ "$status" -eq 0 ] || { echo "verify s10c: tests failed (exit $status)"; exit "$status"; }
for prefix in S02B:5 S02C:3 S10C:3; do
  name="${prefix%%:*}"; want="${prefix##*:}"
  got="$(printf '%s\n' "$plain" | grep -cE "✔ Suite ${name}[A-Z]" || true)"
  [ "$got" -ge "$want" ] || { echo "verify s10c: expected $want $name suites to pass, got $got"; exit 1; }
done

if grep -rnE 'URLSession|URLRequest|NSURLConnection|import Network\b|NWConnection|CFStream|CFSocket' \
    "$ROOT/engine/Sources"; then
  echo "verify s10c: network code found in engine/Sources"
  exit 1
fi
if grep -rnE '\.characters|charactersIgnoringModifiers|\.keyCode' "$ROOT/engine/Sources"; then
  echo "verify s10c: key value access found in engine/Sources"
  exit 1
fi
if grep -rnE 'Process\(\)|NSTask|posix_spawn|\bsystem\(' "$ROOT/engine/Sources"; then
  echo "verify s10c: process spawning found in engine/Sources (launchctl must never be run by the engine)"
  exit 1
fi
echo "verify s10c-review2-engine: OK ($ran tests)"
