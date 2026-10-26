#!/usr/bin/env bash
# s28-dmg done-signal. Contract: slices/s28-dmg/SPEC.md.
# 1. NOTE   2. BUILD (app/build.sh dmg into a temp dir)   3. IMAGE (format, mount read-only, contents)
# 4. PROOF (app copied off the image, env -i, no bun, temp HOME, read-only)   5. SIGN (sign-dmg, ad hoc)
# 6. NOTARY gate   7. RELEASE (release.sh --dry-run; never creates a release)   8. scope   9. CLEAN
# One "FAIL ..." line per failing check. Bash 3.2 compatible. Disk is tight: everything goes in one temp folder
# under /tmp/s28-tmp, which is removed at the end (the DMG and the app copy included).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE=0abc4e0   # origin/main when s28 started
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
export TMPDIR=/tmp/s28-tmp
mkdir -p "$TMPDIR"
T="$(mktemp -d "$TMPDIR/verify.XXXXXX")"
M="$T/mnt"
cleanup() {
  [ -d "$M" ] && { hdiutil detach "$M" -quiet 2>/dev/null || hdiutil detach "$M" -force -quiet 2>/dev/null; }
  chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"
}
trap cleanup EXIT
STRIPPED_PATH=/usr/bin:/bin:/usr/sbin:/sbin
NOTE="$ROOT/app/INSTALL-TESTERS.md"

echo "== NOTE"
if [ -f "$NOTE" ]; then
  for p in "Open Anyway" "Privacy & Security" "Screen Recording" "Accessibility" "Input Monitoring" \
           "Library/Application Support/Offload" "Applications"; do
    grep -qF "$p" "$NOTE" || fail "INSTALL-TESTERS.md does not mention \"$p\""
  done
  echo "INSTALL-TESTERS.md: $(wc -w < "$NOTE" | tr -d ' ') words"
else
  fail "no app/INSTALL-TESTERS.md"
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$ROOT/app/Info.plist" 2>/dev/null)"
[ -n "$VERSION" ] || fail "no CFBundleShortVersionString in app/Info.plist"

echo "== ENV (a dev shell's OFFLOAD_BUNDLE_BRAIN=0 never makes a DMG)"
nb="$(OFFLOAD_BUNDLE_BRAIN=0 OFFLOAD_BUILD_DIR="$T/nobrain" "$ROOT/app/build.sh" dmg 2>&1)" && fail "build.sh dmg accepted OFFLOAD_BUNDLE_BRAIN=0" \
  || { echo "$nb" | grep -q "OFFLOAD_BUNDLE_BRAIN" && echo "dmg refuses OFFLOAD_BUNDLE_BRAIN=0" || fail "build.sh dmg failed without naming OFFLOAD_BUNDLE_BRAIN: $(echo "$nb" | tail -1)"; }
[ -e "$T/nobrain/Offload.app" ] && fail "build.sh dmg built the app before refusing OFFLOAD_BUNDLE_BRAIN=0"
rm -rf "$T/nobrain"

echo "== BUILD (app/build.sh dmg, outside the repo, with dev-only runtime vars set that must be cleared)"
b="$(OFFLOAD_BRAIN_SOURCE=repo OFFLOAD_REPO=/nonexistent OFFLOAD_BUN=/nonexistent/bun OFFLOAD_BUILD_DIR="$T/build" "$ROOT/app/build.sh" dmg 2>&1)"; bcode=$?
echo "$b" | grep -E "^dmg: cleared dev-only env:" | grep -q "OFFLOAD_BRAIN_SOURCE" && echo "$b" | grep -E "^dmg: cleared dev-only env:" | grep -q "OFFLOAD_REPO" \
  || fail "build.sh dmg did not report clearing OFFLOAD_BRAIN_SOURCE and OFFLOAD_REPO"
[ $bcode -eq 0 ] || { echo "$b" | tail -20; fail "app/build.sh dmg exited $bcode"; }
echo "$b" | grep -E "^dmg:" | sed "s|$T|\$T|g"
echo "$b" | grep -qF "dmg: not signed and not notarized (ad hoc build" || fail "no ad hoc skip line for the DMG"
DMG="$T/build/Offload-$VERSION.dmg"
if [ ! -f "$DMG" ]; then
  fail "no Offload-$VERSION.dmg built"
  echo "s28-dmg: $fails failing check(s)"; exit 1
