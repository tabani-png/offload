#!/usr/bin/env bash
# s23-time-breakdown done-signal. Contract: slices/s23-time-breakdown/SPEC.md.
# contract (frozen files)  brain (deps, typecheck, s23 suite per tag, full suite)  fixtures (record.ts --check)
# app (build, S23 suites per suite, all app suites)  views (greps)  snapshots (fresh 2x render, committed, size)
# live (time captures + QA file; skipped on CI)  budget (live PNG sizes)  scope (s23 commits since BASE).
# Build commits are "s23-time-breakdown: ..." or feat|fix|chore|ui(s23...); contract commits are test(s23-time-breakdown).
# Every check runs and prints one "FAIL ..." line when it fails, so a red run shows every reason. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/slices/s23-time-breakdown"
BRAIN="$ROOT/brain"
S="$ROOT/app/Sources"
SNAP="$ROOT/app/snapshots"
LIVE="$SNAP/live"
BASE=c21483c   # origin/main when the contract was written
MIN_BRAIN_TESTS=45
MIN_S23_SWIFT=26
MIN_APP_TESTS=430   # 408 app tests on main + the 26 S23 tests
MAX_S23_PNG_KB=400
MAX_LIVE_PNG_KB=1024
MAX_LIVE_DIR_KB=10240
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
export OFFLOAD_KEYS=file
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
kb() { echo $(( ( $(stat -f %z "$1" 2>/dev/null || stat -c %s "$1") + 1023 ) / 1024 )); }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[ -x "$BUN" ] || { echo "FAIL bun not found"; exit 1; }

FROZEN="slices/s23-time-breakdown/SPEC.md slices/s23-time-breakdown/verify.sh slices/s23-time-breakdown/record.ts slices/s23-time-breakdown/tests/S23Tests.swift brain/tests/s23-time-breakdown"

echo "== contract"
for f in SPEC.md verify.sh record.ts tests/S23Tests.swift; do [ -s "$HERE/$f" ] || fail "missing slices/s23-time-breakdown/$f"; done
for f in setup.ts breakdown.test.ts round.test.ts findings.test.ts neutral.test.ts api.test.ts; do
  [ -s "$BRAIN/tests/s23-time-breakdown/$f" ] || fail "missing brain/tests/s23-time-breakdown/$f"
done
# Frozen: only test(s23-time-breakdown) commits may touch the contract files.
bad_commits="$(git -C "$ROOT" log --no-merges --format='%h %s' "$BASE..HEAD" -- $FROZEN 2>/dev/null | grep -v ' test(s23-time-breakdown)' || true)"
[ -z "$bad_commits" ] || fail "frozen contract files changed outside test(s23-time-breakdown) commits: $(echo "$bad_commits" | tr '\n' ';')"
if ! git -C "$ROOT" diff --quiet HEAD -- $FROZEN 2>/dev/null; then fail "uncommitted edits to frozen contract files"; fi
echo "contract checked"

echo "== brain: dependencies and typecheck"
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && "$BUN" install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
if git -C "$ROOT" diff --quiet "$BASE" -- brain/package.json brain/bun.lock; then echo "no new dependency"; else fail "brain/package.json or bun.lock changed since $BASE"; fi
tsc_out="$(cd "$BRAIN" && "$BUN" x tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | grep -E "error TS" | head -12; fail "typecheck (bunx tsc --noEmit)"; }

