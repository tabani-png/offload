#!/usr/bin/env bash
# s05-workflows done-signal. Contract: slices/s05-workflows/SPEC.md.
# 1. all brain tests (>= MIN_TESTS, 0 failures); 2. the gate tests are present by name; 3. strict typecheck;
# 4. the real CLI end to end on the encrypted fixture week with the stub model: tone build, draft, dry-run.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
MIN_TESTS=170
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
if [ ! -d "$BRAIN/node_modules/@anthropic-ai/claude-agent-sdk" ] || [ ! -d "$BRAIN/node_modules/typescript" ]; then
  (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
fi

out="$(cd "$BRAIN" && bun test 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)" | head -20; fail "bun test exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ -n "$ran" ] || { ran=0; fail "could not read the test count"; }
[ "${failed:-1}" = "0" ] || fail "${failed:-?} failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran tests ran, need at least $MIN_TESTS"

# The approval gate must be tested, by name, and those tests must have run and passed.
for name in "gate: send without approval is denied and logged" "gate: approval for batch A does not approve batch B" "runner: the token of batch A does not send batch B"; do
  grep -rqF "$name" "$BRAIN/tests/" || fail "missing gate test: $name"
  g="$(cd "$BRAIN" && bun test tests/s05-gate tests/s05-workflows -t "$name" 2>&1)"
  echo "$g" | grep -qE "^ *[1-9][0-9]* pass$" && echo "$g" | grep -qE "^ *0 fail$" || fail "gate test did not pass: $name"
done
echo "gate tests present and passing"

tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# End to end on the real CLI (stub model: offline, deterministic).
FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s05-XXXXXX")"
trap 'rm -rf "$FX"' EXIT
cli() { (cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_KEYS=file bun run brain/src/cli.ts "$@" 2>&1); }
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$FX/home" --seed 42 --encrypted >/dev/null) && \
   (cd "$ROOT" && bun -e "import { FIXTURE_FACTS } from './brain/fixtures/sent-mail.ts'; await Bun.write('$FX/facts.md', FIXTURE_FACTS)"); then
  tone="$(cli tone build --home "$FX/home" --source fixture --model stub)" || fail "tone build exited non-zero"
  echo "$tone" | head -5
  echo "$tone" | grep -q "investor_outreach: 18 emails" || fail "tone build did not bucket the outreach mail"
  draft="$(cli draft --insight 1 --home "$FX/home" --facts "$FX/facts.md")" || fail "draft exited non-zero"
  echo "$draft" | head -9
  echo "$draft" | grep -q "Investor outreach emails \[ready_for_review, auto-run off\]" || fail "draft did not produce the outreach workflow"
  wf="$(echo "$draft" | sed -n 's/^drafted \(wf_[a-z0-9]*\):.*/\1/p')"
  [ -n "$wf" ] && [ -f "$FX/home/workflows/$wf/SKILL.md" ] || fail "SKILL.md missing"
  dry="$(cli dry-run --workflow "$wf" --home "$FX/home" --limit 3 --model stub)" || fail "dry-run exited non-zero"
  echo "$dry" | head -24
  echo "$dry" | grep -q "side effects 6/6 denied by the gate" || fail "dry run side effects were not all denied"
  [ "$(echo "$dry" | grep -c -- '--- our draft')" -eq 3 ] || fail "dry run did not draft 3 instances"
  echo "$dry" | grep -qE "^total: you spent [0-9.]+ min on these 3" || fail "dry run totals missing"
  grep -q '"decision":"deny"' "$FX/home/workflows/$wf/gate-log.jsonl" || fail "gate log not written"
  if grep -q '"decision":"allow"' "$FX/home/workflows/$wf/gate-log.jsonl"; then fail "dry run allowed a side effect"; fi
else
  fail "fixture generator failed"
fi

if [ $fails -ne 0 ]; then echo "s05 verify: $fails check(s) failed"; exit 1; fi
echo "s05 verify: PASS ($ran tests)"
