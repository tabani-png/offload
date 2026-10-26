#!/usr/bin/env bash
# s24-brief-runner done-signal. Contract: slices/s24-brief-runner/SPEC.md.
# 1. brain typecheck   2. s24 suite (>= MIN_TESTS, every tag present and passing)   3. full brain suite
# 4. no s24 commit since BASE touches an out-of-scope path.   One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=8e51c10   # s22-solution-designer head this slice stacks on
MIN_TESTS=20
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s24 suite"
[ -d "$BRAIN/src/builder" ] || fail "brain/src/builder does not exist"
out="$(cd "$BRAIN" && bun test tests/s24-brief-runner 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s24 tests exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s24 tests ran, need $MIN_TESTS"
for tag in CHECKS LOOP CAPS TAMPER GATE SAFETY RECORD CLI API; do
  grep -rqE "\(\"$tag: " "$BRAIN"/tests/s24-brief-runner 2>/dev/null || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s24-brief-runner -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "LIVE: ANTHROPIC_API_KEY set, live test ran in the suite"; else echo "LIVE: skipped (no ANTHROPIC_API_KEY)"; fi

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

echo "== scope"
if git -C "$ROOT" cat-file -e "$BASE" 2>/dev/null; then
  changed="$( (git -C "$ROOT" diff --name-only "$BASE"...HEAD; git -C "$ROOT" diff --name-only HEAD) 2>/dev/null | sort -u)"
  for p in $changed; do
    case "$p" in
      engine/*|packet/*|schemas/*|app/*|brain/tools/import-screenwatch.ts|brain/src/understanding/induce.ts|brain/src/understanding/embed.ts|brain/src/plan/steps.ts|brain/src/insights/saving.ts|brain/src/store/vault.ts|brain/src/connectors/chain.ts|brain/src/connectors/targets.ts|brain/src/workflows/gate.ts|brain/src/workflows/allowlist.ts|brain/src/workflows/executor.ts|brain/src/workflows/batch.ts|brain/src/workflows/runner.ts|brain/src/workflows/chain-executor.ts)
        fail "out-of-scope path changed: $p" ;;
    esac
  done
  echo "scope checked ($(echo "$changed" | grep -c . ) files)"
else
  echo "scope: BASE $BASE not in history (shallow clone), skipped"
fi

[ "$fails" -eq 0 ] && echo "s24-brief-runner: PASS" || { echo "s24-brief-runner: $fails failing check(s)"; exit 1; }
