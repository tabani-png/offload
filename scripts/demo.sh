#!/usr/bin/env bash
# Demo mode: build the engine and the app, write the 7-day fixture week (brain/fixtures/gen.ts) into scratch/demo
# (never the real home), and start Offload on it with the REAL brain (the app launches and supervises it).
#
#   scripts/demo.sh                 encrypted fixture with raw key files (OFFLOAD_KEYS=file mode)
#   scripts/demo.sh --plain         plain jsonl days instead
#   scripts/demo.sh --no-open       build and seed only
#   scripts/demo.sh -- ARGS…        extra app arguments (e.g. -- --open-card --onboarding)
#
# Env: OFFLOAD_DRYRUN_LIMIT (instances per dry run, each one model call; default 3). These are passed to the app
# when set: OFFLOAD_DEMO_KEYS, OFFLOAD_REVIEW_KEYS, OFFLOAD_QA_WINDOWS, OFFLOAD_QA_FILE.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$ROOT/scratch/demo"
REAL="${OFFLOAD_REAL_HOME:-$HOME/Library/Application Support/Offload}"
APP="$ROOT/app/.build/Offload.app"
plain=0; open_app=1; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plain) plain=1 ;;
    --no-open) open_app=0 ;;
    --) shift; extra=("$@"); break ;;
    *) echo "demo.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

case "$DEMO" in "$REAL"|"$REAL"/*) echo "demo.sh: refusing to seed the real home ($REAL)" >&2; exit 1 ;; esac
command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ] || { echo "demo.sh: bun not found (https://bun.sh)" >&2; exit 1; }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

echo "== build engine"
"$ROOT/engine/build.sh" >/dev/null
echo "== build app"
"$ROOT/app/build.sh"
[ -d "$ROOT/brain/node_modules" ] || (cd "$ROOT/brain" && "$BUN" install --frozen-lockfile >/dev/null)

start="$(date -v-7d +%Y-%m-%d)"
echo "== fixture week $start + 6 days -> $DEMO"
rm -rf "$DEMO"
if [ "$plain" = 1 ]; then
  "$BUN" run "$ROOT/brain/fixtures/gen.ts" --out "$DEMO" --start "$start"
else
  "$BUN" run "$ROOT/brain/fixtures/gen.ts" --out "$DEMO" --start "$start" --encrypted
fi
# s10e: "Your voice" is filled on the demo home: a tone pack from the fixture sent mail (stub model, raw demo keys,
# no model cost), and the fixture founder's facts as the default facts.md of new workflows.
echo "== tone pack from the fixture sent mail (stub model) + default facts"
OFFLOAD_KEYS=file "$BUN" run "$ROOT/brain/src/cli.ts" tone build --home "$DEMO" --source fixture --model stub >/dev/null
OFFLOAD_DEMO_FACTS_OUT="$DEMO/default-facts.md" "$BUN" -e "import { FIXTURE_FACTS } from '$ROOT/brain/fixtures/sent-mail.ts'; import { writeFileSync } from 'node:fs'; writeFileSync(process.env.OFFLOAD_DEMO_FACTS_OUT!, FIXTURE_FACTS, { mode: 0o600 });"
[ -s "$DEMO/default-facts.md" ] && [ -s "$DEMO/tone/investor_outreach.md" ] || { echo "demo.sh: tone pack or default facts missing" >&2; exit 1; }

[ "$open_app" = 1 ] || { echo "seeded; not opening (--no-open)"; exit 0; }

# One Offload at a time: quit a running copy first (it owns the hotkey and the rail).
if pgrep -x Offload >/dev/null 2>&1; then
  osascript -e 'tell application id "app.offload.Offload" to quit' >/dev/null 2>&1 || pkill -x Offload || true
  sleep 1
fi

envs=(--env "OFFLOAD_KEYS=file" --env "OFFLOAD_DRYRUN_LIMIT=${OFFLOAD_DRYRUN_LIMIT:-3}" --env "OFFLOAD_REPO=$ROOT")
for v in OFFLOAD_DEMO_KEYS OFFLOAD_REVIEW_KEYS OFFLOAD_QA_WINDOWS OFFLOAD_QA_FILE; do
  [ -n "${!v:-}" ] && envs+=(--env "$v=${!v}")
done
echo "== open Offload on the demo week (real brain)"
open -n "${envs[@]}" "$APP" --args --home "$DEMO" --demo --skip-onboarding ${extra[@]+"${extra[@]}"}
echo "Offload is running on $DEMO. Press ⌥Space for the card; brain log: ~/Library/Logs/Offload/brain.err.log"
