#!/usr/bin/env bash
# s09a end-to-end, live: demo.sh (fixture week in scratch/demo, real brain launched by the app) → the card shows the
# outreach insight from the brain → 1 builds the workflow → the review window gets a real dry run from the brain
# (OFFLOAD_DRYRUN_LIMIT=1: at most one model call) → approve + confirm → the brain's answer (Gmail is not connected,
# nothing is sent) → dashboard. Captures OUR windows only (screencapture -l <our window number>) into
# app/snapshots/live/e2e-*.png, then quits the app and checks the brain child is gone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIVE="$ROOT/app/snapshots/live"
WIN="$(mktemp -t offload-e2e-windows)"
: > "$WIN"
mkdir -p "$LIVE"
fail() { echo "FAIL: $*" >&2; osascript -e 'tell application id "app.offload.Offload" to quit' >/dev/null 2>&1 || true; exit 1; }

wait_for() {  # wait_for NAME SECONDS → prints the window number
  local name="$1" secs="$2" i=0 n
  while [ "$i" -lt "$((secs * 4))" ]; do
    n="$(grep -E "^$name=" "$WIN" | tail -1 | cut -d= -f2 || true)"
    [ -n "$n" ] && [ "$n" != "0" ] && { echo "$n"; return 0; }
    sleep 0.25; i=$((i + 1))
  done
  return 1
}
shot() {  # shot NAME WINDOW
  screencapture -x -o -l "$2" "$LIVE/e2e-$1.png" || fail "capture $1"
  echo "captured app/snapshots/live/e2e-$1.png (window $2)"
}

export OFFLOAD_DRYRUN_LIMIT=1
export OFFLOAD_QA_WINDOWS="$WIN"
export OFFLOAD_DEMO_KEYS="w,w,w,1"
export OFFLOAD_REVIEW_KEYS="scroll-dryrun,w,w,approve,w,confirm,w,w,w,w,w,w,w,dashboard"
"$ROOT/scripts/demo.sh" -- --open-card

card="$(wait_for card 60)" || fail "the card never opened (brain not up?)"
sleep 1.2
shot card "$card"
rail="$(wait_for rail 5)" && shot rail "$rail"
pgrep -f "cli.ts serve --home $ROOT/scratch/demo" >/dev/null || fail "no real brain process on scratch/demo"
echo "ok real brain: $(pgrep -f "cli.ts serve --home $ROOT/scratch/demo" | head -1)"

review="$(wait_for review 30)" || fail "pressing 1 did not open the review window"
sleep 0.8
shot review-drafting "$review"
dry="$(wait_for review-dryrun 180)" || { tail -20 "$HOME/Library/Logs/Offload/brain.err.log" 2>/dev/null; fail "no dry run from the brain"; }
sleep 3.5
shot review-dryrun "$dry"
confirm="$(wait_for review-confirm 20)" && shot review-confirm "$confirm"
done_="$(wait_for 'review-(approved|message)' 30)" || fail "approval never answered"
sleep 1
shot review-approved "$done_"
dash="$(wait_for dashboard 30)" || fail "dashboard did not open"
sleep 2.5
shot dashboard "$dash"

wf="$(ls "$ROOT/scratch/demo/workflows" | head -1)"
[ -n "$wf" ] || fail "the brain wrote no workflow folder"
echo "ok workflow folder scratch/demo/workflows/$wf: $(ls "$ROOT/scratch/demo/workflows/$wf" | tr '\n' ' ')"
grep -c '"decision":"deny"' "$ROOT/scratch/demo/workflows/$wf/gate-log.jsonl" 2>/dev/null | sed 's/^/ok gate denials logged: /' || true

osascript -e 'tell application id "app.offload.Offload" to quit' >/dev/null 2>&1 || pkill -x Offload || true
sleep 3
if pgrep -f "cli.ts serve --home $ROOT/scratch/demo" >/dev/null; then fail "the brain outlived the app"; fi
echo "ok brain stopped with the app"
echo "PASS s09a e2e"
