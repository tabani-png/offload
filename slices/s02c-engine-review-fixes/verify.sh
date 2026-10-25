#!/usr/bin/env bash
# Done-signal for s02c-engine-review-fixes (REVIEW-1 M4, L4, H4 support): builds the engine, runs the FULL Swift Testing suite (S01, S02, S02B, S02C),
# checks that at least MIN_TESTS ran, and that engine/Sources holds no network code, no key-value access and no
# process spawning (install-agent only writes a plist). Exits non-zero on any failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s02c}"
MIN_TESTS=100

status=0
out="$("$ROOT/engine/build.sh" test 2>&1)" || status=$?
plain="$(printf '%s\n' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E '✘|error:' | grep -v 'offload-observer \[' | head -n 60 || true
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true

ran="$(printf '%s\n' "$plain" | sed -n 's/.*Test run with \([0-9][0-9]*\) tests\{0,1\}.*/\1/p' | tail -n 1)"
if [ "${ran:-0}" -lt "$MIN_TESTS" ]; then
  echo "verify s02c: expected at least $MIN_TESTS tests to run, got ${ran:-0}"
  exit 1
fi
[ "$status" -eq 0 ] || { echo "verify s02c: tests failed (exit $status)"; exit "$status"; }
s02b="$(printf '%s\n' "$plain" | grep -cE '✔ Suite S02B' || true)"
[ "$s02b" -ge 5 ] || { echo "verify s02c: expected 5 S02B suites to pass, got $s02b"; exit 1; }
s02c="$(printf '%s\n' "$plain" | grep -cE '✔ Suite S02C' || true)"
[ "$s02c" -ge 3 ] || { echo "verify s02c: expected 3 S02C suites to pass, got $s02c"; exit 1; }

if grep -rnE 'URLSession|URLRequest|NSURLConnection|import Network\b|NWConnection|CFStream|CFSocket' \
    "$ROOT/engine/Sources"; then
  echo "verify s02c: network code found in engine/Sources"
  exit 1
fi
if grep -rnE '\.characters|charactersIgnoringModifiers|\.keyCode' "$ROOT/engine/Sources"; then
  echo "verify s02c: key value access found in engine/Sources"
  exit 1
fi
if grep -rnE 'Process\(\)|NSTask|posix_spawn|\bsystem\(' "$ROOT/engine/Sources"; then
  echo "verify s02c: process spawning found in engine/Sources (launchctl must never be run by the engine)"
  exit 1
fi
echo "verify s02c-engine-review-fixes: OK ($ran tests)"
