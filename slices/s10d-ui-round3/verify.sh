#!/usr/bin/env bash
# s10d done-signal: the app builds; every app test passes (>= 250, incl. the S10D suites); Surfaces/ has no literal
# type size or padding; no string a person reads in Copy.swift or Surfaces/ carries an internal word (key, token, MCP,
# SKILL, gate, json); a fresh 2x render has every surface in dark and light; the committed snapshots and every live
# capture exist and are newer than the newest app source file (so no PNG predates the code it shows).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BUILD="$ROOT/app/build.sh"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }
mtime() { stat -f %m "$1"; }
# CI=true: a fresh checkout stamps every file with the checkout time, so PNG-vs-source mtimes mean nothing there;
# the mtime comparisons are skipped (existence and live-set membership still run). Unset CI: unchanged.
fresh() { [ "${CI:-}" = "true" ] || [ "$(mtime "$1")" -ge "$newest" ]; }

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable at $BIN"

echo "== tests (S10D)"
"$APP_BUILD" test --filter S10D > "$OUT/s10d.txt" 2>&1 || { tail -40 "$OUT/s10d.txt"; fail "S10D tests"; }
n="$(count < "$OUT/s10d.txt")"
echo "S10D tests passed: $n"
[ "${n:-0}" -ge 30 ] || fail "expected >= 30 S10D tests, got ${n:-0}"

echo "== tests (all app suites)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "app test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all app tests passed: $nall"
[ "${nall:-0}" -ge 250 ] || fail "expected >= 250 app tests, got ${nall:-0}"

echo "== tokens (Surfaces/ has no literal type size or padding)"
hits="$(grep -rnE '\.font\(\.system\(size:|\.padding\(\s*-?[0-9]|\.padding\(\.[a-zA-Z]+,\s*-?[0-9]|frame\((max|min)?[wW]idth: [0-9]{2,}' "$ROOT/app/Sources/Surfaces" || true)"
if [ -n "$hits" ]; then echo "$hits" >&2; fail "literal size or padding in Surfaces/ (use Tokens)"; fi
echo "ok no literal font size, padding or column width in Surfaces/"

echo "== plain words (string literals in Copy.swift and Surfaces/)"
python3 - "$ROOT/app/Sources/Core/Copy.swift" "$ROOT"/app/Sources/Surfaces/*.swift <<'PY' || fail "internal word in user-facing copy"
import re, sys
lit = re.compile(r'"((?:[^"\\]|\\.)*)"')
banned = re.compile(r'\b(key|keys|token|MCP|SKILL|gate|json)\b', re.I)
bad = []
for path in sys.argv[1:]:
    for n, line in enumerate(open(path), 1):
        if line.strip().startswith('//') or line.strip().startswith('///'):
            continue
        for m in lit.finditer(line):
            s = m.group(1)
            # Identifiers and keys that are never shown: anchor ids, keycap glyphs, symbol names.
            if re.fullmatch(r'[a-z0-9_.\\()\-]*', s):
                continue
            if banned.search(s):
                bad.append(f"{path.split('/app/')[-1]}:{n}: \"{s}\"")
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
echo "ok no key/token/MCP/SKILL/gate/json in copy"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
SURFACES="card card-evidence card-undo card-empty rail scene components review review-640 review-900 review-1280
  review-dryrun review-dryrun-sample review-confirm review-confirm-ready review-armed review-skill review-skill-source
  review-real-schedule dashboard dashboard-before dashboard-automations dashboard-observing dashboard-autosend
  dashboard-autosend-on dashboard-permissions timeline pointer pointer-row onboarding-watches onboarding-permissions
  onboarding-comeback"
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
LIVE="e2e-card e2e-rail e2e-review-drafting e2e-review-dryrun e2e-review-confirm e2e-review-approved e2e-dashboard
  glass-dark-over-white glass-dark-over-dark glass-light-over-white glass-light-over-dark onboarding-permissions-live
  review-confirm review-skill dashboard-pointer dashboard-evidence-pointer dashboard-autosend dashboard-light
  dashboard-week dashboard-automations dashboard-observing"
# s10e: later rounds add live captures; their names are listed in that slice's live-set.txt.
[ -s "$ROOT/slices/s10e-ui-round4/live-set.txt" ] && LIVE="$LIVE $(tr '\n' ' ' < "$ROOT/slices/s10e-ui-round4/live-set.txt")"
stale=()
for s in $LIVE; do
  f="$ROOT/app/snapshots/live/$s.png"
  [ -s "$f" ] || fail "missing live capture app/snapshots/live/$s.png (run scripts/live-captures.sh and E2E=1 slices/s09a-wiring/verify.sh)"
  fresh "$f" || stale+=("live/$s.png")
done
for f in "$ROOT"/app/snapshots/*.png; do fresh "$f" || stale+=("$(basename "$f")"); done
for f in "$ROOT"/app/snapshots/live/*.png; do
  b="$(basename "$f" .png)"; case " $(echo $LIVE) " in *" $b "*) ;; *) stale+=("live/$b.png (not in the live set)");; esac
done
if [ "${#stale[@]}" -gt 0 ]; then printf '  %s\n' "${stale[@]}" >&2; fail "${#stale[@]} PNGs predate the newest source or are unknown"; fi
if [ "${CI:-}" = "true" ]; then
  echo "ok every committed and live PNG exists and is in the live set"
  echo "freshness (PNG mtime vs source): SKIPPED (needs a real screen; run locally)"
else
  echo "ok every committed and live PNG is newer than the source ($(date -r "$newest" '+%H:%M:%S'))"
fi

for f in SPEC.md; do [ -s "$ROOT/slices/s10d-ui-round3/$f" ] || fail "missing $f"; done
echo "PASS s10d-ui-round3"
