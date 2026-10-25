#!/usr/bin/env bash
# s03-brain-core done-signal. Contract: slices/s03-brain-core/SPEC.md.
# Runs the s03 test files (brain/tests/s03-*), requires at least MIN_TESTS tests with zero failures, then typechecks
# the whole brain package (strict). Prints one "FAIL ..." line per failing check; exits 0 only when all pass.
# Bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
SLICE=s03
MIN_TESTS=20
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
if [ ! -d "$BRAIN/node_modules/typescript" ]; then
  (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
fi

out="$(cd "$BRAIN" && bun test "tests/${SLICE}-" 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || fail "bun test exited $code"
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ -n "$ran" ] || { ran=0; fail "could not read the test count"; }
[ "${failed:-1}" = "0" ] || fail "${failed:-?} failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran tests ran for $SLICE, need at least $MIN_TESTS"

tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

if [ $fails -ne 0 ]; then echo "$SLICE verify: $fails check(s) failed"; exit 1; fi
echo "$SLICE verify: PASS ($ran tests)"
