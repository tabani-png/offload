#!/usr/bin/env bash
# Runs every slices/*/verify.sh and prints a table: slice, result, seconds. Exit 0 only when all pass.
#   scripts/verify-all.sh [FILTER]     only slices whose folder name contains FILTER
#   scripts/verify-all.sh --list       the slices it would run
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$(mktemp -d)"
if [ "${1:-}" = "--list" ]; then
  for v in "$ROOT"/slices/*/verify.sh; do basename "$(dirname "$v")"; done
  exit 0
fi
filter="${1:-}"
rows=(); failed=0; total=0; bad=()
for v in "$ROOT"/slices/*/verify.sh; do
  slice="$(basename "$(dirname "$v")")"
  [ -n "$filter" ] && [[ "$slice" != *"$filter"* ]] && continue
  total=$((total + 1))
  printf '… %s\n' "$slice"
  t0=$(date +%s)
  if bash "$v" > "$LOGS/$slice.log" 2>&1; then res="PASS"; else res="FAIL"; failed=$((failed + 1)); bad+=("$slice"); fi
  rows+=("$(printf '%-28s %-5s %5ss' "$slice" "$res" "$(( $(date +%s) - t0 ))")")
done
echo
printf '%-28s %-5s %6s\n' "slice" "result" "time"
printf '%-28s %-5s %6s\n' "----------------------------" "-----" "------"
for r in "${rows[@]}"; do echo "$r"; done
echo
for slice in ${bad[@]+"${bad[@]}"}; do
  echo "--- $slice (last 15 lines; full log $LOGS/$slice.log)"
  tail -15 "$LOGS/$slice.log"
done
echo "$((total - failed))/$total slices pass (logs: $LOGS)"
[ "$failed" -eq 0 ]
