#!/usr/bin/env bash
# Live captures that are not part of the s09a e2e (s10d): glass over our own white and near-black backdrops (dark
# and light card), the onboarding permissions step, the review's confirm sheet and steps editor, the dashboard's
# pages (overview, automations with the pointer, this week with the evidence pointer and the "now" marker,
# observing with the kept files, the auto-send sheet). Captures OUR windows only (screencapture -l <window number>,
# or a rect that lies on our own backdrop window). Writes app/snapshots/live/*.png.
#
#   scripts/live-captures.sh            mock data for review and glass; the real brain (stub model) on the demo week
#                                       for the dashboard pages, so the timeline, kept files and today row are live
#   scripts/live-captures.sh --only dashboard   only the dashboard captures (mock and real brain)
# Needs an unlocked screen: screencapture cannot read windows while the session is locked.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app/.build/Offload.app"
LIVE="$ROOT/app/snapshots/live"
mkdir -p "$LIVE"
WIN="$(mktemp -t offload-live-windows)"
QA="$(mktemp -t offload-live-qa)"

quit() {
  osascript -e 'tell application id "app.offload.Offload" to quit' >/dev/null 2>&1 || pkill -x Offload || true
  for _ in $(seq 1 20); do pgrep -x Offload >/dev/null 2>&1 || return 0; sleep 0.25; done
  pkill -9 -x Offload || true
}
fail() { echo "FAIL: $*" >&2; quit; exit 1; }

wait_for() {  # wait_for NAME SECONDS -> window number
  local name="$1" secs="$2" i=0 n
  while [ "$i" -lt "$((secs * 4))" ]; do
    n="$(grep -E "^$name=" "$WIN" | tail -1 | cut -d= -f2 || true)"
    [ -n "$n" ] && [ "$n" != "0" ] && { echo "$n"; return 0; }
    sleep 0.25; i=$((i + 1))
  done
  return 1
}

launch() {  # launch ENV... -- ARGS...
  local envs=()
  while [ "$1" != "--" ]; do envs+=(--env "$1"); shift; done
  shift
  quit
  : > "$WIN"; : > "$QA"
  open -n --env "OFFLOAD_QA_WINDOWS=$WIN" --env "OFFLOAD_QA_FILE=$QA" ${envs[@]+"${envs[@]}"} "$APP" --args --skip-onboarding "$@"
}

shot() {  # shot NAME WINDOW
  local i
  for i in 1 2 3 4; do
    screencapture -x -o -l "$2" "$LIVE/$1.png" 2>/dev/null && break
    [ "$i" = 4 ] && fail "capture $1"
    sleep 1
  done
  echo "captured app/snapshots/live/$1.png"
}

[ -x "$APP/Contents/MacOS/Offload" ] || "$ROOT/app/build.sh" >/dev/null
only="${2:-}"; [ "${1:-}" = "--only" ] || only=""
if ioreg -n Root -d1 | grep -q '"CGSSessionScreenIsLocked"=Yes'; then fail "the screen is locked; unlock it and run again"; fi

if [ "$only" != dashboard ]; then
# Glass: the card over our own backdrop, both appearances, white and near-black.
for appearance in dark light; do
  for bg in white dark; do
    launch -- --mock --qa-glass "$bg" --qa-appearance "$appearance"
    for _ in $(seq 1 40); do grep -q 'card=' "$QA" 2>/dev/null && break; sleep 0.25; done
    card="$(sed -n 's/.* card=\([0-9]*\).*/\1/p' "$QA")"
    [ -n "$card" ] || fail "no card window"
    sleep 0.8
    over="$([ "$bg" = white ] && echo white || echo dark)"
    # The card window alone: the window server composites it over our backdrop window, so the glass, its blur and
    # its shadow over white or near-black are in the image, and nothing of anyone else's screen is.
    for i in 1 2 3 4 5; do
      screencapture -x -l "$card" "$LIVE/glass-$appearance-over-$over.png" 2>/dev/null && break
      [ "$i" = 5 ] && fail "glass capture"
      sleep 1
    done
    echo "captured app/snapshots/live/glass-$appearance-over-$over.png"
  done
done

# Onboarding, the permissions step, with the real permission reads.
launch -- --mock --onboarding --qa-onboarding-step 2
n="$(wait_for onboarding 20)" || fail "onboarding never opened"
sleep 1.2
shot onboarding-permissions-live "$n"

# Review: the confirm sheet (blocked, Connect is the primary) and the steps editor.
launch OFFLOAD_REVIEW_KEYS=approve -- --mock --open-review
n="$(wait_for review 20)" || fail "review never opened"
sleep 4
shot review-confirm "$n"
launch OFFLOAD_REVIEW_KEYS=edit -- --mock --open-review
n="$(wait_for review 20)" || fail "review never opened"
sleep 4
shot review-skill "$n"

fi

# Dashboard on mock data: the row pointer (P) and the evidence pointer (2), held mid-label.
launch -- --mock --open-dashboard --qa-pointer
n="$(wait_for dashboard 20)" || fail "dashboard never opened"
sleep 4.2
shot dashboard-pointer "$n"
launch -- --mock --open-dashboard --qa-evidence
n="$(wait_for dashboard 20)" || fail "dashboard never opened"
sleep 4.2
shot dashboard-evidence-pointer "$n"
launch -- --mock --open-dashboard --qa-autosend
n="$(wait_for dashboard 20)" || fail "dashboard never opened"
sleep 3
shot dashboard-autosend "$n"
launch -- --mock --open-dashboard --qa-appearance light
n="$(wait_for dashboard 20)" || fail "dashboard never opened"
sleep 2
shot dashboard-light "$n"

# Dashboard pages on the real brain (stub model) and the demo week: the timeline has today's row and the now marker.
quit
OFFLOAD_QA_WINDOWS="$WIN" "$ROOT/scripts/demo.sh" --no-open >/dev/null
for section in week automations; do
  launch OFFLOAD_KEYS=file OFFLOAD_REPO="$ROOT" -- --home "$ROOT/scratch/demo" --demo --open-dashboard --qa-dashboard-section "$section"
  n="$(wait_for dashboard 60)" || fail "dashboard ($section) never opened"
  sleep 3
  shot "dashboard-$section" "$n"
done
# Observing with real kept files: build the workflow from the card first (the brain writes the recipient list and the
# facts), then open the dashboard from the review window.
launch OFFLOAD_KEYS=file OFFLOAD_REPO="$ROOT" OFFLOAD_DEMO_KEYS=w,w,1 OFFLOAD_REVIEW_KEYS=w,dashboard -- \
  --home "$ROOT/scratch/demo" --demo --open-card --qa-dashboard-section observing
n="$(wait_for dashboard 120)" || fail "dashboard (observing) never opened"
sleep 3
shot dashboard-observing "$n"
quit
sleep 2
if pgrep -f "cli.ts serve --home $ROOT/scratch/demo" >/dev/null; then fail "the brain outlived the app"; fi
echo "PASS live captures"