echo "== brain: s23 suite"
out="$(cd "$BRAIN" && "$BUN" test tests/s23-time-breakdown 2>&1)"; code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
if [ $code -ne 0 ]; then echo "$out" | grep -E "\(fail\)|error:|Cannot find|not found" | sort -u | head -15; fail "s23 brain tests exited $code"; fi
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${ran:-0}" -ge "$MIN_BRAIN_TESTS" ] || fail "only ${ran:-0} s23 brain tests ran, need $MIN_BRAIN_TESTS"
for tag in TOTAL SUMS REFS KINDS ROUND FREED NOCLAIM FIXKIND WORKFLOW NEUTRAL API; do
  grep -rqE "test\(\`?\"?$tag: " "$BRAIN"/tests/s23-time-breakdown 2>/dev/null || { fail "no brain test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && "$BUN" test tests/s23-time-breakdown -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  if echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ]; then echo "$tag: $n passing"; else fail "brain tag ${tag}: did not pass (${n:-0} passing)"; fi
done

echo "== brain: full suite"
all="$(cd "$BRAIN" && "$BUN" test 2>&1)"; acode=$?
echo "$all" | grep -E "^\s*[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" || true
[ $acode -eq 0 ] || { echo "$all" | grep -E "\(fail\)" | grep -v "s23-time-breakdown" | head -10; fail "full brain suite exited $acode"; }

echo "== brain: numbers by code"
if [ -d "$BRAIN/src/time" ]; then
  if grep -rnE "from \"\.\./models/|claude-agent-sdk|@anthropic-ai|fetch\(" "$BRAIN/src/time"; then fail "brain/src/time imports a model or network code (ADR 0005)"; fi
else
  fail "no brain/src/time"
fi

echo "== fixtures (the app's wire fixtures are the brain's own answer)"
rec="$(cd "$BRAIN" && "$BUN" run "$HERE/record.ts" --check 2>&1)"; rcode=$?
echo "$rec" | grep -E "^(ok|FAIL) " || echo "$rec" | grep -E "error|Cannot find" | head -5
[ $rcode -eq 0 ] || fail "record.ts --check: committed fixtures are missing or differ from GET /time on the neutral week"

echo "== app: build and S23 suites"
APP_BUILD="$ROOT/app/build.sh"
if "$APP_BUILD" > "$OUT/build.txt" 2>&1; then
  echo "app builds"
  BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
  "$APP_BUILD" test --filter S23 > "$OUT/s23.txt" 2>&1; scode=$?
  clean() { sed -E 's/\x1b\[[0-9;]*m//g' "$1"; }
  ns23="$(clean "$OUT/s23.txt" | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1)"
  [ $scode -eq 0 ] || { clean "$OUT/s23.txt" | grep -E "error:|failed|✘" | head -15; fail "S23 app tests exited $scode"; }
  [ "${ns23:-0}" -ge "$MIN_S23_SWIFT" ] || fail "expected >= $MIN_S23_SWIFT S23 app tests, got ${ns23:-0} (is slices/s23-time-breakdown/tests in app/build.sh?)"
  for suite in "S23 wire" "S23 rounding" "S23 first screen order" "S23 fix kind" "S23 no inflated claims" "S23 neutral demo" "S23 home" "S23 PR13 follow-ups"; do
    clean "$OUT/s23.txt" | grep -qE "Suite \"$suite\" passed" && echo "suite $suite: passed" || fail "app suite \"$suite\" did not run and pass"
  done
  "$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1; allcode=$?
  nall="$(clean "$OUT/all.txt" | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1)"
  [ $allcode -eq 0 ] || { clean "$OUT/all.txt" | grep -E "✘" | grep -v "S23" | head -10; fail "app test suite (all) exited $allcode"; }
  [ "${nall:-0}" -ge "$MIN_APP_TESTS" ] || fail "expected >= $MIN_APP_TESTS app tests in all, got ${nall:-0}"
else
  tail -15 "$OUT/build.txt"; fail "app build"
  BIN=""
fi

echo "== views"
TV="$S/Surfaces/TimeView.swift"
if [ -f "$TV" ]; then
  grep -q 'TimeScreen' "$TV" || fail "TimeView.swift does not read TimeScreen"
  grep -q 'sections' "$TV" || fail "TimeView.swift does not draw TimeScreen.sections in order"
  if grep -n 'SampleWeek' "$TV" >/dev/null; then fail "TimeView.swift uses the outreach SampleWeek"; fi
  if grep -nE 'savingPct|"[^"]*%[^"]*"' "$TV" >/dev/null; then fail "TimeView.swift shows a saving percentage"; fi
else
  fail "no app/Sources/Surfaces/TimeView.swift"
fi
grep -qE 'section: DashboardSection = (DashboardSection)?\.home|section: DashboardSection = \.time' "$S/Surfaces/DashboardModel.swift" 2>/dev/null || fail "the dashboard does not open on DashboardSection.home"
grep -q 'TimeView' "$S/Surfaces/DashboardView.swift" 2>/dev/null || fail "DashboardView does not show TimeView"
if grep -nE '"time-[a-z-]+".*SampleWeek' "$S/App/Snapshotter.swift" >/dev/null 2>&1; then fail "a time snapshot scene uses SampleWeek"; fi
grep -q 'NeutralWeek' "$S/App/Snapshotter.swift" 2>/dev/null || fail "Snapshotter has no NeutralWeek time scenes"
grep -q 'gen-neutral.ts' "$ROOT/scripts/demo.sh" || fail "scripts/demo.sh cannot seed the neutral week (--neutral)"
grep -qE 'time-week' "$ROOT/scripts/live-captures.sh" || fail "scripts/live-captures.sh has no time capture"
grep -qE 'demo.sh"? --neutral|--neutral' "$ROOT/scripts/live-captures.sh" || fail "scripts/live-captures.sh does not capture the time screen on the neutral week"

echo "== snapshots (fresh render, 2x)"
if [ -n "${BIN:-}" ] && [ -x "$BIN" ]; then
  "$BIN" --snapshot "$OUT/png" > "$OUT/snap.txt" 2>&1 || fail "snapshot render exited non-zero"
  for s in time-week time-day time-nofix time-empty; do
    for scheme in dark light; do
      [ -s "$OUT/png/$s-$scheme.png" ] || fail "missing fresh $s-$scheme.png"
      if [ -s "$SNAP/$s-$scheme.png" ]; then
        k="$(kb "$SNAP/$s-$scheme.png")"; [ "$k" -le "$MAX_S23_PNG_KB" ] || fail "app/snapshots/$s-$scheme.png is ${k} KB, budget ${MAX_S23_PNG_KB} KB"
      else
        fail "missing committed app/snapshots/$s-$scheme.png"
      fi
    done
  done
else
  fail "snapshots: no app binary to render with"
fi

echo "== live (time screen on the neutral week, real brain)"
LIVESET="$ROOT/slices/s10e-ui-round4/live-set.txt"
for n in time-week time-day; do grep -qx "$n" "$LIVESET" || fail "$n is not in the live set"; done
if [ "${CI:-}" = "true" ]; then
  echo "live time captures: SKIPPED (needs a real screen; run scripts/live-captures.sh --only time locally)"
else
  for n in time-week time-day; do
    if [ -s "$LIVE/$n.png" ]; then k="$(kb "$LIVE/$n.png")"; [ "$k" -le "$MAX_S23_PNG_KB" ] || fail "live/$n.png is ${k} KB, budget ${MAX_S23_PNG_KB} KB"
    else fail "missing app/snapshots/live/$n.png"; fi
  done
  QA="$LIVE/time-week.qa.txt"
  if [ -s "$QA" ]; then
    grep -qx 'demo=neutral' "$QA" || fail "time-week.qa.txt: the capture was not on the neutral demo"
    sec="$(sed -n 's/^sections=//p' "$QA")"
    case "$sec" in breakdown,findings|breakdown,findings,workflows) echo "sections: $sec";; *) fail "time-week.qa.txt: sections '$sec' (breakdown first, then findings, workflows last)";; esac
    t="$(sed -n 's/^total=//p' "$QA")"; bt="$(sed -n 's/^brain-total=//p' "$QA")"
    [ -n "$t" ] && [ "$t" = "$bt" ] || fail "time-week.qa.txt: app total '$t' differs from the brain's '$bt'"
    nf="$(sed -n 's/^findings=//p' "$QA")"; [ "${nf:-0}" -ge 2 ] 2>/dev/null || fail "time-week.qa.txt: ${nf:-0} findings, need >= 2"
    grep -qE '^fix-kinds=(s22|absent)$' "$QA" || fail "time-week.qa.txt: no fix-kinds line"
    if grep -qiE 'outreach|investor|cold e-?mail|prospect|fundrais' "$QA"; then fail "time-week.qa.txt mentions outreach"; fi
  else
    fail "missing app/snapshots/live/time-week.qa.txt"
  fi
