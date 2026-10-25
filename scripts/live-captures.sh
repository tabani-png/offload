#!/usr/bin/env bash
# s10e: every live capture in ONE run from ONE dataset: the demo home written by scripts/demo.sh --no-open
# (brain/fixtures/gen.ts, its tone pack and facts) with the real brain on the offline sample model. Order is the demo:
#   card and rail → review (drafting, dry run, steps editor) → confirm (blocked on a tool) → connect (waiting, connected;
#   the brain's demo sign-in, no browser, nothing sent) → confirm with Turn on enabled → turned on → dashboard pages
#   (overview dark and light, automations, this week, evidence pointer, row pointer, auto-send sheet, observing).
# Glass is the same demo card over our own white or near-black backdrop. Onboarding reads the real permissions.
# Captures OUR windows only (screencapture -o -l <window number>). Writes app/snapshots/live/*.png (live-set.txt).
#
#   scripts/live-captures.sh
# Needs an unlocked screen: screencapture cannot read windows while the session is locked.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app/.build/Offload.app"
LIVE="$ROOT/app/snapshots/live"
DEMO="$ROOT/scratch/demo"
mkdir -p "$LIVE"
WIN="$(mktemp -t offload-live-windows)"
QA="$(mktemp -t offload-live-qa)"

quit() {
  osascript -e 'tell application id "app.offload.Offload" to quit' >/dev/null 2>&1 || pkill -x Offload || true
  for _ in $(seq 1 20); do pgrep -x Offload >/dev/null 2>&1 || return 0; sleep 0.25; done
  pkill -9 -x Offload || true
}
fail() { echo "FAIL: $*" >&2; quit; exit 1; }

wait_for() {  # wait_for NAME SECONDS -> window number (NAME is an extended regex)
  local name="$1" secs="$2" i=0 n
  while [ "$i" -lt "$((secs * 4))" ]; do
    n="$(grep -E "^($name)=" "$WIN" | tail -1 | cut -d= -f2 || true)"
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

demo() {  # demo ENV... -- ARGS...: the app on the demo home with the real brain (stub model, raw key files)
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  launch OFFLOAD_KEYS=file OFFLOAD_REPO="$ROOT" OFFLOAD_DRYRUN_LIMIT=3 ${envs[@]+"${envs[@]}"} -- --home "$DEMO" --demo "$@"
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

if ioreg -n Root -d1 | grep -q '"CGSSessionScreenIsLocked"=Yes'; then fail "the screen is locked; unlock it and run again"; fi
"$ROOT/app/build.sh" >/dev/null

echo "== one dataset: seed the demo home"
quit
"$ROOT/scripts/demo.sh" --no-open >/dev/null

# 1. The demo, card to turned on. Keys are replayed one a second once the dry run is in.
# Two tools to connect (Gmail, then Google Sheets): ⌘↩ on the blocked confirm opens Connect, ⌘↩ starts the demo
# sign-in, the sheet comes back to the confirm by itself.
review_keys="scroll-dryrun,w,w,w,edit,w,w,escape,w,scroll-top,w,approvenow,w,w,approve,w,w,approve,w,w,w,w,w,w,w"
review_keys="$review_keys,approve,w,w,approve,w,w,w,w,w,w,w,confirm"
review_keys="$review_keys,w,w,w,w,w,w,w,w,dashboard"
demo OFFLOAD_DEMO_KEYS=w,w,w,1 OFFLOAD_REVIEW_KEYS="$review_keys" OFFLOAD_STUB_LINK_MS=2500 -- --open-card
card="$(wait_for card 90)" || fail "the card never opened (brain not up?)"
sleep 1.5
shot e2e-card "$card"
rail="$(wait_for rail 5)" && shot e2e-rail "$rail"
pgrep -f "cli.ts serve --home $DEMO" >/dev/null || fail "no real brain on the demo home"
review="$(wait_for review 40)" || fail "pressing 1 did not open the review"
sleep 0.6
shot e2e-review-drafting "$review"
wait_for review-dryrun 180 >/dev/null || fail "no dry run from the brain"
sleep 2.4
shot e2e-review-dryrun "$review"
wait_for review-skill 30 >/dev/null || fail "the steps editor never opened"
sleep 0.8
shot review-skill "$review"
wait_for review-confirm 40 >/dev/null || fail "the confirm sheet never opened"
sleep 0.6
shot e2e-review-confirm "$review"
wait_for review-connect-waiting 40 >/dev/null || fail "connect never started"
sleep 0.8
shot e2e-review-connect "$review"
wait_for review-connected 30 >/dev/null || fail "connect never finished"
sleep 0.5
shot e2e-review-connected "$review"
wait_for review-confirm-ready 30 >/dev/null || fail "the confirm sheet did not come back ready"
sleep 0.6
shot review-confirm "$review"
wait_for 'review-approved' 60 >/dev/null || { grep . "$WIN" >&2; fail "it never turned on"; }
sleep 0.8
shot e2e-review-approved "$review"
dash="$(wait_for dashboard 40)" || fail "the dashboard did not open"
sleep 2.5
shot e2e-dashboard "$dash"

# 2. The dashboard pages, same home, now with the automation on.
for section in automations week observing; do
  demo -- --open-dashboard --qa-dashboard-section "$section"
  n="$(wait_for dashboard 60)" || fail "dashboard ($section) never opened"
  sleep 3
  shot "dashboard-$section" "$n"
done
demo -- --open-dashboard --qa-appearance light
n="$(wait_for dashboard 60)" || fail "dashboard (light) never opened"
sleep 3
shot dashboard-light "$n"
demo -- --open-dashboard --qa-evidence
n="$(wait_for dashboard 60)" || fail "dashboard (evidence) never opened"
sleep 4.2
shot dashboard-evidence-pointer "$n"
demo -- --open-dashboard --qa-pointer --qa-dashboard-section automations
n="$(wait_for dashboard 60)" || fail "dashboard (pointer) never opened"
sleep 4.2
shot dashboard-pointer "$n"
demo -- --open-dashboard --qa-autosend
n="$(wait_for dashboard 60)" || fail "dashboard (auto-send) never opened"
sleep 3
shot dashboard-autosend "$n"

# 3. Glass: the same demo card over our own backdrop, both appearances, white and near-black.
for appearance in dark light; do
  for bg in white dark; do
    demo -- --qa-glass "$bg" --qa-appearance "$appearance"
    for _ in $(seq 1 120); do grep -q 'card=' "$QA" 2>/dev/null && break; sleep 0.25; done
    c="$(sed -n 's/.* card=\([0-9]*\).*/\1/p' "$QA")"
    [ -n "$c" ] || fail "no card window"
    sleep 2.5
    for i in 1 2 3 4 5; do
      screencapture -x -o -l "$c" "$LIVE/glass-$appearance-over-$bg.png" 2>/dev/null && break
      [ "$i" = 5 ] && fail "glass capture"
      sleep 1
    done
    echo "captured app/snapshots/live/glass-$appearance-over-$bg.png"
  done
done

# 4. Onboarding, the permissions step, with the real permission reads (no data shown).
launch -- --mock --onboarding --qa-onboarding-step 2
n="$(wait_for onboarding 20)" || fail "onboarding never opened"
sleep 1.2
shot onboarding-permissions-live "$n"

quit
sleep 2
if pgrep -f "cli.ts serve --home $DEMO" >/dev/null; then fail "the brain outlived the app"; fi
for s in $(cat "$ROOT/slices/s10e-ui-round4/live-set.txt"); do [ -s "$LIVE/$s.png" ] || fail "missing $s"; done
echo "PASS live captures (one run, one dataset: $DEMO)"
