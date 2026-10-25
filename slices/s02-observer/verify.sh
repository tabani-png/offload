#!/usr/bin/env bash
# Done-signal for s02-observer: builds the engine, runs the S02 Swift Testing suites, checks that at least
# MIN_TESTS really ran, and that engine/Sources holds no network code. Exits non-zero on any failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s02}"
MIN_TESTS=25

status=0
out="$("$ROOT/engine/build.sh" test --filter S02 2>&1)" || status=$?
plain="$(printf '%s\n' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E '✘|error:' | head -n 60 || true
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true

ran="$(printf '%s\n' "$plain" | sed -n 's/.*Test run with \([0-9][0-9]*\) tests\{0,1\}.*/\1/p' | tail -n 1)"
if [ "${ran:-0}" -lt "$MIN_TESTS" ]; then
  echo "verify s02-observer: expected at least $MIN_TESTS S02 tests to run, got ${ran:-0}"
  exit 1
fi
[ "$status" -eq 0 ] || { echo "verify s02-observer: tests failed (exit $status)"; exit "$status"; }

# No network code anywhere in the engine (the S02NoNetworkTests suite checks the same list from inside Swift).
if grep -rnE 'URLSession|URLRequest|NSURLConnection|import Network\b|NWConnection|CFStream|CFSocket' \
    "$ROOT/engine/Sources"; then
  echo "verify s02-observer: network code found in engine/Sources"
  exit 1
fi
# Input events carry counts only: no key code or character access in the live glue.
if grep -rnE '\.characters|charactersIgnoringModifiers|\.keyCode' "$ROOT/engine/Sources"; then
  echo "verify s02-observer: key value access found in engine/Sources"
  exit 1
fi
echo "verify s02-observer: OK ($ran tests)"
