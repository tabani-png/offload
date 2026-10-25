#!/usr/bin/env bash
# Done-signal for s01-engine-scaffold: engine/build.sh builds OffloadCore + offload-observer with plain swiftc, the
# whole engine Swift Testing suite (S01 + S02) runs and passes with at least MIN_TESTS tests, the build outputs exist,
# and engine/Sources holds no network code. Exits non-zero on any failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s01}"
MIN_TESTS=25

status=0
out="$("$ROOT/engine/build.sh" test 2>&1)" || status=$?
plain="$(printf '%s\n' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E '✘|error:' | head -n 60 || true
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true

ran="$(printf '%s\n' "$plain" | sed -n 's/.*Test run with \([0-9][0-9]*\) tests\{0,1\}.*/\1/p' | tail -n 1)"
if [ "${ran:-0}" -lt "$MIN_TESTS" ]; then
  echo "verify s01-engine-scaffold: expected at least $MIN_TESTS engine tests to run, got ${ran:-0}"
  exit 1
fi
[ "$status" -eq 0 ] || { echo "verify s01-engine-scaffold: tests failed (exit $status)"; exit "$status"; }

for f in libOffloadCore.dylib OffloadCore.swiftmodule offload-observer offload-tests; do
  [ -e "$OFFLOAD_BUILD_DIR/$f" ] || { echo "verify s01-engine-scaffold: missing build output $f"; exit 1; }
done

if grep -rnE 'URLSession|URLRequest|NSURLConnection|import Network\b|NWConnection|CFStream|CFSocket' \
    "$ROOT/engine/Sources"; then
  echo "verify s01-engine-scaffold: network code found in engine/Sources"
  exit 1
fi
echo "verify s01-engine-scaffold: OK ($ran tests)"
