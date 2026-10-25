#!/usr/bin/env bash
# s11-perception done-signal. Contract: slices/s11-perception/SPEC.md.
# 1. engine: full Swift suite passes, at least MIN_ENGINE tests, at least 5 S11 suites pass; s10c greps (no network,
#    no key values, no spawning) over engine/Sources.
# 2. brain: all tests pass (at least MIN_BRAIN), every C tag has passing tests, strict typecheck.
# 3. cross-language: a frame written by the Swift FrameStore is read back by the brain through the real
#    `offload-observer export-frame` and in process (file keys), byte-identical.
# 4. vision code never imports the Claude model and OllamaCaptioner is loopback-only (also unit-tested).
# 5. BENCH.md exists, names a default model, and tags its claims.
# Prints one "FAIL ..." line per failing check; exits 0 only when all pass. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
SLICE="$ROOT/slices/s11-perception"
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s11}"
MIN_ENGINE=180
MIN_BRAIN=470
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

# 1. Engine.
fixture="$(mktemp -d)"
out="$(S11_FIXTURE_HOME="$fixture" "$ROOT/engine/build.sh" test 2>&1)"; code=$?
plain="$(printf '%s\n' "$out" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E '✘|error:' | grep -v 'offload-observer \[' | head -n 40 || true
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true
[ $code -eq 0 ] || fail "engine tests exited $code"
ran="$(printf '%s\n' "$plain" | sed -n 's/.*Test run with \([0-9][0-9]*\) tests\{0,1\}.*/\1/p' | tail -n 1)"
[ "${ran:-0}" -ge "$MIN_ENGINE" ] || fail "engine: only ${ran:-0} tests ran, need $MIN_ENGINE"
s11="$(printf '%s\n' "$plain" | grep -cE '✔ Suite S11[A-Z]' || true)"
[ "$s11" -ge 5 ] || fail "engine: expected 5 S11 suites to pass, got $s11"
if grep -rnE 'URLSession|URLRequest|NSURLConnection|import Network\b|NWConnection|CFStream|CFSocket' "$ROOT/engine/Sources"; then fail "network code in engine/Sources"; fi
if grep -rnE '\.characters|charactersIgnoringModifiers|\.keyCode' "$ROOT/engine/Sources"; then fail "key value access in engine/Sources"; fi
if grep -rnE 'Process\(\)|NSTask|posix_spawn|\bsystem\(' "$ROOT/engine/Sources"; then fail "process spawning in engine/Sources"; fi

# 2. Brain.
command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
bout="$(cd "$BRAIN" && S11_FIXTURE_HOME="$fixture" OFFLOAD_OBSERVER_BIN="$OFFLOAD_BUILD_DIR/offload-observer" bun test 2>&1)"; bcode=$?
echo "$bout" | grep -E "^\s*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" || true
[ $bcode -eq 0 ] || { echo "$bout" | grep -E "\(fail\)" | head -20; fail "bun test exited $bcode"; }
bran="$(echo "$bout" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${bran:-0}" -ge "$MIN_BRAIN" ] || fail "brain: only ${bran:-0} tests ran, need $MIN_BRAIN"
for tag in C1 C2 C3 C4 C5 C6 C7 C8 C9 XL; do
  grep -rqE "\(\"$tag: " "$BRAIN"/tests/s11-perception || { fail "no test named \"$tag: ...\" in brain/tests/s11-perception"; continue; }
  t="$(cd "$BRAIN" && S11_FIXTURE_HOME="$fixture" OFFLOAD_OBSERVER_BIN="$OFFLOAD_BUILD_DIR/offload-observer" bun test tests/s11-perception -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" || { echo "$tsc_out" | head -20; fail "typecheck"; }

# 3. Cross-language fixture was produced and consumed (the XL tests skip without it).
[ -s "$fixture/fixture.json" ] || fail "engine did not write the cross-language fixture"
rm -rf "$fixture"

# 4. Images never reach Claude.
if grep -rnE "models/model|claude-agent-sdk|anthropic" "$BRAIN/src/vision"; then fail "brain/src/vision imports the Claude model"; fi

# 5. Bench.
[ -s "$SLICE/BENCH.md" ] || fail "no BENCH.md"
grep -q "CONFIRMED" "$SLICE/BENCH.md" 2>/dev/null && grep -q "INFERENCE" "$SLICE/BENCH.md" && grep -q "UNKNOWN" "$SLICE/BENCH.md" || fail "BENCH.md lacks CONFIRMED / INFERENCE / UNKNOWN tags"
grep -qi "default" "$SLICE/BENCH.md" 2>/dev/null || fail "BENCH.md does not name the default model"

if [ $fails -ne 0 ]; then echo "s11 verify: $fails check(s) failed"; exit 1; fi
echo "s11 verify: PASS (engine $ran tests, brain $bran tests)"
