#!/usr/bin/env bash
# s10e done-signal (after DESIGN-REVIEW-3): the app builds; the S10E suite (>= 40) and every app test pass; the brain's
# s10e tests pass; the approval gate is byte-identical to the s10d commit; no NSAlert stands in for Connect; sheets are
# drawn in the window (no beginSheet); Surfaces/ has no literal sizes and no internal words in copy; a fresh 2x render
# has every s10d surface plus the s10e ones in dark and light; every committed and live PNG (s10e set included) exists
# and is newer than the newest app source file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/slices/s10e-ui-round4"
APP_BUILD="$ROOT/app/build.sh"
BASE=3fd90ab   # the s10d commit this round starts from
S10E_LAST=ddfe1f4   # the last s10e commit (s13 extends the gate after it: slices/s13-connector-chain/SPEC.md)
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }
mtime() { stat -f %m "$1"; }
# CI=true: a fresh checkout stamps every file with the checkout time, so PNG-vs-source mtimes mean nothing there;
# the mtime comparisons are skipped (existence and live-set membership still run). Unset CI: unchanged.
fresh() { [ "${CI:-}" = "true" ] || [ "$(mtime "$1")" -ge "$newest" ]; }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

for f in SPEC.md live-set.txt tests/S10ETests.swift; do [ -s "$HERE/$f" ] || fail "missing $f"; done

echo "== gate untouched by s10e ($BASE..$S10E_LAST)"
# The same guarantee as before s13: no s10e commit changed the gate. Later slices may extend it under their own tests.
git -C "$ROOT" diff --quiet "$BASE" "$S10E_LAST" -- brain/src/workflows/gate.ts brain/src/workflows/allowlist.ts \
  || fail "gate.ts or allowlist.ts changed within s10e ($BASE..$S10E_LAST)"
echo "ok gate.ts and allowlist.ts are byte-identical across s10e"

echo "== connect is a flow, not an alert"
if grep -rnE "(Connecting accounts|Signing in) from inside Offload is not ready yet|NSAlert.*Connect" "$ROOT/app/Sources" >/dev/null; then fail "the old connect alert is still in app/Sources"; fi
grep -q "struct ConnectSheet" "$ROOT/app/Sources/Surfaces/ConnectSheet.swift" || fail "no ConnectSheet"
grep -q "connectors/" "$ROOT/app/Sources/Core/HTTPBrainClient.swift" || fail "HTTPBrainClient has no connect link route"
if grep -n "beginSheet" "$ROOT/app/Sources/Surfaces/Windows.swift" >/dev/null; then fail "Windows.swift still uses beginSheet (sheets are in-window)"; fi
echo "ok ConnectSheet, link routes, in-window sheets"

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable at $BIN"

echo "== tests (S10E)"
"$APP_BUILD" test --filter S10E > "$OUT/s10e.txt" 2>&1 || { tail -60 "$OUT/s10e.txt"; fail "S10E tests"; }
n="$(count < "$OUT/s10e.txt")"
echo "S10E tests passed: $n"
[ "${n:-0}" -ge 40 ] || fail "expected >= 40 S10E tests, got ${n:-0}"

echo "== tests (all app suites)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "app test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all app tests passed: $nall"
[ "${nall:-0}" -ge 290 ] || fail "expected >= 290 app tests, got ${nall:-0}"

echo "== brain tests (s10e)"
[ -d "$ROOT/brain/tests/s10e-ui-round4" ] || fail "no brain/tests/s10e-ui-round4"
(cd "$ROOT/brain" && "$BUN" test tests/s10e-ui-round4) > "$OUT/brain.txt" 2>&1 || { tail -40 "$OUT/brain.txt"; fail "brain s10e tests"; }
grep -Eo '[0-9]+ pass' "$OUT/brain.txt" | tail -1 | sed 's/^/brain s10e: /'
if grep -Eq '[1-9][0-9]* fail' "$OUT/brain.txt"; then fail "brain s10e failures"; fi

echo "== tokens (Surfaces/ has no literal type size or padding)"
hits="$(grep -rnE '\.font\(\.system\(size:|\.padding\(\s*-?[0-9]|\.padding\(\.[a-zA-Z]+,\s*-?[0-9]|frame\((max|min)?[wW]idth: [0-9]{2,}' "$ROOT/app/Sources/Surfaces" || true)"
if [ -n "$hits" ]; then echo "$hits" >&2; fail "literal size or padding in Surfaces/ (use Tokens)"; fi
echo "ok no literal font size, padding or column width in Surfaces/"

