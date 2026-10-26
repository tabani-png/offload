#!/usr/bin/env bash
# s18-name-masking done-signal. Contract: slices/s18-name-masking/SPEC.md.
# 1. no new dependency   2. brain typecheck   3. s18 suite (>= MIN_TESTS, every tag present and passing)
# 4. measured false-positive / false-negative rates (printed, within bounds; held-out FN printed, not a gate)   5. full brain suite
# 6. the masker imports no model and no network code   7. no s18 commit since BASE touches an out-of-scope path.
# One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
BASE=9f46fdb   # main as merged into this slice (review wave B: was f203a59, 21 commits behind)
MIN_TESTS=40
MAX_FP_PCT=2
MAX_FN_PCT=5
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"

echo "== dependencies"
if git -C "$ROOT" diff --quiet "$BASE" -- brain/package.json brain/bun.lock; then echo "no new dependency"; else fail "brain/package.json or bun.lock changed since $BASE"; fi

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s18 suite"
[ -d "$BRAIN/tests/s18-name-masking" ] || fail "no brain/tests/s18-name-masking"
out="$(cd "$BRAIN" && bun test tests/s18-name-masking 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s18 tests exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s18 tests ran, need $MIN_TESTS"
for tag in DETECT NONNAME PERSONAS ROUNDTRIP NOTES SPANS ROUTER EGRESS REVIEW SELF INJECT LEFTOVER HELDOUT; do
  grep -rqE "\(\"$tag: " "$BRAIN"/tests/s18-name-masking 2>/dev/null || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s18-name-masking -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

echo "== measured rates (deterministic masker over the test corpora)"
rates="$(cd "$BRAIN" && bun run tests/s18-name-masking/rates.ts 2>&1)"; rcode=$?
echo "$rates"
[ $rcode -eq 0 ] || fail "rates script exited $rcode"
fp="$(echo "$rates" | sed -n 's/^false positives: .* = \([0-9.]*\)%.*/\1/p' | tail -1)"
fn="$(echo "$rates" | sed -n 's/^false negatives: .* = \([0-9.]*\)%.*/\1/p' | tail -1)"
[ -n "$fp" ] && awk -v x="$fp" -v m="$MAX_FP_PCT" 'BEGIN { exit !(x <= m) }' || fail "false-positive rate ${fp:-?}% above ${MAX_FP_PCT}%"
[ -n "$fn" ] && awk -v x="$fn" -v m="$MAX_FN_PCT" 'BEGIN { exit !(x <= m) }' || fail "false-negative rate ${fn:-?}% above ${MAX_FN_PCT}%"

echo "== full brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"; acode=$?
echo "$all" | grep -E "^\s*[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | head -20; fail "full brain suite exited $acode"; }

echo "== the masker is deterministic and local"
if [ -d "$BRAIN/src/privacy" ]; then
  if grep -rnE "from \"\.\./models/|claude-agent-sdk|@anthropic-ai|fetch\(|node:http|node:net" "$BRAIN/src/privacy"; then fail "brain/src/privacy imports a model or network code"; fi
else
  fail "no brain/src/privacy"
fi
grep -q "names.mask" "$BRAIN/src/models/router.ts" 2>/dev/null || fail "the router does not mask requests"

echo "== scope (files touched by s18 commits since $BASE)"
touched="$(git -C "$ROOT" log --no-merges --format= --name-only --grep='^s18' "$BASE..HEAD" 2>/dev/null | sort -u)"
for f in $touched; do
  case "$f" in
    brain/src/privacy/*|brain/src/grouping/normalize.ts|brain/src/models/router.ts|brain/src/models/model.ts) ;;
    brain/src/vision/notes.ts|brain/src/vision/prompt.ts|brain/src/understanding/describe.ts) ;;
    brain/src/plan/text-step.ts|brain/src/plan/dryrun.ts|brain/src/tone/draft.ts) ;;
    brain/src/workflows/runner.ts|brain/src/workflows/dryrun.ts|brain/API.md|plan/adr/0010-name-masking.md) ;;
    brain/src/workflows/autorun.ts|brain/src/workflows/batch.ts|brain/src/api/workflow-routes.ts) ;;  # unfilled names never auto-sent (SPEC "Scope changes")
    brain/src/api/server.ts) ;;  # the default model is the masking router (SPEC "Scope changes", review round 2)
    brain/tests/s18-name-masking/*|slices/s18-name-masking/*) ;;
    brain/tests/s05b-runner/idempotency.test.ts) ;;  # the H3 fix ported from S2-02 (SPEC "Scope changes")
    *) fail "s18 commit touched out-of-scope $f";;
  esac
done
echo "scope checked ($(echo "$touched" | grep -c . ) files in s18 commits)"

if [ $fails -ne 0 ]; then echo "s18 verify: $fails check(s) failed"; exit 1; fi
echo "s18 verify: PASS (${ran} s18 tests)"
