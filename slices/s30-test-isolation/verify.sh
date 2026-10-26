#!/usr/bin/env bash
# s30-test-isolation done-signal. Contract: slices/s30-test-isolation/SPEC.md.
# 1. typecheck   2. s24 suite alone and as two parallel processes   3. clock-pinned files at a far-off clock, two zones
# 4. whole brain suite under default TZ, America/Toronto, Asia/Karachi   5. scope
# One "FAIL ..." line per failing check; every check runs. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
SLICE="$ROOT/slices/s30-test-isolation"
BASE=0abc4e0   # origin/main when this slice started
MIN_TESTS=1700
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/offload-s30-XXXXXX")"
echo "logs: $LOGS"

count() { # $1 = log file; prints "ran failed"
  local ran failed
  ran="$(sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' "$1" | tail -1)"
  failed="$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$1" | tail -1)"
  echo "${ran:-0} ${failed:-1}"
}
check_log() { # $1 = log, $2 = label, $3 = minimum tests
  set -- "$1" "$2" "$3" $(count "$1")
  if [ "$5" = "0" ] && [ "$4" -ge "$3" ]; then echo "$2: $4 tests pass"; else grep -E "^\(fail\)" "$1" | head -10; fail "$2 ($5 failing, $4 ran)"; fi
}

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s24 alone"
(cd "$BRAIN" && bun test tests/s24-brief-runner >"$LOGS/s24-alone.log" 2>&1)
check_log "$LOGS/s24-alone.log" "s24 alone" 100

echo "== s24 twice in parallel"
(cd "$BRAIN" && bun test tests/s24-brief-runner >"$LOGS/s24-par-a.log" 2>&1) &
pa=$!
(cd "$BRAIN" && bun test tests/s24-brief-runner >"$LOGS/s24-par-b.log" 2>&1) &
pb=$!
wait $pa; wait $pb
check_log "$LOGS/s24-par-a.log" "s24 parallel A" 100
check_log "$LOGS/s24-par-b.log" "s24 parallel B" 100

echo "== clock-pinned files at a far-off clock"
PINNED="tests/s05-workflows/runner.test.ts tests/s05b-runner/idempotency.test.ts tests/s10b-review2/autorun.test.ts"
for tz in Asia/Karachi America/Toronto; do
  for at in 2026-12-15T21:00:00Z 2027-07-01T03:00:00Z; do
    log="$LOGS/pinned-$(echo "$tz" | tr / _)-$at.log"
    (cd "$BRAIN" && S30_FAKE_NOW="$at" TZ="$tz" bun test --preload ./tests/preload.ts --preload "$SLICE/fake-clock.ts" $PINNED >"$log" 2>&1)
    check_log "$log" "pinned files TZ=$tz clock=$at" 30
  done
done

echo "== whole brain suite in three zones"
for tz in default America/Toronto Asia/Karachi; do
  log="$LOGS/brain-$(echo "$tz" | tr / _).log"
  if [ "$tz" = default ]; then (cd "$BRAIN" && bun test >"$log" 2>&1); else (cd "$BRAIN" && TZ="$tz" bun test >"$log" 2>&1); fi
  check_log "$log" "brain suite TZ=$tz" "$MIN_TESTS"
done

echo "== scope"
# Against the fork point from origin/main (main merged in later brings other slices' files, which are not ours).
FORK="$(git -C "$ROOT" merge-base HEAD origin/main 2>/dev/null || echo "$BASE")"
if git -C "$ROOT" cat-file -e "$FORK^{commit}" 2>/dev/null; then
  bad="$(git -C "$ROOT" diff --name-only "$FORK" -- . | grep -vE '^(brain/src/builder/supervisor\.ts|brain/API\.md|brain/tests/helpers\.ts|brain/tests/s24-brief-runner/(setup|cleanup\.test|verdict-channel\.test|surfaces\.test)\.ts|brain/tests/s05-workflows/runner\.test\.ts|brain/tests/s05b-runner/idempotency\.test\.ts|brain/tests/s10b-review2/autorun\.test\.ts|slices/s30-test-isolation/.*)$' || true)"
  [ -z "$bad" ] && echo "scope ok" || { echo "$bad"; fail "files changed outside the s30 scope"; }
else
  echo "scope: base $FORK not in this clone, skipped"
fi

if [ $fails -ne 0 ]; then echo "s30 verify: $fails check(s) failed (logs: $LOGS)"; exit 1; fi
echo "s30 verify: PASS (logs: $LOGS)"
