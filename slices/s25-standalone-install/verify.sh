#!/usr/bin/env bash
# s25-standalone-install done-signal. Contract: slices/s25-standalone-install/SPEC.md.
# 1. ADR   2. Swift suite (S25 tags)   3. build the app outside the repo   4. LAYOUT   5. GRAPH
# 6. PROOF (copy outside the repo, read-only, env -i, no bun on PATH, no OFFLOAD_REPO, HOME temp)
# 7. HARDENED (re-sign the copy with the hardened runtime, ad hoc, run PROOF again)   8. NOTARY gate   9. scope
# One "FAIL ..." line per failing check. Bash 3.2 compatible. Cleans its temp folder (the build is ~400 MB of clones).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE=1298f15   # origin/main when s25 started
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
T="$(mktemp -d /tmp/offload-s25.XXXXXX)"
cleanup() { chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
STRIPPED_PATH=/usr/bin:/bin:/usr/sbin:/sbin

echo "== ADR"
ls "$ROOT"/plan/adr/0013-*.md >/dev/null 2>&1 && echo "ADR 0013 present" || fail "no plan/adr/0013-*.md"

echo "== Swift suite (app/build.sh test)"
st="$(OFFLOAD_BUILD_DIR="$T/testbuild" "$ROOT/app/build.sh" test 2>&1)"; scode=$?
echo "$st" | grep -E "Test run with [0-9]+ tests" | tail -1
[ $scode -eq 0 ] || { echo "$st" | grep -E "failed|error:" | head -20; fail "app/build.sh test exited $scode"; }
for tag in BUNDLED FALLBACK STANDALONE SPEC CHECK; do
  n="$(echo "$st" | grep -cE "Test \"$tag: .*\" passed")"
  [ "$n" -gt 0 ] && echo "$tag: $n passing" || fail "no passing Swift test named \"$tag: ...\""
done
rm -rf "$T/testbuild"

echo "== build (outside the repo)"
b="$(OFFLOAD_BUILD_DIR="$T/build" "$ROOT/app/build.sh" 2>&1)" || { echo "$b" | tail -20; fail "app/build.sh exited non-zero"; }
APP="$T/build/Offload.app"
[ -d "$APP" ] || { fail "no Offload.app built"; echo "s25-standalone-install: $fails failing check(s)"; exit 1; }

echo "== LAYOUT"
H="$APP/Contents/Helpers"; R="$APP/Contents/Resources/offload"
pinned="$(sed -n 's/^PINNED_BUN=\([0-9.]*\).*/\1/p' "$ROOT/app/build.sh" | head -1)"
[ -n "$pinned" ] || fail "build.sh has no PINNED_BUN"
[ -x "$H/bun" ] && [ "$("$H/bun" --version 2>/dev/null)" = "$pinned" ] && echo "bun $pinned bundled" || fail "Contents/Helpers/bun missing or not bun $pinned"
[ -f "$R/brain/src/cli.ts" ] || fail "no Resources/offload/brain/src/cli.ts"
[ -f "$R/brain/package.json" ] || fail "no brain/package.json in the bundle"
[ -d "$R/schemas" ] || fail "no schemas/ in the bundle"
[ -d "$R/brain/tests" ] && fail "brain tests were bundled"
for d in typescript @types bun-types; do [ -e "$R/brain/node_modules/$d" ] && fail "devDependency $d bundled"; done
for d in @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @modelcontextprotocol/sdk; do
  [ -d "$R/brain/node_modules/$d" ] || fail "dependency $d missing from the bundle"
