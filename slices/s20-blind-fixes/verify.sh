#!/usr/bin/env bash
# s20-blind-fixes done-signal. Contract: slices/s20-blind-fixes/SPEC.md.
# 1. brain typecheck   2. s20 suite (>= MIN_TESTS, every tag present and passing)   3. full brain suite
# 4. no s20 commit since BASE touches the screenwatch importer or another out-of-scope path.
# One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=9f46fdb   # the commit this slice starts from
MIN_TESTS=24
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s20 suite"
out="$(cd "$BRAIN" && bun test tests/s20-blind-fixes 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s20 tests exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s20 tests ran, need $MIN_TESTS"
for tag in MERGE TYPER SURFACE SAVING KEYS ROUTE; do
  grep -rqE "test\(\"$tag: " "$BRAIN"/tests/s20-blind-fixes || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s20-blind-fixes -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^ *[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

echo "== scope (files touched by s20 commits since $BASE)"
# Only this slice's own commits (subject starts with "s20"; merges excluded).
touched="$(git -C "$ROOT" log --no-merges --format= --name-only --grep='^s20' "$BASE..HEAD" 2>/dev/null | sort -u)"
for f in $touched; do
  case "$f" in
    brain/tools/import-screenwatch.ts) fail "s20 commit touched the screenwatch importer (owned by another builder)";;
    brain/tests/s20-blind-fixes/*) ;;
    brain/tests/*) fail "s20 commit touched an existing test file $f";;
    engine/*|packet/*|schemas/*|app/*|brain/fixtures/*) fail "s20 commit touched out-of-scope $f";;
    brain/src/workflows/gate.ts|brain/src/workflows/allowlist.ts|brain/src/workflows/executor.ts|brain/src/workflows/batch.ts|brain/src/workflows/runner.ts|brain/src/workflows/chain-executor.ts) fail "s20 commit touched the gate path $f";;
    brain/src/connectors/catalog.ts|brain/src/connectors/config.ts|brain/src/connectors/targets.ts|brain/src/connectors/composio.ts|brain/src/connectors/api.ts|brain/src/connectors/mcp-probe.ts) fail "s20 commit touched s13's $f";;
  esac
done
echo "scope checked ($(echo "$touched" | grep -c . ) files in s20 commits)"

if [ $fails -ne 0 ]; then echo "s20 verify: $fails check(s) failed"; exit 1; fi
echo "s20 verify: PASS (${ran} s20 tests)"
