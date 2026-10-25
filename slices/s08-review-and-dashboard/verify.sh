#!/usr/bin/env bash
# s08 done-signal: the app builds, the S08 suites pass (>= 60) and the whole app suite passes (>= 80), a fresh
# snapshot render has every review/dashboard surface in dark and light, and the committed review set exists.
# Exit 0 = done.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BUILD="$ROOT/app/build.sh"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

SURFACES="review review-dryrun review-confirm dashboard timeline pointer"
EXTRA="review-armed review-skill pointer-row"
LIVE="glass-dark-over-white glass-dark-over-dark glass-light-over-white glass-light-over-dark review-confirm dashboard-pointer"

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable at $BIN"

count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }

echo "== tests (S08)"
"$APP_BUILD" test --filter S08 > "$OUT/s08.txt" 2>&1 || { tail -40 "$OUT/s08.txt"; fail "S08 tests"; }
n08="$(count < "$OUT/s08.txt")"
echo "S08 tests passed: $n08"
[ "${n08:-0}" -ge 60 ] || fail "expected >= 60 S08 tests, got ${n08:-0}"

echo "== tests (all app suites: S06, S07, S08)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all tests passed: $nall"
[ "${nall:-0}" -ge 80 ] || fail "expected >= 80 tests, got ${nall:-0}"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
for s in $SURFACES $EXTRA; do
  for scheme in dark light; do
    f="$OUT/png/$s-$scheme.png"
    [ -s "$f" ] || fail "missing $f"
    w="$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')"
    [ "${w:-0}" -ge 400 ] || fail "$f is only ${w:-0}px wide"
  done
  echo "ok $s (dark + light)"
done

echo "== committed review set (app/snapshots)"
for s in $SURFACES $EXTRA; do
  for scheme in dark light; do
    [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
  done
done
for s in $LIVE; do
  [ -s "$ROOT/app/snapshots/live/$s.png" ] || fail "missing live capture app/snapshots/live/$s.png"
done
echo "ok 18 committed PNGs + 6 live captures"
[ -s "$ROOT/slices/s08-review-and-dashboard/DESIGN-REVIEW.md" ] || fail "missing DESIGN-REVIEW.md"

echo "PASS s08-review-and-dashboard"
