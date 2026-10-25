#!/usr/bin/env bash
# s07 done-signal: the app builds as a menu-bar .app, the S07 suites pass (>= 15 tests, whole run >= 15),
# snapshot mode renders every rail/card surface in light and dark, and the committed review PNGs exist.
# Exit 0 = done.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BUILD="$ROOT/app/build.sh"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

SURFACES="rail card card-evidence card-undo card-empty scene"

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable at $BIN"
/usr/libexec/PlistBuddy -c "Print :LSUIElement" "$ROOT/app/.build/Offload.app/Contents/Info.plist" | grep -qx true \
  || fail "LSUIElement is not true"

count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }

echo "== tests (S07)"
"$APP_BUILD" test --filter S07 > "$OUT/s07.txt" 2>&1 || { tail -40 "$OUT/s07.txt"; fail "S07 tests"; }
n07="$(count < "$OUT/s07.txt")"
echo "S07 tests passed: $n07"
[ "${n07:-0}" -ge 15 ] || fail "expected >= 15 S07 tests, got ${n07:-0}"

echo "== tests (all)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all tests passed: $nall"
[ "${nall:-0}" -ge 15 ] || fail "expected >= 15 tests, got ${nall:-0}"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
for s in $SURFACES; do
  for scheme in dark light; do
    f="$OUT/png/$s-$scheme.png"
    [ -s "$f" ] || fail "missing $f"
    w="$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')"
    [ "${w:-0}" -ge 200 ] || fail "$f is only ${w:-0}px wide"
  done
  echo "ok $s (dark + light)"
done

echo "== committed review set (app/snapshots, 1x)"
for s in components $SURFACES; do
  for scheme in dark light; do
    [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
  done
done
echo "ok 14 committed PNGs"
[ -s "$ROOT/slices/s07-rail-and-card/DESIGN-REVIEW.md" ] || fail "missing DESIGN-REVIEW.md"

echo "PASS s07-rail-and-card"