echo "== plain words (string literals in Copy/Connect/Voice and Surfaces/)"
python3 - "$ROOT"/app/Sources/Core/Copy.swift "$ROOT"/app/Sources/Core/Connect.swift "$ROOT"/app/Sources/Core/Voice.swift \
  "$ROOT"/app/Sources/Surfaces/*.swift <<'PY' || fail "internal word in user-facing copy"
import re, sys
lit = re.compile(r'"((?:[^"\\]|\\.)*)"')
banned = re.compile(r'\b(key|keys|token|MCP|SKILL|gate|json|env)\b', re.I)
bad = []
for path in sys.argv[1:]:
    for n, line in enumerate(open(path), 1):
        if line.strip().startswith('//'):
            continue
        for m in lit.finditer(line):
            s = m.group(1)
            if re.fullmatch(r'[a-z0-9_.\\()\-]*', s):
                continue
            if banned.search(s):
                bad.append(f"{path.split('/app/')[-1]}:{n}: \"{s}\"")
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
echo "ok no internal words in copy"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
SURFACES="card card-evidence card-undo card-empty rail scene components review review-640 review-900 review-1280
  review-dryrun review-dryrun-sample review-confirm review-confirm-ready review-armed review-skill review-skill-source
  review-real-schedule dashboard dashboard-before dashboard-automations dashboard-observing dashboard-autosend
  dashboard-autosend-on dashboard-permissions timeline pointer pointer-row onboarding-watches onboarding-permissions
  onboarding-comeback review-connect review-connect-waiting review-connected review-connect-failed review-voice-edit timeline-before
  dashboard-automations-empty"
n=0
for s in $SURFACES; do
  for scheme in dark light; do
    [ -s "$OUT/png/$s-$scheme.png" ] || fail "missing fresh $s-$scheme.png"
    [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
    n=$((n + 1))
  done
done
echo "ok $n fresh PNGs and the committed set"

echo "== freshness (every PNG newer than the newest app source)"
newest=0
while IFS= read -r f; do t="$(mtime "$f")"; [ "$t" -gt "$newest" ] && newest="$t"; done \
  < <(find "$ROOT/app/Sources" -name '*.swift' -type f)
LIVE="$(tr '\n' ' ' < "$HERE/live-set.txt")"
stale=()
for s in $LIVE; do
  f="$ROOT/app/snapshots/live/$s.png"
  [ -s "$f" ] || fail "missing live capture app/snapshots/live/$s.png (run scripts/live-captures.sh)"
  fresh "$f" || stale+=("live/$s.png")
done
for f in "$ROOT"/app/snapshots/*.png; do fresh "$f" || stale+=("$(basename "$f")"); done
for f in "$ROOT"/app/snapshots/live/*.png; do
  b="$(basename "$f" .png)"; case " $LIVE " in *" $b "*) ;; *) stale+=("live/$b.png (not in the live set)");; esac
done
if [ "${#stale[@]}" -gt 0 ]; then printf '  %s\n' "${stale[@]}" >&2; fail "${#stale[@]} PNGs predate the newest source or are unknown"; fi
if [ "${CI:-}" = "true" ]; then
  echo "ok every committed and live PNG exists and is in the live set"
  echo "freshness (PNG mtime vs source): SKIPPED (needs a real screen; run locally)"
else
  echo "ok every committed and live PNG is newer than the source ($(date -r "$newest" '+%H:%M:%S'))"
fi

echo "== live set taken in one run"
if [ "${CI:-}" = "true" ]; then
  echo "live set span (capture mtimes): SKIPPED (needs a real screen; run locally)"
else
first=""; last=""
for s in $LIVE; do t="$(mtime "$ROOT/app/snapshots/live/$s.png")"; { [ -z "$first" ] || [ "$t" -lt "$first" ]; } && first="$t"; { [ -z "$last" ] || [ "$t" -gt "$last" ]; } && last="$t"; done
[ $((last - first)) -le 1800 ] || fail "live captures span $((last - first)) s: re-take them in one run (scripts/live-captures.sh)"
echo "ok live set spans $((last - first)) s"
fi
echo "PASS s10e-ui-round4"
