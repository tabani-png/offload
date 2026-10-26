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
# Refuses: tracked changes in the tree, a HEAD on no origin branch, and (real run) a HEAD not on origin/main.
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
  echo "**Private repo:** only collaborators on $REPO can download these files. Anyone else gets a 404."
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
