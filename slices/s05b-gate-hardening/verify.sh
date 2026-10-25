#!/usr/bin/env bash
# s05b-gate-hardening done-signal. Contract: slices/s05b-gate-hardening/SPEC.md.
# 1. all brain tests pass, at least MIN_TESTS; 2. strict typecheck; 3. every finding id in REVIEW-1.md has a test whose
# name starts with "<id>: " and those tests pass; 4. the real CLI on a fresh encrypted fixture: every side effect
# denied, no allow in the gate log, no OCR or mail text in plaintext under workflows/ or tone/.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
REVIEW="$ROOT/slices/s10-review/REVIEW-1.md"
MIN_TESTS=260
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
if [ ! -d "$BRAIN/node_modules/@anthropic-ai/claude-agent-sdk" ] || [ ! -d "$BRAIN/node_modules/typescript" ]; then
  (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
fi

# 1. All brain tests.
out="$(cd "$BRAIN" && bun test 2>&1)"
code=$?
echo "$out" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $code -eq 0 ] || { echo "$out" | grep -E "\(fail\)" | head -20; fail "bun test exited $code"; }
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ -n "$ran" ] || { ran=0; fail "could not read the test count"; }
[ "${failed:-1}" = "0" ] || fail "${failed:-?} failing tests"
[ "$ran" -ge "$MIN_TESTS" ] || fail "only $ran tests ran, need at least $MIN_TESTS"

# 2. Typecheck.
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)"
if [ $? -ne 0 ]; then echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; else echo "typecheck ok"; fi

# 3. Every REVIEW-1 finding id has a named, passing test.
[ -f "$REVIEW" ] || fail "missing $REVIEW"
ids="$(grep -oE '^### [BHML][0-9]+\.' "$REVIEW" | sed 's/^### //; s/\.$//' | sort -u)"
[ -n "$ids" ] || fail "no finding ids found in REVIEW-1.md"
n_ids=0
for id in $ids; do
  n_ids=$((n_ids + 1))
  if ! grep -rqE "test\(\"$id: " "$BRAIN"/tests/s05b-*; then fail "no test named \"$id: ...\" in brain/tests/s05b-*"; continue; fi
  t="$(cd "$BRAIN" && bun test tests/s05b-gate tests/s05b-runner tests/s05b-privacy tests/s05b-misc -t "$id: " 2>&1)"
  echo "$t" | grep -qE "^ *[1-9][0-9]* pass$" && echo "$t" | grep -qE "^ *0 fail$" || fail "tests for $id did not pass"
done
echo "finding tests present and passing for $n_ids ids: $(echo $ids | tr '\n' ' ')"

# 4. The real CLI on a fresh encrypted fixture (stub model: offline, deterministic).
FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s05b-XXXXXX")"
trap 'rm -rf "$FX"' EXIT
cli() { (cd "$ROOT" && OFFLOAD_TOKEN= OFFLOAD_OBSERVER_BIN="$FX/no-observer" bun run brain/src/cli.ts "$@" 2>&1); }
if (cd "$ROOT" && bun run brain/fixtures/gen.ts --out "$FX/home" --seed 42 --encrypted >/dev/null) && \
   (cd "$ROOT" && bun -e "import { FIXTURE_FACTS } from './brain/fixtures/sent-mail.ts'; await Bun.write('$FX/facts.md', FIXTURE_FACTS)"); then
  cli tone build --home "$FX/home" --source fixture --model stub >/dev/null || fail "tone build exited non-zero"
  draft="$(cli draft --insight 1 --home "$FX/home" --facts "$FX/facts.md")" || fail "draft exited non-zero"
  wf="$(echo "$draft" | sed -n 's/^drafted \(wf_[a-z0-9]*\):.*/\1/p')"
  [ -n "$wf" ] || fail "draft did not create a workflow"
  dry="$(cli dry-run --workflow "$wf" --home "$FX/home" --limit 3 --model stub)" || fail "dry-run exited non-zero"
  echo "$dry" | grep -E "side effects" | head -1
  echo "$dry" | grep -q "side effects 6/6 denied by the gate" || fail "dry run side effects were not all denied"
  echo "$dry" | grep -q "founder of Acme" || fail "dry run did not show the OCR excerpt"
  grep -q '"decision":"deny"' "$FX/home/workflows/$wf/gate-log.jsonl" || fail "gate log not written"
  if grep -q '"decision":"allow"' "$FX/home/workflows/$wf/gate-log.jsonl"; then fail "dry run allowed a side effect"; fi
  [ -f "$FX/home/workflows/$wf/dry-run.json.enc" ] || fail "sealed dry-run.json.enc missing"
  [ -f "$FX/home/workflows/$wf/dry-run.json" ] && fail "plaintext dry-run.json written"
  [ -f "$FX/home/tone/corpus.jsonl.enc" ] || fail "sealed tone corpus missing"
  if grep -rlq "founder of Acme" "$FX/home/workflows" "$FX/home/tone"; then fail "OCR excerpt in plaintext on disk: $(grep -rl 'founder of Acme' "$FX/home/workflows" "$FX/home/tone" | head -3)"; fi
  if grep -rlq "You backed Spotify early" "$FX/home/workflows" "$FX/home/tone"; then fail "sent mail text in plaintext on disk"; fi
  grep -q "IGNORE\|Replaces:" "$FX/home/workflows/$wf/SKILL.md" && fail "SKILL.md carries observed label text"
  echo "cli end to end: dry run sealed, nothing allowed, no plaintext OCR or mail text"
else
  fail "fixture generator failed"
fi

if [ $fails -ne 0 ]; then echo "s05b verify: $fails check(s) failed"; exit 1; fi
echo "s05b verify: PASS ($ran tests)"
