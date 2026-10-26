#!/usr/bin/env bash
# s10f done-signal (after DESIGN-REVIEW-4): the app builds; the S10F suite (>= 30) and every app test pass; the brain's
# s14 tools test passes with the plain MCP wording; source greps for the view-only checks (focus ring, no disabled Turn
# on, seal caption, inline dots, no E-for-discard, neutral saving chips); a fresh 2x render has the s10f surfaces in dark
# and light and the committed set has them; locally, the live glass captures differ over white and dark (M7).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/slices/s10f-ui-round5"
APP_BUILD="$ROOT/app/build.sh"
S="$ROOT/app/Sources"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
count() { sed -E 's/\x1b\[[0-9;]*m//g' | grep -Eo 'Test run with [0-9]+ tests' | grep -Eo '[0-9]+' | head -1; }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

for f in SPEC.md tests/S10FTests.swift; do [ -s "$HERE/$f" ] || fail "missing $f"; done

echo "== build"
"$APP_BUILD" >/dev/null || fail "app build"
BIN="$ROOT/app/.build/Offload.app/Contents/MacOS/Offload"
[ -x "$BIN" ] || fail "no executable"

echo "== tests (S10F)"
"$APP_BUILD" test --filter S10F > "$OUT/s10f.txt" 2>&1 || { tail -60 "$OUT/s10f.txt"; fail "S10F tests"; }
n="$(count < "$OUT/s10f.txt")"
echo "S10F tests passed: $n"
[ "${n:-0}" -ge 30 ] || fail "expected >= 30 S10F tests, got ${n:-0}"

echo "== tests (all app suites)"
"$ROOT/app/.build/offload-tests" > "$OUT/all.txt" 2>&1 || { tail -40 "$OUT/all.txt"; fail "app test suite"; }
nall="$(count < "$OUT/all.txt")"
echo "all app tests passed: $nall"
[ "${nall:-0}" -ge 400 ] || fail "expected >= 400 app tests, got ${nall:-0}"

echo "== brain (M2: no MCP jargon in a suggestion)"
if grep -n 'Connect its MCP server' "$ROOT/brain/src/plan/tools.ts" >/dev/null; then fail "tools.ts still says Connect its MCP server"; fi
(cd "$ROOT/brain" && "$BUN" test tests/s14-any-task-workflows/tools.test.ts) > "$OUT/brain.txt" 2>&1 || { tail -30 "$OUT/brain.txt"; fail "brain s14 tools test"; }
echo "ok brain suggestion wording"

echo "== view checks"
if grep -n 'strokeBorder(focused ? p.status(.working)' "$S/Surfaces/PlanViews.swift" >/dev/null; then fail "M2: tool focus is still the blue working colour"; fi
grep -q 'p.focusRing' "$S/Surfaces/PlanViews.swift" || fail "M2: no white focus ring on tool options"
grep -q 'copy.recommended' "$S/Surfaces/PlanViews.swift" || fail "M2: the sparkle line still repeats the suggestion"
if awk '/struct ConfirmSheet/,/^}/' "$S/Surfaces/ReviewView.swift" | grep -n 'disabled(true)' >/dev/null; then fail "M5: a disabled Turn on is still drawn"; fi
grep -q 'sampleHeader' "$S/Surfaces/ReviewView.swift" || fail "M3: no sample header on the draft cards"
grep -q 'SentenceDiff' "$S/Surfaces/ReviewView.swift" || fail "M3: the card does not count by sentence"
grep -q 'title(compact: compact)' "$S/Surfaces/ReviewView.swift" || fail "M8: the footer has no compact primary"
if grep -n 'Chip(text: ConnectionsCopy.verifiedChip' "$S/Surfaces/ConnectionsView.swift" >/dev/null; then fail "M4: Checked by Offload is still a pill"; fi
grep -q 'checkmark.seal' "$S/Surfaces/ConnectionsView.swift" || fail "M4: no seal caption"
grep -q 'AppTile' "$S/Surfaces/ConnectionsView.swift" || fail "M4: no app tiles"
grep -q 'lineLimit(2)' "$S/Surfaces/ConnectionsView.swift" || fail "M4: row subtitles do not wrap"
grep -q 'ConnectionsMatch.line' "$S/Surfaces/ConnectionsView.swift" || fail "M4: rows do not say why they matched"
grep -q 'DashboardSidebarLink' "$S/Surfaces/DashboardView.swift" || fail "M4: no Connections in the sidebar"
grep -q 'runConfirm' "$S/Surfaces/ConnectionsView.swift" || fail "MCP: no run confirm in the sheet"
if grep -n 'Chip(text: copy.saved, style: .positive)\|Chip(text: item.saved, style: .positive)' "$S/Surfaces" -r >/dev/null; then fail "P3: a dry-run saving chip is still green"; fi
if grep -n 'Text(r.source)' "$S/Surfaces/ReviewView.swift" >/dev/null; then fail "P1: the voice rows repeat their source"; fi
if grep -rniE '"E".*(discard|clear)|(discard|clear).*key: "E"' "$S/Surfaces" >/dev/null; then fail "P6: E is bound to discard or clear somewhere"; fi
if grep -rn 'Back to Turn on' "$S" >/dev/null; then fail "P13: Back to Turn on"; fi
echo "ok view checks"

echo "== snapshot (fresh render, 2x)"
"$BIN" --snapshot "$OUT/png" | head -1
for s in review-tools review-confirm review-640 review-dryrun-sample review-dryrun-general connections connections-search \
         connections-detail connections-run-confirm onboarding-watches pointer-row dashboard; do
  for scheme in dark light; do
    [ -s "$OUT/png/$s-$scheme.png" ] || fail "missing fresh $s-$scheme.png"
    [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
  done
done
echo "ok s10f surfaces rendered and committed"

echo "== M7 glass composites over the backdrop (live)"
if [ "${CI:-}" = "true" ]; then
  echo "glass md5 check: SKIPPED (needs a real screen; run scripts/live-captures.sh locally)"
else
  for appearance in dark light; do
    a="$ROOT/app/snapshots/live/glass-$appearance-over-white.png"; b="$ROOT/app/snapshots/live/glass-$appearance-over-dark.png"
    [ -s "$a" ] && [ -s "$b" ] || fail "missing live glass captures ($appearance)"
    [ "$(md5 -q "$a")" != "$(md5 -q "$b")" ] || fail "glass ($appearance) identical over white and dark: no backdrop shows"
    [ -s "$ROOT/app/snapshots/live/glass-$appearance-over-color.png" ] || fail "missing glass-$appearance-over-color.png"
  done
  echo "ok glass differs over white and dark in both appearances"
fi
echo "PASS s10f-ui-round5"
