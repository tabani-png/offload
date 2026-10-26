#!/usr/bin/env bash
# s28: put the tester DMG on a GitHub prerelease. Run it from a clean checkout of main that is on origin.
#
#   app/release.sh                     build the DMG (app/build.sh dmg) and create the prerelease
#   app/release.sh --dry-run           everything except `gh release create`; prints what it would upload
#   app/release.sh --dry-run --dmg F   dry run on an existing DMG (no build; dry run only)
#   --notes-out F                      also copy the generated notes to F
#
# Tag v<CFBundleShortVersionString>-beta.<n>; n is one more than the highest existing v<version>-beta.* tag
# (OFFLOAD_BETA_N overrides). Uploads the DMG and <dmg>.sha256 (shasum -a 256). The notes are app/INSTALL-TESTERS.md,
# the commit SHA and the checksum. The repo is private: only collaborators can download the assets.
# Refuses: OFFLOAD_BUNDLE_BRAIN other than 1, OFFLOAD_SIGN_IDENTITY=-, a DMG whose app lacks the bundled brain or the
# observer, tracked changes in the tree, a HEAD on no origin branch, and (real run) a HEAD not on origin/main.
# Works from any clean worktree of the repo (paths come from this script's location).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO=tabani-png/offload
dry=0; dmg=""; notes_out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --dmg) dmg="${2:?--dmg needs a path}"; shift ;;
    --notes-out) notes_out="${2:?--notes-out needs a path}"; shift ;;
    *) echo "usage: app/release.sh [--dry-run] [--dmg PATH] [--notes-out PATH]" >&2; exit 2 ;;
  esac
  shift
done
refuse() { echo "release.sh: refused: $*" >&2; exit 1; }
[ -n "$dmg" ] && [ $dry -eq 0 ] && refuse "--dmg is for dry runs only; a real release builds its own DMG from this commit"
# Dev-shell settings that would make a broken release (app/build.sh dmg also clears the runtime-only OFFLOAD_* vars).
if [ -n "${OFFLOAD_BUNDLE_BRAIN:-}" ] && [ "$OFFLOAD_BUNDLE_BRAIN" != "1" ]; then
  refuse "OFFLOAD_BUNDLE_BRAIN=$OFFLOAD_BUNDLE_BRAIN; a release must carry the brain (unset it)"
fi
[ "${OFFLOAD_SIGN_IDENTITY:-}" = "-" ] && refuse "OFFLOAD_SIGN_IDENTITY=- (ad hoc hardened runtime) is for tests; unset it, or set a Developer ID"

# The app on the image must carry the brain and the observer. Mounted read-only at a private mount point.
check_dmg() {
  local img="$1" mnt ok=1 missing=""
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/offload-release-mnt.XXXXXX")"
  if ! hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mnt" "$img" >/dev/null 2>&1; then
    rmdir "$mnt" 2>/dev/null; refuse "could not mount $img"
  fi
  local a="$mnt/Offload.app/Contents"
  [ -x "$a/Helpers/bun" ] || missing="$missing Contents/Helpers/bun"
  [ -f "$a/Resources/offload/brain/src/cli.ts" ] || missing="$missing Contents/Resources/offload/brain/src/cli.ts"
  [ -x "$a/MacOS/offload-observer" ] || missing="$missing Contents/MacOS/offload-observer"
  hdiutil detach "$mnt" -quiet 2>/dev/null || hdiutil detach "$mnt" -force -quiet 2>/dev/null || true
  rmdir "$mnt" 2>/dev/null || true
  [ -z "$missing" ] || refuse "the DMG's app has no bundled brain or observer (missing:$missing)"
  echo "dmg check: bundled brain and observer present"
}
[ -n "$dmg" ] && { [ -f "$dmg" ] || refuse "no DMG at $dmg"; check_dmg "$dmg"; }

git -C "$ROOT" fetch -q origin || refuse "git fetch origin failed"
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || refuse "the tree has uncommitted changes"
head="$(git -C "$ROOT" rev-parse HEAD)"
[ -n "$(git -C "$ROOT" branch -r --contains HEAD | grep -v -- '->' || true)" ] || refuse "HEAD $head is not on origin (push it first)"
if ! git -C "$ROOT" merge-base --is-ancestor HEAD origin/main; then
  [ $dry -eq 1 ] || refuse "HEAD $head is not on origin/main; releases are built from main"
  echo "warning: HEAD is not on origin/main; a real release would refuse"
fi

version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$HERE/Info.plist")"
if [ -z "$dmg" ]; then
  "$HERE/build.sh" dmg
  dmg="${OFFLOAD_BUILD_DIR:-$HERE/.build}/Offload-$version.dmg"
  [ -f "$dmg" ] || refuse "no DMG at $dmg"
  check_dmg "$dmg"
fi
[ -f "$dmg" ] || refuse "no DMG at $dmg"
name="$(basename "$dmg")"

if [ -n "${OFFLOAD_BETA_N:-}" ]; then
  n="$OFFLOAD_BETA_N"
else
  tags="$(gh release list --repo "$REPO" --limit 500 --json tagName -q '.[].tagName')" || refuse "gh release list failed (gh auth status?)"
  tags="$tags
$(git -C "$ROOT" ls-remote --tags origin | sed 's|.*refs/tags/||; s|\^{}$||')"
  last="$(printf '%s\n' "$tags" | sed -n "s/^v${version//./\\.}-beta\.\([0-9][0-9]*\)$/\1/p" | sort -n | tail -1)"
  n=$(( ${last:-0} + 1 ))
fi
tag="v$version-beta.$n"

sum="$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
printf '%s  %s\n' "$sum" "$name" > "$dmg.sha256"

if codesign -dv "$dmg" 2>&1 | grep -q "^Authority=Developer ID Application"; then
  title="Offload $version beta"
  signed_line="Signed with a Developer ID."
else
  title="Offload $version beta (unsigned)"
  signed_line="**This build is unsigned.** macOS blocks it the first time. Open it once, then use System Settings > Privacy & Security > **Open Anyway** (steps below)."
fi

notes="$(mktemp "${TMPDIR:-/tmp}/offload-release-notes.XXXXXX")"
trap 'rm -f "$notes"' EXIT
{
  echo "$signed_line"
  echo
  echo "**This repo is private:** only collaborators on $REPO can download these files. Anyone else gets a 404."
  echo
  echo "- Commit: \`$head\`"
  echo "- \`$name\` SHA-256: \`$sum\`"
  echo "  Check it after download: \`shasum -a 256 $name\` (or compare with \`$name.sha256\`)."
  echo
  echo "---"
  echo
  cat "$HERE/INSTALL-TESTERS.md"
} > "$notes"
[ -n "$notes_out" ] && cp "$notes" "$notes_out"

echo "tag: $tag"
echo "commit: $head"
echo "sha256: $sum"
echo "upload: $dmg ($(du -h "$dmg" | cut -f1))"
echo "upload: $dmg.sha256"
cmd=(gh release create "$tag" "$dmg" "$dmg.sha256" --repo "$REPO" --prerelease --target "$head" --title "$title" --notes-file "$notes")
[ $dry -eq 1 ] && echo "would run: ${cmd[*]}" || echo "run: ${cmd[*]}"
if [ $dry -eq 1 ]; then
  echo "dry run: nothing uploaded"
  exit 0
fi
"${cmd[@]}"
echo "released $tag"
