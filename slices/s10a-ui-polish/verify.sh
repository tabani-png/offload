#!/usr/bin/env bash
# s10a done-signal: the app builds; every app test passes (>= 200, incl. the S10A cross-screen copy test); Surfaces/
# has no literal font size or padding (type ramp and 4-pt spacing come from Tokens); a fresh 2x render has every
# s10a surface in dark and light (review at 640, 900 and 1280 wide); the committed set and the live e2e captures exist.
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

echo "== tests (S10A)"
"$APP_BUILD" test --filter S10A > "$OUT/s10a.txt" 2>&1 || { tail -40 "$OUT/s10a.txt"; fail "S10A tests"; }
echo "S10A tests passed: $(count < "$OUT/s10a.txt")"

echo "== tests (all app suites)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "app test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all app tests passed: $nall"
[ "${nall:-0}" -ge 200 ] || fail "expected >= 200 app tests, got ${nall:-0}"

echo "== tokens (Surfaces/ has no literal type size or padding)"
hits="$(grep -rnE '\.font\(\.system\(size:|\.padding\(\s*-?[0-9]|\.padding\(\.[a-zA-Z]+,\s*-?[0-9]' "$ROOT/app/Sources/Surfaces" || true)"
if [ -n "$hits" ]; then echo "$hits" >&2; fail "literal font size or padding in Surfaces/ (use Tokens.TypeScale / Tokens.Space)"; fi
echo "ok no literal .font(.system(size:) or .padding(<number>) in Surfaces/"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
SURFACES="card card-evidence card-undo card-empty rail scene components review review-640 review-900 review-1280
  review-dryrun review-dryrun-sample review-confirm review-confirm-ready review-armed review-skill review-skill-source
  review-real-schedule dashboard dashboard-before dashboard-permissions timeline pointer pointer-row
  onboarding-watches onboarding-permissions onboarding-comeback"
n=0
for s in $SURFACES; do
  for scheme in dark light; do
    f="$OUT/png/$s-$scheme.png"
    [ -s "$f" ] || fail "missing $f"
    [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
    n=$((n + 1))
  done
done
for w in 640 900 1280; do
  px="$(sips -g pixelWidth "$OUT/png/review-$w-dark.png" | awk '/pixelWidth/ {print $2}')"
  # window width + 2 x 32 backdrop, at 2x
  [ "$px" -eq $(( (w + 64) * 2 )) ] || fail "review-$w is ${px}px wide, expected $(( (w + 64) * 2 ))"
done
echo "ok $n fresh PNGs, committed set present, review rendered at 640/900/1280"

echo "== live e2e captures"
for s in card review-drafting review-dryrun review-confirm review-approved dashboard; do
  [ -s "$ROOT/app/snapshots/live/e2e-$s.png" ] || fail "missing app/snapshots/live/e2e-$s.png (run E2E=1 slices/s09a-wiring/verify.sh)"
done
for f in SPEC.md DESIGN-REVIEW.md; do [ -s "$ROOT/slices/s10a-ui-polish/$f" ] || fail "missing $f"; done
echo "PASS s10a-ui-polish"