fi
rm -rf "$T/build/Offload.app" "$T/build/dmg-stage"   # only the image is needed from here on
echo "dmg size: $(du -h "$DMG" | cut -f1)"

echo "== IMAGE"
fmt="$(hdiutil imageinfo "$DMG" 2>/dev/null | sed -n 's/^Format: *//p' | head -1)"
case "$fmt" in UDZO|ULFO) echo "format $fmt" ;; *) fail "image format is '$fmt', not UDZO or ULFO" ;; esac
mkdir -p "$M"
if ! hdiutil attach -nobrowse -readonly -noverify -mountpoint "$M" "$DMG" >/dev/null 2>&1; then
  fail "hdiutil attach -nobrowse -readonly failed"
  echo "s28-dmg: $fails failing check(s)"; exit 1
fi
vol="$(diskutil info "$M" 2>/dev/null | sed -n 's/^ *Volume Name: *//p')"
[ "$vol" = "Offload" ] && echo "volume name Offload" || fail "volume name is '$vol', not Offload"
[ -d "$M/Offload.app/Contents/MacOS" ] && echo "Offload.app present" || fail "no Offload.app on the image"
[ -L "$M/Applications" ] && [ "$(readlink "$M/Applications")" = "/Applications" ] && echo "Applications -> /Applications" \
  || fail "no Applications link to /Applications on the image"
[ -f "$M/INSTALL-TESTERS.md" ] && cmp -s "$M/INSTALL-TESTERS.md" "$NOTE" && echo "INSTALL-TESTERS.md present" \
  || fail "the tester note on the image is missing or differs from app/INSTALL-TESTERS.md"
[ -x "$M/Offload.app/Contents/Helpers/bun" ] || fail "the app on the image has no bundled brain (Contents/Helpers/bun)"
[ -x "$M/Offload.app/Contents/MacOS/offload-observer" ] || fail "the app on the image has no offload-observer"
codesign --verify --strict --deep "$M/Offload.app" >/dev/null 2>&1 && echo "codesign verify ok (mounted app)" \
  || fail "codesign --verify --strict --deep failed on the mounted app"

