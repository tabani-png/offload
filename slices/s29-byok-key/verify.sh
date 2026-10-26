#!/usr/bin/env bash
# s29-byok-key done-signal. Contract: slices/s29-byok-key/SPEC.md.
# contract  swift (S29 tags + full app suite)  brain (s29 key test + full suite)  hygiene (no key sinks, no real key)
# check (--brain-check prints key: set|missing, never the key)  testers doc  scope.
# One "FAIL ..." line per failing check, every check runs. Bash 3.2 compatible. Cleans its temp folder.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/slices/s29-byok-key"
BRAIN="$ROOT/brain"
S="$ROOT/app/Sources"
BASE=0abc4e0   # origin/main when s29 started
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/offload-s29.XXXXXX")"
trap 'rm -rf "$T"' EXIT
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[ -x "$BUN" ] || { echo "FAIL bun not found"; exit 1; }

echo "== contract"
for f in SPEC.md verify.sh tests/S29Tests.swift tests/brain/keychain-key.test.ts; do [ -s "$HERE/$f" ] || fail "missing slices/s29-byok-key/$f"; done
grep -q "slices/s29-byok-key/tests" "$ROOT/app/build.sh" || fail "app/build.sh test does not compile slices/s29-byok-key/tests"

echo "== swift (app/build.sh test)"
st="$(OFFLOAD_BUILD_DIR="$T/testbuild" "$ROOT/app/build.sh" test 2>&1)"; scode=$?
echo "$st" | grep -E "Test run with [0-9]+ tests" | tail -1
[ $scode -eq 0 ] || { echo "$st" | grep -E "failed|error:" | head -20; fail "app/build.sh test exited $scode"; }
for tag in FORMAT VALIDATE FLOW SETTINGS LAUNCH ONBOARD CHECK CANCEL REPLACE OFFLINE; do
  n="$(echo "$st" | grep -cE "Test \"$tag: .*\" passed")"
  [ "$n" -gt 0 ] && echo "$tag: $n passing" || fail "no passing Swift test named \"$tag: ...\""
done
rm -rf "$T/testbuild"

echo "== brain"
[ -d "$BRAIN/node_modules/@anthropic-ai/sdk" ] || (cd "$BRAIN" && "$BUN" install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed"
out="$(cd "$BRAIN" && TMPDIR="$T" "$BUN" test "$HERE/tests/brain" 2>&1)"; code=$?
n="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
if [ $code -eq 0 ] && [ "${n:-0}" -ge 4 ]; then echo "BRAIN: $n passing"; else echo "$out" | grep -E "\(fail\)|error:" | head -10; fail "s29 brain key tests (exit $code, ${n:-0} passing)"; fi
if [ "${S29_SKIP_BRAIN_SUITE:-0}" = 1 ]; then echo "brain suite: skipped (S29_SKIP_BRAIN_SUITE=1)"; else
  full="$(cd "$BRAIN" && TMPDIR="$T" "$BUN" test 2>&1)"; fcode=$?
  echo "$full" | grep -E "^ *[0-9]+ (pass|fail)$|^Ran [0-9]+ tests" | tail -3
  [ $fcode -eq 0 ] || { echo "$full" | grep -E "\(fail\)" | head -10; fail "brain suite exited $fcode"; }
fi

echo "== hygiene (the key has no sink but the Keychain)"
for f in "$S/Core/ClaudeKey.swift" "$S/Surfaces/ClaudeKeychain.swift"; do
  [ -f "$f" ] || { fail "missing ${f#$ROOT/}"; continue; }
  sinks="$(grep -nE "NSLog|print\(|UserDefaults|\.write\(|FileManager|Process\(|executableURL|setenv|environment\[" "$f" | grep -vE "^[0-9]+:[[:space:]]*//")"
  [ -z "$sinks" ] || { echo "$sinks"; fail "${f#$ROOT/} has a log, file, defaults, env or subprocess sink"; }
done
grep -q "claudeKeyEnvironment" "$S/App/OffloadApp.swift" || fail "OffloadApp does not launch the brain through BrainLaunch.claudeKeyEnvironment"
grep -q "claudeKeyEnvironment" "$S/Core/BrainCheck.swift" || fail "--brain-check does not launch the brain through BrainLaunch.claudeKeyEnvironment"
grep -q "checkLine" "$S/Core/BrainCheck.swift" || fail "--brain-check does not print the key line"
grep -q "kSecAttrAccess\b\|kSecAttrAccess as" "$S/Surfaces/ClaudeKeychain.swift" 2>/dev/null || fail "the Keychain item has no access list (the brain's security read would prompt)"
# A real-looking key in anything this slice added (older slices keep their own sentinel strings; ours are built by
# concatenation and do not match).
added="$(git -C "$ROOT" diff "$BASE" HEAD -- app slices/s29-byok-key slices/s25-standalone-install 2>/dev/null | grep -E "^\+" || true)"
if echo "$added" | grep -nE "sk-ant-(api|admin|oat)[0-9]{2}-[A-Za-z0-9_-]{20,}"; then fail "a real-looking Anthropic key was added"; else echo "no real-looking key added"; fi

echo "== check (--brain-check prints key: set|missing)"
b="$(OFFLOAD_BUILD_DIR="$T/build" OFFLOAD_BUNDLE_BRAIN=0 "$ROOT/app/build.sh" 2>&1)" || { echo "$b" | tail -10; fail "app/build.sh exited non-zero"; }
if [ -x "$T/build/Offload.app/Contents/MacOS/Offload" ]; then
  co="$(cd "$T" && env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$T" OFFLOAD_REPO="$ROOT" OFFLOAD_BUN="$BUN" \
    "$T/build/Offload.app/Contents/MacOS/Offload" --brain-check --home "$T/home" 2>&1)"; ccode=$?
  echo "$co" | grep -E "^(brain status|key):" | sed "s|$T|\$T|g"
  echo "$co" | grep -qE "^key: (set|missing)$" || fail "--brain-check printed no 'key: set|missing' line"
  echo "$co" | grep -q "sk-ant-" && fail "--brain-check printed key material"
  [ $ccode -eq 0 ] || { echo "$co" | tail -8; fail "--brain-check exited $ccode"; }
fi
rm -rf "$T/build"

echo "== testers doc"
if [ -f "$ROOT/app/INSTALL-TESTERS.md" ]; then
  grep -q "console.anthropic.com" "$ROOT/app/INSTALL-TESTERS.md" || fail "app/INSTALL-TESTERS.md does not say where to get a Claude API key"
else echo "app/INSTALL-TESTERS.md not on this branch (noted in the report)"; fi

echo "== scope"
. "$ROOT/scripts/lib/slice-changes.sh"
slice_files --allow-skip "$BASE"; scope_rc=$?
case $scope_rc in
  0) while IFS= read -r p; do
       [ -n "$p" ] || continue
       case "$p" in brain/*|engine/*|control/*|web/*|schemas/*|packages/*) fail "out-of-scope path changed: $p" ;; esac
     done <<< "$SLICE_FILES"
     echo "scope checked ($(printf '%s\n' "$SLICE_FILES" | grep -c .) files)" ;;
  3) echo "scope: SKIPPED ($SLICE_ERROR)" ;;
  *) fail "scope check could not run: $SLICE_ERROR" ;;
esac

[ "$fails" -eq 0 ] && echo "s29-byok-key: PASS" || { echo "s29-byok-key: $fails failing check(s)"; exit 1; }
