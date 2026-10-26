#!/usr/bin/env bash
# s26-automation-e2e done-signal. Contract: slices/s26-automation-e2e/SPEC.md.
# 1. brain typecheck   2. s26 suite (>= MIN_TESTS, every tag present and passing)   3. full brain suite
# 4. the builder stays off by default (runner.ts still checks the flag; no s26 file turns it on)
# 5. ADR 0013: every fix kind, >= 2 options with a cost each, one recommendation   6. scope
# One "FAIL ..." line per failing check; every check runs. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=1298f15   # origin/main when this slice started
MIN_TESTS=20
TAGS="CAPTURE INSIGHT TIME DESIGN BUILD DRYRUN APPROVE LIVE EXECUTE RECORD METRIC SETUP REMOVE TOOL LEAVE"
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s26 suite"
[ -f "$BRAIN/src/workflows/plan-live.ts" ] || fail "brain/src/workflows/plan-live.ts does not exist"
out="$(cd "$BRAIN" && env -u OFFLOAD_BUILDER_ENABLED bun test tests/s26-automation-e2e 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s26 tests exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s26 tests ran, need $MIN_TESTS"
echo "$out" | grep -qE "^\s*[1-9][0-9]* skip$" && fail "s26 tests were skipped"
for tag in $TAGS; do
  grep -rqE "test\(\"$tag: " "$BRAIN"/tests/s26-automation-e2e 2>/dev/null || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && env -u OFFLOAD_BUILDER_ENABLED bun test tests/s26-automation-e2e -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^\s*[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

echo "== builder stays off by default"
grep -q 'process.env.OFFLOAD_BUILDER_ENABLED !== "1"' "$BRAIN/src/builder/runner.ts" || fail "builder/runner.ts no longer refuses without OFFLOAD_BUILDER_ENABLED=1"
if grep -rnE 'OFFLOAD_BUILDER_ENABLED *(=|:) *"?1' "$BRAIN/tests/s26-automation-e2e" | grep -q .; then
  fail "an s26 test turns the builder on"
else
  echo "builder default untouched"
fi

echo "== ADR 0013 safe builder"
ADR="$ROOT/plan/adr/0013-safe-builder.md"
if [ -f "$ADR" ]; then
  for k in workflow tool setup remove_step leave_alone; do grep -q "| $k |" "$ADR" || fail "ADR 0013 does not place fix kind $k"; done
  opts="$(grep -cE '^### [A-Z]\. ' "$ADR")"; [ "$opts" -ge 2 ] || fail "ADR 0013 has $opts options, need >= 2"
  costs="$(grep -cE '^- Cost:' "$ADR")"; [ "$costs" -ge "$opts" ] || fail "ADR 0013: $costs costs for $opts options"
  grep -qE '^## Recommendation' "$ADR" && grep -qE '^\*\*[A-Z] ' "$ADR" || fail "ADR 0013 has no single recommendation"
  grep -q 'KERN_PROCARGS2' "$ADR" || fail "ADR 0013 does not name the residual"
  [ $fails -eq 0 ] && echo "ADR ok ($opts options)"
else
  fail "plan/adr/0013-safe-builder.md missing"
fi

echo "== scope"
. "$ROOT/scripts/lib/slice-changes.sh"
slice_files --allow-skip "$BASE"; scope_rc=$?
case $scope_rc in
  0) ;;
  3) echo "scope: SKIPPED ($SLICE_ERROR)" ;;
  *) fail "scope check could not run: $SLICE_ERROR" ;;
esac
while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in
    brain/tests/s26-automation-e2e/*|slices/s26-automation-e2e/*|brain/src/workflows/plan-live.ts|brain/src/workflows/runner.ts|brain/src/workflows/dryrun.ts|brain/src/plan/dryrun.ts|brain/API.md|plan/adr/0013-safe-builder.md|plan/plan.md) ;;
    *) fail "out-of-scope path changed: $p" ;;
  esac
done <<< "$SLICE_FILES"
[ $scope_rc -ne 0 ] || echo "scope checked ($(printf '%s' "$SLICE_FILES" | grep -c .) files)"

[ "$fails" -eq 0 ] && echo "s26-automation-e2e: PASS" || { echo "s26-automation-e2e: $fails failing check(s)"; exit 1; }