fi

echo "== budget (F5: capture PNG sizes)"
total_kb=0
for p in "$LIVE"/*.png; do
  [ -f "$p" ] || continue
  k="$(kb "$p")"; total_kb=$((total_kb + k))
  [ "$k" -le "$MAX_LIVE_PNG_KB" ] || fail "live/$(basename "$p") is ${k} KB, budget ${MAX_LIVE_PNG_KB} KB"
done
[ "$total_kb" -le "$MAX_LIVE_DIR_KB" ] || fail "app/snapshots/live PNGs total ${total_kb} KB, budget ${MAX_LIVE_DIR_KB} KB"
echo "live PNGs: ${total_kb} KB"

echo "== scope (files touched by s23 commits since $BASE)"
touched="$(git -C "$ROOT" log --no-merges --format= --name-only -E --grep='^(feat|fix|chore|ui)?\(?s23' "$BASE..HEAD" 2>/dev/null | sort -u)"
for f in $touched; do
  case "$f" in
    brain/src/time/*|brain/src/api/server.ts|brain/src/api/types.ts|brain/API.md|brain/fixtures/gen-neutral.ts) ;;
    app/Sources/Core/*|app/Sources/Surfaces/*|app/Sources/App/Snapshotter.swift|app/Sources/App/OffloadApp.swift|app/build.sh) ;;
    app/snapshots/*|scripts/demo.sh|scripts/live-captures.sh|slices/s10e-ui-round4/live-set.txt) ;;
    slices/s23-time-breakdown/tests/fixtures/*) ;;
    slices/s23-time-breakdown/SPEC.md|slices/s23-time-breakdown/verify.sh|slices/s23-time-breakdown/record.ts|slices/s23-time-breakdown/tests/S23Tests.swift|brain/tests/s23-time-breakdown/*)
      fail "s23 build commit touched frozen $f";;
    *) fail "s23 commit touched out-of-scope $f";;
  esac
done
echo "scope checked ($(echo "$touched" | grep -c .) files in s23 commits)"

if [ $fails -ne 0 ]; then echo "s23 verify: $fails check(s) failed"; exit 1; fi
echo "PASS s23-time-breakdown (${ran} brain tests, ${ns23:-0} S23 app tests)"
