#!/usr/bin/env bash
# Real mode: build the engine and the app, start Offload on the real home with the real brain.
# The observer is installed as a LaunchAgent ONLY with --install-agent; otherwise this script never starts it.
#
#   scripts/run.sh                    app + brain on the real home (observer left as it is)
#   scripts/run.sh --install-agent    also write and load ~/Library/LaunchAgents/ai.offload.observer.plist
#   scripts/run.sh -- ARGS…           extra app arguments (e.g. -- --onboarding)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${OFFLOAD_HOME:-$HOME/Library/Application Support/Offload}"
APP="$ROOT/app/.build/Offload.app"
OBS="$ROOT/engine/.build/offload-observer"
install_agent=0; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --install-agent) install_agent=1 ;;
    --) shift; extra=("$@"); break ;;
    *) echo "run.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

echo "== build engine"
"$ROOT/engine/build.sh" >/dev/null
echo "== build app"
"$ROOT/app/build.sh"

if [ "$install_agent" = 1 ]; then
  echo "== observer LaunchAgent"
  "$OBS" install-agent --home "$HOME_DIR"
  plist="$HOME/Library/LaunchAgents/ai.offload.observer.plist"
  launchctl bootout "gui/$(id -u)/ai.offload.observer" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "loaded $plist (uninstall: $OBS uninstall-agent && launchctl bootout gui/$(id -u)/ai.offload.observer)"
else
  echo "== observer: not started (pass --install-agent to run it as a LaunchAgent)"
fi
"$OBS" status --json --home "$HOME_DIR" | sed -n '1,40p' | grep -E '"(running|paused|screenRecording|accessibility|inputMonitoring)"' || true

if pgrep -x Offload >/dev/null 2>&1; then
  osascript -e 'tell application id "app.offload.Offload" to quit' >/dev/null 2>&1 || pkill -x Offload || true
  sleep 1
fi
echo "== open Offload ($HOME_DIR)"
open -n --env "OFFLOAD_REPO=$ROOT" "$APP" --args --home "$HOME_DIR" ${extra[@]+"${extra[@]}"}