done
[ -x "$H/claude" ] || fail "no Contents/Helpers/claude"
sdkbin="$R/brain/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$(uname -m | sed 's/x86_64/x64/')/claude"
[ -x "$sdkbin" ] || fail "the SDK's claude path does not resolve to an executable"
[ -L "$sdkbin" ] || fail "the SDK's claude binary is a copy, not a link to Helpers/claude"
appreal="$(cd "$APP" && pwd -P)"
outside=0
while IFS= read -r l; do
  tgt="$(cd "$(dirname "$l")" && cd "$(dirname "$(readlink "$l")")" 2>/dev/null && pwd -P)"
  case "$tgt" in "$appreal"|"$appreal"/*) ;; *) echo "  link outside the bundle: $l -> $(readlink "$l")"; outside=1 ;; esac
done < <(find "$APP" -type l)
[ $outside -eq 0 ] && echo "no symlink leaves the bundle" || fail "symlinks point outside the bundle"
codesign --verify --strict --deep "$APP" 2>&1 | head -5
codesign --verify --strict --deep "$APP" >/dev/null 2>&1 && echo "codesign verify ok (ad hoc)" || fail "codesign --verify --strict --deep failed on the ad hoc build"

echo "== copy outside the repo"
I="$T/install"; mkdir -p "$I" "$T/home" "$T/tmp"
cp -cR "$APP" "$I/" 2>/dev/null || cp -R "$APP" "$I/"
C="$I/Offload.app"
case "$C" in "$ROOT"/*) fail "the copy is inside the repo" ;; esac
rm -rf "$T/build"

echo "== GRAPH (the bundled bun resolves every import from inside the copy)"
g="$(cd "$T" && env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" "$C/Contents/Helpers/bun" build \
  "$C/Contents/Resources/offload/brain/src/cli.ts" --target=bun --outdir "$T/graph" 2>&1)" \
  && echo "import graph resolves" || { echo "$g" | grep -iE "error|could not resolve" | head -10; fail "the bundled import graph does not resolve"; }
rm -rf "$T/graph"

echo "== SDKBIN (the Agent SDK's claude package path resolves to Helpers/claude inside the copy, and it runs)"
arch="$(uname -m | sed 's/x86_64/x64/')"
r="$(cd "$C/Contents/Resources/offload/brain" && env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" \
  "$C/Contents/Helpers/bun" -e "console.log(require('fs').realpathSync(require.resolve('@anthropic-ai/claude-agent-sdk-darwin-$arch/claude')))" 2>&1)"
creal="$(cd "$C/Contents/Helpers" && pwd -P)/claude"
[ "$r" = "$creal" ] && echo "SDK claude -> Helpers/claude" || fail "SDK claude resolves to '$r', not $creal"
cv="$(env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" "$C/Contents/Helpers/claude" --version 2>&1)" \
  && echo "claude $cv" || fail "Helpers/claude --version failed: $cv"

proof() {  # $1 label
  local out code
  env -i PATH="$STRIPPED_PATH" sh -c 'command -v bun' >/dev/null 2>&1 && fail "$1: bun is on the stripped PATH"
  out="$(cd "$T" && env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" \
    "$C/Contents/MacOS/Offload" --brain-check --home "$T/home/offload" 2>&1)"; code=$?
  echo "$out" | grep -E "^brain (source|status)" | sed "s|$T|\$T|g"
  echo "$out" | grep -qF "brain source: bundled $C/Contents/Helpers/bun $C/Contents/Resources/offload" \
    || fail "$1: the brain did not come from the bundle copy"
  echo "$out" | grep -qE "^brain status: 200" || { echo "$out" | tail -15; fail "$1: GET /status did not answer 200"; }
  [ $code -eq 0 ] || fail "$1: --brain-check exited $code"
}

echo "== PROOF (read-only copy, env -i, HOME temp, no bun, no OFFLOAD_REPO)"
chmod -R a-w "$C"
proof PROOF
chmod -R u+w "$C"

echo "== HARDENED (re-sign the copy: hardened runtime + app/brain.entitlements, ad hoc identity)"
hs="$(OFFLOAD_SIGN_IDENTITY=- "$ROOT/app/build.sh" sign "$C" 2>&1)" || { echo "$hs" | tail -10; fail "build.sh sign exited non-zero"; }
# (captured first: grep -q closing the pipe early would make pipefail report SIGPIPE)
sig_bun="$(codesign -dv "$C/Contents/Helpers/bun" 2>&1)"; ent_bun="$(codesign -d --entitlements - "$C/Contents/Helpers/bun" 2>/dev/null)"
sig_app="$(codesign -dv "$C/Contents/MacOS/Offload" 2>&1)"
echo "$sig_bun" | grep -qE "flags=0x[0-9a-f]+\([^)]*runtime" && echo "bun: hardened runtime" || fail "Helpers/bun is not signed with the hardened runtime"
for e in allow-jit allow-unsigned-executable-memory; do
  echo "$ent_bun" | grep -q "com.apple.security.cs.$e" && echo "bun: $e entitlement" || fail "Helpers/bun lacks the $e entitlement"
done
echo "$sig_app" | grep -qE "flags=0x[0-9a-f]+\([^)]*runtime" && echo "app: hardened runtime" || fail "the app is not signed with the hardened runtime"
codesign --verify --strict --deep "$C" >/dev/null 2>&1 && echo "codesign verify ok (hardened)" || fail "codesign verify failed after hardened signing"
chmod -R a-w "$C"
proof HARDENED
chmod -R u+w "$C"

echo "== NOTARY gate"
grep -q "notarytool submit" "$ROOT/app/build.sh" && grep -q -- "--keychain-profile" "$ROOT/app/build.sh" && grep -q "stapler staple" "$ROOT/app/build.sh" \
  && echo "notarytool + stapler step present" || fail "build.sh has no notarytool submit --keychain-profile / stapler staple step"
OFFLOAD_SIGN_IDENTITY=- OFFLOAD_NOTARY_PROFILE=s25-verify "$ROOT/app/build.sh" sign "$C" >/dev/null 2>&1 \
  && fail "build.sh notarized (or tried to) an ad hoc build" || echo "ad hoc + notary refused"
if grep -nE "sk-ant-[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY|--password[= ]+[^\"$ ]" "$ROOT/app/build.sh" "$ROOT"/plan/adr/0013-*.md 2>/dev/null; then
  fail "a secret-looking value is in build.sh or the ADR"
fi

echo "== size"
du -sh "$C" | sed "s|$T|\$T|"
du -sh "$C/Contents/Helpers/bun" "$C/Contents/Helpers/claude" "$C/Contents/Resources/offload" 2>/dev/null | sed "s|$C/||"

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

[ "$fails" -eq 0 ] && echo "s25-standalone-install: PASS" || { echo "s25-standalone-install: $fails failing check(s)"; exit 1; }
