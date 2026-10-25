#!/usr/bin/env bash
# s17 done-signal. Contract: slices/s17-connect-anything/SPEC.md.
# 1. typecheck  2. s17 suite (>= MIN tests, every tag passing)  3. whole brain suite  4. hermetic tests
# 5. fixtures hold no secret  6. read-only guard  7. app tests (S17 suites)  8. snapshots  9. docs  10. smoke recorded.
# Prints one "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRAIN="$ROOT/brain"
TESTS="$BRAIN/tests/s17-connect-anything"
MIN_TESTS=70
export OFFLOAD_BUILD_DIR="${OFFLOAD_BUILD_DIR:-/tmp/offload-build-s17}"
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

command -v bun >/dev/null 2>&1 || { echo "FAIL bun not on PATH"; exit 1; }
[ -d "$BRAIN/node_modules/typescript" ] || (cd "$BRAIN" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
[ -s "$ROOT/slices/s17-connect-anything/SPEC.md" ] || fail "missing SPEC.md"
[ -d "$TESTS" ] || { fail "no $TESTS"; echo "s17 verify: $fails check(s) failed"; exit 1; }
unset OFFLOAD_COMPUTER_REAL OFFLOAD_S13_SMOKE OFFLOAD_S17_SMOKE

echo "== typecheck"
tsc_out="$(cd "$BRAIN" && bunx tsc --noEmit 2>&1)" && echo "typecheck ok" || { echo "$tsc_out" | head -20; fail "typecheck (bunx tsc --noEmit)"; }

echo "== s17 suite"
out="$(cd "$BRAIN" && bun test tests/s17-connect-anything 2>&1)"; code=$?
ran="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
[ $code -eq 0 ] && [ "${failed:-1}" = "0" ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "s17 suite (${failed:-?} failing)"; }
[ "${ran:-0}" -ge "$MIN_TESTS" ] || fail "only ${ran:-0} s17 tests ran, need at least $MIN_TESTS"
echo "s17 suite: ${ran:-0} tests"
for tag in UNIVERSE CLASSIFY POLICY REVIEW RECOMMEND RESOLVE EXEC CONNECTIONS SECRETS BUILD; do
  grep -rqE "test(\.each\(.*\))?\(\"$tag: " "$TESTS" || { fail "no test named \"$tag: ...\""; continue; }
  t="$(cd "$BRAIN" && bun test tests/s17-connect-anything -t "$tag: " 2>&1)"
  n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
  echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
done

echo "== whole brain suite"
all="$(cd "$BRAIN" && bun test 2>&1)"
af="$(echo "$all" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
ar="$(echo "$all" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
[ "${af:-1}" = "0" ] && echo "brain suite: ${ar:-0} tests pass" || { echo "$all" | grep -E "\(fail\)" | head -20; fail "brain suite (${af:-?} failing)"; }

echo "== hermetic"
if grep -rnE "new SpawnLinkRunner|OFFLOAD_COMPUTER_REAL\s*[:=]|new Anthropic\(|Bun\.spawn\(\[\"composio" "$TESTS" >/dev/null; then fail "an s17 test uses a real runner, the real UI switch, a real model client or the real composio"; fi

echo "== fixtures hold no secret"
if grep -rnE "sk-[A-Za-z0-9_-]{12,}|Bearer [A-Za-z0-9._-]{8,}|ghp_[A-Za-z0-9]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|ak_[A-Za-z0-9]{16,}" "$TESTS/fixtures" >/dev/null 2>&1; then fail "a fixture holds a secret-shaped string"; fi
for f in toolkits-list.json tools-linear.json tools-stripe.json schema-LINEAR_CREATE_LINEAR_ISSUE.json schema-STRIPE_CREATE_REFUND.json; do
  [ -s "$TESTS/fixtures/$f" ] || fail "missing recorded fixture $f"
done

echo "== read-only guard"
guard="$(cd "$BRAIN" && bun -e '
import { isReadOnlyComposioArgv } from "./src/connectors/composio.ts";
const yes = [["composio","dev","toolkits","list","--limit","1000"],["composio","dev","toolkits","list","--limit","1000","--query","e"],["composio","dev","toolkits","info","linear"],["composio","tools","list","linear","--limit","1000"],["composio","execute","LINEAR_CREATE_LINEAR_ISSUE","--get-schema"]];
const no = [["composio","execute","LINEAR_CREATE_LINEAR_ISSUE","-d","{}"],["composio","link","linear"],["composio","run","x"],["composio","proxy","https://x"],["composio","dev","playground-execute"],["composio","dev","toolkits","list","--connected","--user-id","x"],["composio","dev","auth-configs","create"]];
const bad = [...yes.filter((a) => !isReadOnlyComposioArgv(a)).map((a) => "refused " + a.join(" ")), ...no.filter((a) => isReadOnlyComposioArgv(a)).map((a) => "allowed " + a.join(" "))];
console.log(bad.join("; "));
' 2>&1)"
[ -z "$guard" ] && echo "guard ok" || fail "read-only guard: $guard"

echo "== app (S17 suites)"
aout="$("$ROOT/app/build.sh" test 2>&1)"; acode=$?
plain="$(printf '%s\n' "$aout" | sed $'s/\x1b\\[[0-9;]*m//g')"
printf '%s\n' "$plain" | grep -E 'Test run with' | tail -n 1 || true
[ $acode -eq 0 ] || { printf '%s\n' "$plain" | grep -E '✘|error:' | head -20; fail "app tests exited $acode"; }
s17="$(printf '%s\n' "$plain" | grep -cE '✔ Suite "S17 .*" passed' || true)"
[ "$s17" -ge 3 ] || fail "expected at least 3 S17 app suites to pass, got $s17"

echo "== snapshots"
FX="$(mktemp -d "${TMPDIR:-/tmp}/offload-s17-XXXXXX")"
trap 'rm -rf "$FX"' EXIT
BIN="$OFFLOAD_BUILD_DIR/Offload.app/Contents/MacOS/Offload"
"$ROOT/app/build.sh" >/dev/null 2>&1 || fail "app build failed"
if [ -x "$BIN" ]; then
  "$BIN" --snapshot "$FX/png" >/dev/null 2>&1 || true
  for s in connections connections-search connections-detail connections-key connections-server connections-built; do
    for scheme in dark light; do
      [ -s "$FX/png/$s-$scheme.png" ] || fail "missing fresh $s-$scheme.png"
      [ -s "$ROOT/app/snapshots/$s-$scheme.png" ] || fail "missing committed app/snapshots/$s-$scheme.png"
    done
  done
fi

echo "== docs"
grep -q "## Connect anything (s17)" "$BRAIN/CONNECTORS.md" || fail "CONNECTORS.md has no 'Connect anything (s17)' section"
grep -q "## Connections (s17)" "$BRAIN/API.md" || fail "API.md has no 'Connections (s17)' section"

echo "== smoke recorded"
grep -q "SMOKE_PENDING" "$ROOT/slices/s17-connect-anything/SPEC.md" && fail "SPEC.md smoke counts not recorded (SMOKE_PENDING)"

if [ $fails -ne 0 ]; then echo "s17 verify: $fails check(s) failed"; exit 1; fi
echo "PASS s17-connect-anything (${ran} s17 tests, ${ar} brain tests)"
