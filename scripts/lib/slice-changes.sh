#!/usr/bin/env bash
# slice-changes.sh: print the files a slice branch itself changed, one per line, sorted, for verify.sh scope checks.
#
# Why: `git diff --name-only "$BASE"...HEAD` with a fixed BASE counts every file main changed after BASE once the
# branch merges main in (our standard update, since force-push is not allowed). That is a false scope failure.
#
# Use from a slice's verify.sh (Bash 3.2 compatible, safe under set -u / pipefail):
#   . "$ROOT/scripts/lib/slice-changes.sh"
#   changed="$(slice_changes "$BASE")"; rc=$?          # rc 2 = skipped (reason on stderr), changed is empty
#   changed="$(slice_changes "$BASE" -- brain/package.json)"   # limit to paths
#   changed="$(SLICE_GREP='^s18' slice_changes "$BASE")"       # only commits whose message matches (s12/s14/s18 style)
# Or run it: scripts/lib/slice-changes.sh [BASE] [-- path...]
#
# Default mode: net diff of HEAD against merge-base(HEAD, INTEGRATION). After merging main this is exactly the slice's
# own net change, including edits made while resolving merge conflicts. If BASE is newer than that merge-base (the
# slice started on top of commits not yet on main), the diff starts at BASE instead.
# SLICE_GREP mode: files touched by non-merge commits in BASE..HEAD that match SLICE_GREP and are not on INTEGRATION,
# plus files hand-edited inside merge commits on the branch (git log --remerge-diff), so conflict edits are still caught.
#
# INTEGRATION: $SLICE_INTEGRATION, else origin/main, else main. If none exists, falls back to BASE (old behaviour).
# Skips (rc 2) when BASE is given but missing (shallow clone). On main after the slice merged it prints nothing.
# Uncommitted changes are not counted. Callers that want the repo root can set SLICE_ROOT; default is this repo.

slice_changes() {
  local root="${SLICE_ROOT:-}"
  if [ -z "$root" ]; then root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; fi
  local base=""
  if [ $# -gt 0 ] && [ "$1" != "--" ]; then base="$1"; shift; fi
  if [ $# -gt 0 ] && [ "$1" = "--" ]; then shift; fi
  # remaining args are pathspecs

  if [ -n "$base" ] && ! git -C "$root" cat-file -e "$base^{commit}" 2>/dev/null; then
    echo "slice_changes: BASE $base not in history (shallow clone), skipped" >&2
    return 2
  fi

  local integ="${SLICE_INTEGRATION:-}" cand
  if [ -z "$integ" ]; then
    for cand in origin/main main; do
      if git -C "$root" rev-parse --verify -q "$cand^{commit}" >/dev/null 2>&1; then integ="$cand"; break; fi
    done
  elif ! git -C "$root" rev-parse --verify -q "$integ^{commit}" >/dev/null 2>&1; then
    echo "slice_changes: SLICE_INTEGRATION $integ not found" >&2
    return 2
  fi
  if [ -z "$integ" ]; then
    if [ -z "$base" ]; then echo "slice_changes: no origin/main or main and no BASE, skipped" >&2; return 2; fi
    echo "slice_changes: no origin/main or main, diffing from BASE $base" >&2
    integ="$base"
  fi

  if [ -n "${SLICE_GREP:-}" ]; then
    local range="HEAD"
    [ -n "$base" ] && range="$base..HEAD"
    {
      git -C "$root" log --no-merges --format= --name-only --grep="$SLICE_GREP" "$range" --not "$integ" -- "$@"
      git -C "$root" log --merges --remerge-diff --format= --name-only "$range" --not "$integ" -- "$@"
    } 2>/dev/null | sed '/^$/d' | sort -u
    return 0
  fi

  local start
  start="$(git -C "$root" merge-base HEAD "$integ" 2>/dev/null)" || start=""
  if [ -z "$start" ]; then
    if [ -z "$base" ]; then echo "slice_changes: HEAD shares no history with $integ, skipped" >&2; return 2; fi
    start="$base"
  elif [ -n "$base" ] && [ "$(git -C "$root" rev-parse "$base^{commit}")" != "$start" ] \
       && git -C "$root" merge-base --is-ancestor "$start" "$base" 2>/dev/null; then
    start="$base"   # slice started on top of commits not yet on the integration branch
  fi
  git -C "$root" diff --name-only "$start" HEAD -- "$@" 2>/dev/null | sed '/^$/d' | sort -u
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  slice_changes "$@"
fi
