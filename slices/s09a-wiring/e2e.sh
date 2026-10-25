#!/usr/bin/env bash
# s09a end-to-end, live. s10e: the e2e is part of the one-run live capture (scripts/live-captures.sh): demo home →
# card → build → dry run (offline sample model) → confirm → connect (demo sign-in, nothing sent) → turn on →
# dashboard, all captured from our own windows into app/snapshots/live/e2e-*.png, then the app and its brain quit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$ROOT/scripts/live-captures.sh"
