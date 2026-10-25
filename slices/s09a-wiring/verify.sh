#!/usr/bin/env bash
# s09a done-signal: the app builds; S09A tests (>= 55, incl. a live bun brain and real child processes) and the whole
# app suite (>= 130) pass; a fresh 2x render has the onboarding steps, the permission rows and the long real schedule
# line in dark and light; the scripts parse and verify-all lists every slice; the live e2e captures exist.
# E2E=1 re-runs slices/s09a-wiring/e2e.sh first (live windows, real brain, ONE model call).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BUILD="$ROOT/app/build.sh"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable at $BIN"

echo "== tests (S09A)"
"$APP_BUILD" test --filter S09A > "$OUT/s09a.txt" 2>&1 || { tail -40 "$OUT/s09a.txt"; fail "S09A tests"; }
n="$(count < "$OUT/s09a.txt")"
echo "S09A tests passed: $n"
[ "${n:-0}" -ge 55 ] || fail "expected >= 55 S09A tests, got ${n:-0}"

echo "== tests (all app suites)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "app test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all app tests passed: $nall"
[ "${nall:-0}" -ge 130 ] || fail "expected >= 130 app tests, got ${nall:-0}"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
for s in onboarding-watches onboarding-permissions onboarding-comeback dashboard-permissions review-real-schedule; do
  for scheme in dark light; do
    f="$OUT/png/$s-$scheme.png"
    [ -s "$f" ] || fail "missing $f"
    w="$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')"
    [ "${w:-0}" -ge 400 ] || fail "$f is only ${w:-0}px wide"
    [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
  done
  echo "ok $s (dark + light)"
done

echo "== scripts"
for s in demo run verify-all; do
  [ -x "$ROOT/scripts/$s.sh" ] || fail "scripts/$s.sh missing or not executable"
  bash -n "$ROOT/scripts/$s.sh" || fail "scripts/$s.sh does not parse"
done
grep -q -- "--install-agent" "$ROOT/scripts/run.sh" || fail "run.sh lacks --install-agent"
grep -q "scratch/demo" "$ROOT/scripts/demo.sh" || fail "demo.sh does not use scratch/demo"
listed="$("$ROOT/scripts/verify-all.sh" --list | wc -l | tr -d ' ')"
have="$(ls "$ROOT"/slices/*/verify.sh | wc -l | tr -d ' ')"
[ "$listed" = "$have" ] || fail "verify-all lists $listed slices, $have have verify.sh"
echo "ok scripts (verify-all covers $have slices)"

if [ "${E2E:-0}" = 1 ]; then
  echo "== live e2e (one model call)"
  bash "$ROOT/slices/s09a-wiring/e2e.sh" || fail "live e2e"
fi
echo "== live e2e captures"
for s in card review-drafting review-dryrun review-confirm review-approved dashboard; do
  [ -s "$ROOT/app/snapshots/live/e2e-$s.png" ] || fail "missing app/snapshots/live/e2e-$s.png (run E2E=1 $0)"
done
echo "ok 6 e2e captures"
echo "PASS s09a-wiring"
