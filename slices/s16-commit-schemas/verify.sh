#!/usr/bin/env bash
# s16 done-signal. Contract: slices/s16-commit-schemas/SPEC.md.
# 1. strict typecheck; 2. the s16 suite passes with >= MIN tests and every tag has passing tests; 3. the whole brain
# suite passes; 4. hermetic (no real composio); 5. every allowlisted Composio commit has a recorded live schema;
# 6. CONNECTORS.md has the schema table. Prints one "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
TESTS="$BRAIN/tests/s16-commit-schemas"
MIN_TESTS=60
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
[ -s "$ROOT/slices/s16-commit-schemas/SPEC.md" ] || fail "missing SPEC.md"
[ -d "$TESTS" ] || { fail "no $TESTS"; echo "s16 verify: $fails check(s) failed"; exit 1; }
unset OFFLOAD_COMPUTER_REAL OFFLOAD_S13_SMOKE

# 1. Typecheck.
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# 2. The s16 suite and its tags.
out="$(cd "$BRAIN" && bun test tests/s16-commit-schemas 2>&1)"
code=$?
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ $code -eq 0 ] && [ "${failed:-1}" = "0" ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s16 suite (${failed:-?} failing)"; }
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s16 tests ran, need at least $MIN_TESTS"
echo "s16 suite: ${ran:-0} tests"
for tag in POLICY SCHEMA DRAFT DENIED EXEC CATALOG; do
  grep -rqE "test(\.each\(.*\))?\(\"$tag: " "$TESTS" || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s16-commit-schemas -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

# 3. Whole brain suite.
all="$(cd "$BRAIN" && bun test 2>&1)"
af="$(echo "$all" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
ar="$(echo "$all" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${af:-1}" = "0" ] && echo "brain suite: ${ar:-0} tests pass" || { echo "$all" | grep -E "\(fail\)" | head -20; fail "brain suite (${af:-?} failing)"; }

# 4. Hermetic: no real runner, no real UI switch.
if grep -rnE "new SpawnLinkRunner|OFFLOAD_COMPUTER_REAL\s*[:=]|new Anthropic\(" "$TESTS" >/dev/null; then fail "an s16 test uses a real runner, the real UI switch or a real model client"; fi

# 5. Every allowlisted Composio commit has a recorded live schema; the meta-tool deny survives.
FIX="$TESTS/fixtures/composio-schemas.json"
[ -s "$FIX" ] || fail "no recorded schema fixture"
missing="$(cd "$BRAIN" && bun -e "
import { TOOL_POLICIES } from './src/workflows/allowlist.ts';
const fx = JSON.parse(await Bun.file('$FIX').text()).tools;
const m = TOOL_POLICIES.filter((p) => p.flavor === 'composio' && p.role !== 'read' && fx[p.tool] === undefined).map((p) => p.tool);
console.log(m.join(' '));
" 2>&1)"
[ -z "$missing" ] || fail "allowlisted Composio commits without a recorded schema: $missing"
grep -q "multi_?execute" "$BRAIN/src/workflows/allowlist.ts" || fail "allowlist lost the meta-tool deny"
grep -q "INSTANTLY_ACTIVATE_CAMPAIGN" "$BRAIN/src/workflows/allowlist.ts" && fail "INSTANTLY_ACTIVATE_CAMPAIGN must not be allowlisted"

# 6. Docs.
grep -q "## Commit schemas (s16)" "$BRAIN/CONNECTORS.md" || fail "CONNECTORS.md has no 'Commit schemas (s16)' section"
grep -q "CONFIRMED" "$BRAIN/CONNECTORS.md" && grep -q "UNKNOWN" "$BRAIN/CONNECTORS.md" || fail "CONNECTORS.md does not mark schema sources CONFIRMED/UNKNOWN"

if [ $fails -ne 0 ]; then echo "s16 verify: $fails check(s) failed"; exit 1; fi
echo "PASS s16-commit-schemas (${ran} s16 tests, ${ar} brain tests)"
