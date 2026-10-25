#!/usr/bin/env bash
# s13 done-signal. Contract: slices/s13-connector-chain/SPEC.md.
# 1. strict typecheck; 2. the s13 suite passes with >= MIN tests and every tag has passing tests; 3. the whole brain
# suite passes; 4. no s13 test runs the real Composio CLI, the real UI or a real model; 5. docs describe the chain.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
TESTS="$BRAIN/tests/s13-connector-chain"
MIN_TESTS=80
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
[ -s "$ROOT/slices/s13-connector-chain/SPEC.md" ] || fail "missing SPEC.md"
[ -d "$TESTS" ] || { fail "no $TESTS"; echo "s13 verify: $fails check(s) failed"; exit 1; }

# The real-mode switches must never be set by the suite (opt-in smoke only).
unset OFFLOAD_COMPUTER_REAL OFFLOAD_S13_SMOKE

# 1. Typecheck.
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# 2. The s13 suite and its tags.
out="$(cd "$BRAIN" && bun test tests/s13-connector-chain 2>&1)"
code=$?
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ $code -eq 0 ] && [ "${failed:-1}" = "0" ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s13 suite (${failed:-?} failing)"; }
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s13 tests ran, need at least $MIN_TESTS"
echo "s13 suite: ${ran:-0} tests"
for tag in CHAIN MCP COMPOSIO API COMPUTER GATE FALLBACK ROUTES; do
  grep -rqE "test\(\"$tag: " "$TESTS" || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s13-connector-chain -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

# 3. Whole brain suite.
all="$(cd "$BRAIN" && bun test 2>&1)"
af="$(echo "$all" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
ar="$(echo "$all" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${af:-1}" = "0" ] && echo "brain suite: ${ar:-0} tests pass" || { echo "$all" | grep -E "\(fail\)" | head -20; fail "brain suite (${af:-?} failing)"; }

# 4. Hermetic: no s13 test spawns the real composio, sets the real-UI switch, or calls a real model client.
if grep -rnE "new SpawnLinkRunner|OFFLOAD_COMPUTER_REAL\s*[:=]|new Anthropic\(" "$TESTS" | grep -v "^.*// allowed:" >/dev/null; then
  grep -rnE "new SpawnLinkRunner|OFFLOAD_COMPUTER_REAL\s*[:=]|new Anthropic\(" "$TESTS" >&2
  fail "an s13 test uses a real runner, the real UI switch or a real model client"
fi
grep -q "OFFLOAD_S13_SMOKE" "$TESTS/smoke.test.ts" 2>/dev/null || fail "the Composio smoke test must be gated by OFFLOAD_S13_SMOKE"

# Gate invariants that must survive the extension.
grep -q "multi_?execute" "$BRAIN/src/workflows/allowlist.ts" || fail "allowlist lost the meta-tool deny"
grep -q "computer_toolset_20260801" "$BRAIN/src/connectors/computer/claude.ts" 2>/dev/null || fail "computer use does not declare computer_toolset_20260801"

# 5. Docs.
grep -q "Resolution chain" "$BRAIN/CONNECTORS.md" || fail "CONNECTORS.md has no 'Resolution chain' section"
grep -q "ConnectorChainDTO" "$BRAIN/API.md" || fail "API.md does not document ConnectorChainDTO"
[ -s "$ROOT/plan/adr/0008-anthropic-sdk-computer-use.md" ] || fail "no ADR 0008 for the new dependency"

if [ $fails -ne 0 ]; then echo "s13 verify: $fails check(s) failed"; exit 1; fi
echo "PASS s13-connector-chain (${ran} s13 tests, ${ar} brain tests)"