echo "== copy off the image"
I="$T/install"; mkdir -p "$I" "$T/home" "$T/tmp"
ditto "$M/Offload.app" "$I/Offload.app" || fail "could not copy the app off the image"
hdiutil detach "$M" -quiet || hdiutil detach "$M" -force -quiet || fail "hdiutil detach failed"
rmdir "$M" 2>/dev/null
C="$I/Offload.app"
case "$C" in "$ROOT"/*) fail "the copy is inside the repo" ;; esac

echo "== PROOF (copied app, read-only, env -i, HOME temp, no bun, no OFFLOAD_REPO)"
env -i PATH="$STRIPPED_PATH" sh -c 'command -v bun' >/dev/null 2>&1 && fail "bun is on the stripped PATH"
chmod -R a-w "$C"
out="$(cd "$T" && env -i HOME="$T/home" PATH="$STRIPPED_PATH" TMPDIR="$T/tmp" \
  "$C/Contents/MacOS/Offload" --brain-check --home "$T/home/offload" 2>&1)"; code=$?
chmod -R u+w "$C"
echo "$out" | grep -E "^brain (source|status)" | sed "s|$T|\$T|g"
echo "$out" | grep -qF "brain source: bundled $C/Contents/Helpers/bun $C/Contents/Resources/offload" \
  || fail "PROOF: the brain did not come from the copied app"
echo "$out" | grep -qE "^brain status: 200" || { echo "$out" | tail -15; fail "PROOF: GET /status did not answer 200"; }
[ $code -eq 0 ] || fail "PROOF: --brain-check exited $code"
rm -rf "$I"

echo "== RELEASE (app/release.sh --dry-run; a fake gh refuses 'release create')"
FG="$T/fakegh"; mkdir -p "$FG"
realgh="$(command -v gh 2>/dev/null || true)"
cat > "$FG/gh" <<EOF
#!/bin/sh
if [ "\$1" = release ] && [ "\$2" = create ]; then echo called > "$T/gh-create-called"; exit 1; fi
[ -n "$realgh" ] || exit 1
exec "$realgh" "\$@"
EOF
chmod +x "$FG/gh"
if [ ! -x "$ROOT/app/release.sh" ]; then
  fail "no executable app/release.sh"
else
  git -C "$ROOT" fetch -q origin 2>/dev/null
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=no)"
  onorigin="$(git -C "$ROOT" branch -r --contains HEAD 2>/dev/null | grep -v -- '->' | head -1)"
  r="$(PATH="$FG:$PATH" "$ROOT/app/release.sh" --dry-run --dmg "$DMG" --notes-out "$T/notes.md" 2>&1)"; rcode=$?
  if [ -n "$dirty" ] || [ -z "$onorigin" ]; then
    echo "tree dirty or HEAD not on origin: release.sh must refuse"
    [ $rcode -ne 0 ] && echo "$r" | grep -q "release.sh: refused" && echo "refused as expected" \
      || fail "release.sh did not refuse a dirty tree or a HEAD that is not on origin"
  else
    [ $rcode -eq 0 ] || { echo "$r" | tail -10; fail "release.sh --dry-run exited $rcode"; }
    echo "$r" | sed "s|$T|\$T|g" | grep -E "^(tag|sha256|upload|would run):" | head -8
    echo "$r" | grep -qE "^tag: v$VERSION-beta\.[0-9]+$" || fail "no tag v$VERSION-beta.N in the dry run"
    sum="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
    echo "$r" | grep -qF "sha256: $sum" || fail "the dry run's SHA-256 does not match the DMG"
    [ -f "$DMG.sha256" ] && grep -qF "$sum" "$DMG.sha256" || fail "no matching $DMG.sha256 file"
    echo "$r" | grep -q "^would run: gh release create v$VERSION-beta\.[0-9]* .*--repo tabani-png/offload --prerelease" \
      || fail "the dry run does not print the gh release create line"
    head="$(git -C "$ROOT" rev-parse HEAD)"
    if [ -f "$T/notes.md" ]; then
      for p in "$head" "$sum" "unsigned" "Open Anyway" "private" "collaborators"; do
        grep -qF "$p" "$T/notes.md" || fail "release notes do not contain \"$p\""
      done
      echo "notes: $(wc -l < "$T/notes.md" | tr -d ' ') lines"
    else
      fail "release.sh --notes-out wrote no notes"
    fi
  fi
  # release.sh refuses OFFLOAD_BUNDLE_BRAIN=0 and a DMG whose app has no bundled brain.
  rb="$(OFFLOAD_BUNDLE_BRAIN=0 PATH="$FG:$PATH" "$ROOT/app/release.sh" --dry-run --dmg "$DMG" 2>&1)" \
    && fail "release.sh accepted OFFLOAD_BUNDLE_BRAIN=0" \
    || { echo "$rb" | grep -q "refused: .*OFFLOAD_BUNDLE_BRAIN" && echo "release refuses OFFLOAD_BUNDLE_BRAIN=0" || fail "release.sh did not name OFFLOAD_BUNDLE_BRAIN when refusing"; }
  FS="$T/fake-stage"; mkdir -p "$FS/Offload.app/Contents/MacOS"
  printf '#!/bin/sh\n' > "$FS/Offload.app/Contents/MacOS/Offload"; chmod +x "$FS/Offload.app/Contents/MacOS/Offload"
  ln -s /Applications "$FS/Applications"
  hdiutil create -quiet -volname Offload -srcfolder "$FS" -format ULFO -ov "$T/brainless.dmg" || fail "could not make the brainless test image"
  rm -rf "$FS"
  rl="$(PATH="$FG:$PATH" "$ROOT/app/release.sh" --dry-run --dmg "$T/brainless.dmg" 2>&1)" \
    && fail "release.sh accepted a DMG whose app has no bundled brain" \
    || { echo "$rl" | grep -q "refused: .*brain" && echo "release refuses a brainless DMG" || fail "release.sh refused the brainless DMG for another reason: $(echo "$rl" | tail -1)"; }
  hdiutil info 2>/dev/null | grep -qF "$T/brainless.dmg" && fail "release.sh left the brainless image attached"
  rm -f "$T/brainless.dmg" "$T/brainless.dmg.sha256"
  grep -q 'OFFLOAD_SIGN_IDENTITY.*-' "$ROOT/app/release.sh" || fail "release.sh has no guard against OFFLOAD_SIGN_IDENTITY=- (ad hoc hardened, dev only)"
  [ -e "$T/gh-create-called" ] && fail "release.sh --dry-run called gh release create"
  grep -q "status --porcelain" "$ROOT/app/release.sh" && grep -q "origin/main" "$ROOT/app/release.sh" \
    || fail "release.sh has no clean-tree / origin/main guard"
fi

echo "== SIGN (app/build.sh sign-dmg with an ad hoc identity)"
s="$(OFFLOAD_SIGN_IDENTITY=- "$ROOT/app/build.sh" sign-dmg "$DMG" 2>&1)" || { echo "$s" | tail -5; fail "build.sh sign-dmg exited non-zero"; }
codesign --verify --strict "$DMG" >/dev/null 2>&1 && echo "signed DMG verifies" || fail "codesign --verify failed on the signed DMG"
# (captured first: grep -q closing the pipe early would make pipefail report SIGPIPE)
sig_dmg="$(codesign -dv "$DMG" 2>&1)"
echo "$sig_dmg" | grep -q "Format=disk image" || fail "codesign does not see a signed disk image"

echo "== NOTARY gate"
grep -q "notarytool submit" "$ROOT/app/build.sh" && grep -qE "stapler (staple|validate) \"\\\$dmg\"" "$ROOT/app/build.sh" \
  && echo "DMG notarytool + stapler step present" || fail "build.sh has no notarize + staple step for the DMG"
nb="$(OFFLOAD_SIGN_IDENTITY=- OFFLOAD_NOTARY_PROFILE=s28-verify OFFLOAD_BUILD_DIR="$T/refuse" "$ROOT/app/build.sh" dmg 2>&1)" \
  && fail "build.sh dmg accepted ad hoc + notary profile" || echo "ad hoc + notary refused"
[ -e "$T/refuse/Offload.app" ] && fail "build.sh dmg built the app before refusing ad hoc + notary"
if grep -nE "sk-ant-[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY|--password[= ]+[^\"$ ]" "$ROOT/app/build.sh" "$ROOT/app/release.sh" 2>/dev/null; then
  fail "a secret-looking value is in build.sh or release.sh"
fi

echo "== scope"
. "$ROOT/scripts/lib/slice-changes.sh"
# Only s28's own commits (later slices that merge on top may touch other paths under their own contracts; same rule
# as s25, approved in PR #36).
SLICE_GREP='^[a-z]+\(s28-dmg\)' slice_files --allow-skip "$BASE"; scope_rc=$?
case $scope_rc in
  0) while IFS= read -r p; do
       [ -n "$p" ] || continue
       case "$p" in brain/*|engine/*|control/*|web/*|schemas/*|packages/*) fail "out-of-scope path changed: $p" ;; esac
     done <<< "$SLICE_FILES"
     echo "scope checked ($(printf '%s\n' "$SLICE_FILES" | grep -c .) files)" ;;
  3) echo "scope: SKIPPED ($SLICE_ERROR)" ;;
  *) fail "scope check could not run: $SLICE_ERROR" ;;
esac

echo "== CLEAN"
cleanup; trap - EXIT
[ -e "$T" ] && fail "temp folder $T was not removed" || echo "temp folder, DMG and app copy removed"
hdiutil info 2>/dev/null | grep -qF "$T" && fail "an image from $T is still attached"

[ "$fails" -eq 0 ] && echo "s28-dmg: PASS" || { echo "s28-dmg: $fails failing check(s)"; exit 1; }
