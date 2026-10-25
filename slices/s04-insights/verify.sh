#!/usr/bin/env bash
# s04-insights done-signal. Contract: slices/s04-insights/SPEC.md.
# Runs the s04 test files (brain/tests/s04-*), requires at least MIN_TESTS tests with zero failures, then typechecks
# the whole brain package (strict), then runs the real fixture + CLI and checks the acceptance numbers. Prints one "FAIL ..." line per failing check; exits 0 only when all pass.
# Bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
SLICE=s04
MIN_TESTS=20
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
if [ ! -d "$BRAIN/node_modules/typescript" ]; then
  (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
fi

out="$(cd "$BRAIN" && bun test "tests/${SLICE}-" 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || fail "bun test exited $code"
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ -n "$ran" ] || { ran=0; fail "could not read the test count"; }
[ "${failed:-1}" = "0" ] || fail "${failed:-?} failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran tests ran for $SLICE, need at least $MIN_TESTS"

tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# Acceptance on the real CLI: generate the encrypted fixture week, analyze it, check #1 and the scheduling rank.
FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s04-XXXXXX")"
trap 'rm -rf "$FX"' EXIT
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$FX" --seed 42 --encrypted >/dev/null); then
  report="$(cd "$ROOT" && OFFLOAD_TOKEN= bun run brain/src/cli.ts analyze --home "$FX" --top 3 2>&1)" || fail "cli analyze exited non-zero"
  echo "$report" | grep -E "^#[0-9]|h/wk →" || true
  echo "$report" | grep -q "^#1 Outreach emails  \[email.outreach\]" || fail "insight #1 is not the outreach email task"
  echo "$report" | grep -q "\[email.scheduling\]" || fail "scheduling task not in the top 3"
  pct="$(echo "$report" | grep -m1 "h/wk →" | sed -n 's/.*(\([0-9][0-9]*\)%)$/\1/p')"
  share="$(echo "$report" | grep -m1 "share " | sed -n 's/^ *share \([0-9][0-9]*\)\..*/\1/p')"
  { [ -n "$pct" ] && [ "$pct" -ge 85 ] && [ "$pct" -le 92 ]; } || fail "insight #1 saving ${pct:-?}% outside 85-92%"
  { [ -n "$share" ] && [ "$share" -ge 60 ] && [ "$share" -le 69 ]; } || fail "insight #1 share ${share:-?}% outside 60-70%"
else
  fail "fixture generator failed"
fi

if [ $fails -ne 0 ]; then echo "$SLICE verify: $fails check(s) failed"; exit 1; fi
echo "$SLICE verify: PASS ($ran tests)"
