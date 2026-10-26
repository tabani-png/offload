#!/usr/bin/env bash
# s27-workflow-reads done-signal. Contract: slices/s27-workflow-reads/SPEC.md.
# 1. brain typecheck   2. s27 suite (>= MIN_TESTS, every tag present and passing)   3. s26 suite still green
# 4. full brain suite   5. the builder stays off by default   6. scope
# One "FAIL ..." line per failing check; every check runs. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=0abc4e0   # origin/main when this slice started
MIN_TESTS=34
TAGS="SOURCE STEP GATE FETCH DRYRUN LIVE EXECUTE METRIC"
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s27 suite"
for f in plan/read-source.ts workflows/read-fetch.ts; do [ -f "$BRAIN/src/$f" ] || fail "brain/src/$f does not exist"; done
JUNIT="$(mktemp "${TMPDIR:-/tmp}/offload-s27-junit-XXXXXX")"
trap 'rm -f "$JUNIT"' EXIT
# One run of the whole suite: the path tests are ordered steps sharing one world, so tags are read from the report.
out="$(cd "$BRAIN" && env -u OFFLOAD_BUILDER_ENABLED bun test tests/s27-workflow-reads --reporter=junit --reporter-outfile="$JUNIT" 2>&1)"; code=$?
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s27 tests exited $code"; }
tags="$(bun "$ROOT/slices/s27-workflow-reads/tags.ts" "$JUNIT" "$TAGS" 2>&1)" || fail "could not read the s27 test report"
ran="$(echo "$tags" | sed -n 's/^total \([0-9][0-9]*\) .*/\1/p')"
skipped="$(echo "$tags" | sed -n 's/^total [0-9]* skipped \([0-9][0-9]*\)$/\1/p')"
echo "s27 tests: ${ran:-0} (skipped ${skipped:-?})"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s27 tests ran, need $MIN_TESTS"
[ "${skipped:-1}" = "0" ] || fail "s27 tests were skipped"
for tag in $TAGS; do
  grep -rqE "test\(\"$tag: " "$BRAIN"/tests/s27-workflow-reads 2>/dev/null || { fail "no test named \"$tag: ...\""; continue; }
  line="$(echo "$tags" | grep -E "^$tag [0-9]+ [0-9]+$")"
  n="$(echo "$line" | cut -d' ' -f2)"; b="$(echo "$line" | cut -d' ' -f3)"
  [ "${n:-0}" -gt 0 ] && [ "${b:-1}" -eq 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass (${n:-0} passing, ${b:-?} failing)"
done

echo "== s26 suite (the items.csv path is unchanged)"
s26="$(cd "$BRAIN" && env -u OFFLOAD_BUILDER_ENABLED bun test tests/s26-automation-e2e 2>&1)" || { echo "$s26" | grep -E "\(fail\)" | head -10; fail "s26 suite failed"; }

echo "== full brain suite"
if [ "${S27_SKIP_FULL_SUITE:-}" = "1" ]; then
  # Only when the coordinator runs the full suite separately (shared /tmp collisions); never a silent pass.
  echo "full brain suite: SKIPPED (S27_SKIP_FULL_SUITE=1): run it separately before merging"
else
  all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
  echo "$all" | grep -E "^\s*[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
  [ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }
fi

echo "== builder stays off by default"
grep -q 'process.env.OFFLOAD_BUILDER_ENABLED !== "1"' "$BRAIN/src/builder/runner.ts" || fail "builder/runner.ts no longer refuses without OFFLOAD_BUILDER_ENABLED=1"
if grep -rnE 'OFFLOAD_BUILDER_ENABLED' "$BRAIN/tests/s27-workflow-reads" | grep -q .; then fail "an s27 test touches the builder flag"; else echo "builder default untouched"; fi

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
    brain/tests/s27-workflow-reads/*|slices/s27-workflow-reads/*|brain/src/plan/read-source.ts|brain/src/workflows/read-fetch.ts|brain/src/workflows/gate.ts|brain/src/workflows/types.ts|brain/src/workflows/drafter.ts|brain/src/workflows/plan-live.ts|brain/src/workflows/runner.ts|brain/src/workflows/dryrun.ts|brain/src/plan/dryrun.ts|brain/src/workflows/service.ts|brain/src/api/workflow-routes.ts|brain/src/api/server.ts|brain/src/api/types.ts|brain/src/api/s14-types.ts|brain/src/understanding/surfaces.ts|brain/src/workflows/batch.ts|brain/src/api/scheduler.ts|brain/API.md|plan/plan.md|plan/adr/0015-read-steps.md|brain/src/connectors/api.ts) ;;
    *) fail "out-of-scope path changed: $p" ;;
  esac
done <<< "$SLICE_FILES"
[ $scope_rc -ne 0 ] || echo "scope checked ($(printf '%s' "$SLICE_FILES" | grep -c .) files)"

[ "$fails" -eq 0 ] && echo "s27-workflow-reads: PASS" || { echo "s27-workflow-reads: $fails failing check(s)"; exit 1; }
