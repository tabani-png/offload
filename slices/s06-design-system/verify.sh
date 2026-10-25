#!/usr/bin/env bash
# s06 done-signal: the app builds, the S06 suites pass (>= 10 tests, whole run >= 15), and snapshot mode
# renders the component sheet in light and dark as real PNGs. Exit 0 = done.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BUILD="$ROOT/app/build.sh"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable at $BIN"
/usr/libexec/PlistBuddy -c "Print :LSUIElement" "$ROOT/app/.build/Offload.app/Contents/Info.plist" | grep -qx true \
  || fail "LSUIElement is not true"

count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }

echo "== tests (S06)"
"$APP_BUILD" test --filter S06 > "$OUT/s06.txt" 2>&1 || { tail -40 "$OUT/s06.txt"; fail "S06 tests"; }
n06="$(count < "$OUT/s06.txt")"
echo "S06 tests passed: $n06"
[ "${n06:-0}" -ge 10 ] || fail "expected >= 10 S06 tests, got ${n06:-0}"

echo "== tests (all)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all tests passed: $nall"
[ "${nall:-0}" -ge 15 ] || fail "expected >= 15 tests, got ${nall:-0}"

echo "== snapshot"
"$BIN" --snapshot "$OUT/png" | head -1
for scheme in dark light; do
  f="$OUT/png/components-$scheme.png"
  [ -s "$f" ] || fail "missing $f"
  w="$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')"
  [ "${w:-0}" -ge 400 ] || fail "$f is only ${w:-0}px wide"
  echo "ok components-$scheme.png (${w}px wide)"
done

echo "PASS s06-design-system"
