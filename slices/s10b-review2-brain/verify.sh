#!/usr/bin/env bash
# s10b-review2-brain done-signal. Contract: slices/s10b-review2-brain/SPEC.md.
# 1. all brain tests pass, at least MIN_TESTS; 2. strict typecheck; 3. every REVIEW-2 brain id has passing tests;
# 4. the suite passes in America/Toronto and Asia/Karachi.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
MIN_TESTS=360
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

# 3. Every REVIEW-2 brain id has named, passing tests (N7 is the SPEC position, tested for presence).
for tag in N1 N2 N3 N4 N5 N6 N7 N8 N9 PRIV LOG; do
  grep -rqE "test\(\"$tag: |test\(\`$tag: " "$BRAIN"/tests/s10b-* || { fail "no test named \"$tag: ...\" in brain/tests/s10b-*"; continue; }
  t="$(cd "$BRAIN" && bun test tests/s10b-review2 -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: ${n} passing" || fail "tests for $tag did not pass"
done

# 4. The whole brain suite in two zones either side of UTC.
for tz in America/Toronto Asia/Karachi; do
  o="$(cd "$BRAIN" && TZ="$tz" bun test 2>&1)"
  set -- $(count "$o")
  [ "$2" = "0" ] && [ "$1" -ge "$MIN_TESTS" ] && echo "TZ=$tz: $1 tests pass" || { echo "$o" | grep -E "\(fail\)" | head -10; fail "brain suite under TZ=$tz ($2 failing)"; }
done

if [ $fails -ne 0 ]; then echo "s10b verify: $fails check(s) failed"; exit 1; fi
echo "s10b verify: PASS ($ran tests)"
