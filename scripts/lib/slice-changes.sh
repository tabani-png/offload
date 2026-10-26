#!/usr/bin/env bash
# slice-changes.sh: the files a slice branch itself changed, for verify.sh scope checks. Bash 3.2 compatible.
#
# Why: `git diff --name-only "$BASE"...HEAD` with a fixed BASE counts every file main changed after BASE once the
# branch merges main in (our standard update, since force-push is not allowed). That is a false scope failure.
#
# Callers use slice_files (sets variables, keeps the return code; never read the list from a command substitution):
#   . "$ROOT/scripts/lib/slice-changes.sh"
#   slice_files --allow-skip "$BASE"; rc=$?
#   case $rc in
#     0) while IFS= read -r f; do [ -n "$f" ] || continue; case "$f" in ...) fail "...";; esac; done <<< "$SLICE_FILES" ;;
#     3) echo "scope: SKIPPED ($SLICE_ERROR)" ;;   # only reachable with --allow-skip: BASE missing (shallow clone)
#     *) fail "scope: $SLICE_ERROR" ;;
#   esac
#   SLICE_GREP='^s18' slice_files "$BASE"     # only commits whose SUBJECT matches (extended regex), s12/s14/s18 style
#   slice_files "$BASE" -- brain/package.json # limit to paths
# CLI: scripts/lib/slice-changes.sh [BASE] [-- path...]   prints the list; rc 0 ok, 2 BASE missing, 1 error.
#
# Return codes of slice_files: 0 listed (SLICE_FILES, may be empty); 1 error (SLICE_ERROR), callers must FAIL;
# 3 BASE missing and --allow-skip given, callers print a loud SKIPPED line. Without --allow-skip a missing BASE is 1.
# Output contract: one raw path per line (core.quotePath off), sorted, renames reported as delete + add
# (--no-renames, so a file moved out of an out-of-scope path is still reported). Paths containing newlines are not
# supported. Uncommitted changes are not counted.
#
# Default mode: net diff of HEAD against merge-base(HEAD, INTEGRATION). After merging main this is exactly the slice's
# own net change, including edits made while resolving merge conflicts. If BASE is newer than that merge-base (the
# slice started on top of commits not yet on main), the diff starts at BASE instead.
# SLICE_GREP mode: files of non-merge commits in BASE..HEAD, not on INTEGRATION, whose subject line matches SLICE_GREP,
# plus files hand-edited inside merge commits on the branch (git log --remerge-diff, git >= 2.36; else an error).
#
# INTEGRATION: $SLICE_INTEGRATION, else origin/main, else main. If none exists and BASE is given, diffs from BASE
# (a superset: may false-fail, never hides); with no BASE it is an error. SLICE_ROOT overrides the repo (tests).

slice_files() {
  SLICE_FILES=""; SLICE_ERROR=""
  local allow_skip=0
  if [ $# -gt 0 ] && [ "$1" = "--allow-skip" ]; then allow_skip=1; shift; fi
  local root="${SLICE_ROOT:-}"
  if [ -z "$root" ]; then root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; fi
  local base=""
  if [ $# -gt 0 ] && [ "$1" != "--" ]; then base="$1"; shift; fi
  if [ $# -gt 0 ] && [ "$1" = "--" ]; then shift; fi
  # remaining args are pathspecs

  if ! git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then SLICE_ERROR="$root is not a git repo"; return 1; fi
  if [ -n "$base" ] && ! git -C "$root" cat-file -e "$base^{commit}" 2>/dev/null; then
    SLICE_ERROR="BASE $base not in history (shallow clone?)"
    [ $allow_skip -eq 1 ] && return 3
    return 1
  fi

  local integ="${SLICE_INTEGRATION:-}" cand
  if [ -z "$integ" ]; then
    for cand in origin/main main; do
      if git -C "$root" rev-parse --verify -q "$cand^{commit}" >/dev/null 2>&1; then integ="$cand"; break; fi
    done
  elif ! git -C "$root" rev-parse --verify -q "$integ^{commit}" >/dev/null 2>&1; then
    SLICE_ERROR="SLICE_INTEGRATION $integ not found"; return 1
  fi
  if [ -z "$integ" ]; then
    if [ -z "$base" ]; then SLICE_ERROR="no origin/main or main to compare against (set SLICE_INTEGRATION)"; return 1; fi
    echo "slice_files: no origin/main or main, diffing from BASE $base (superset)" >&2
    integ="$base"
  fi

  local out
  if [ -n "${SLICE_GREP:-}" ]; then
    local range="HEAD" commits sha subj files merged
    [ -n "$base" ] && range="$base..HEAD"
    if ! git -C "$root" log -1 --remerge-diff --format= HEAD >/dev/null 2>&1; then
      SLICE_ERROR="this git ($(git --version 2>/dev/null)) has no --remerge-diff (need >= 2.36); SLICE_GREP mode cannot check merge commits"
      return 1
    fi
    commits="$(git -C "$root" log --no-merges --format='%H %s' "$range" --not "$integ" 2>&1)" \
      || { SLICE_ERROR="git log failed: $commits"; return 1; }
    out=""
    while IFS= read -r sha; do
      [ -n "$sha" ] || continue
      subj="${sha#* }"; sha="${sha%% *}"
      printf '%s\n' "$subj" | grep -Eq -- "$SLICE_GREP" || continue
      files="$(git -C "$root" -c core.quotePath=false diff-tree --root --no-commit-id --no-renames --name-only -r "$sha" -- "$@" 2>&1)" \
        || { SLICE_ERROR="git diff-tree $sha failed: $files"; return 1; }
      out="$out$files"$'\n'
    done <<< "$commits"
    merged="$(git -C "$root" -c core.quotePath=false log --merges --remerge-diff --no-renames --format= --name-only "$range" --not "$integ" -- "$@" 2>&1)" \
      || { SLICE_ERROR="git log --remerge-diff failed: $merged"; return 1; }
    out="$out$merged"
  else
    local start
    start="$(git -C "$root" merge-base HEAD "$integ" 2>/dev/null)" || start=""
    if [ -z "$start" ]; then
      if [ -z "$base" ]; then SLICE_ERROR="HEAD shares no history with $integ"; return 1; fi
      start="$base"
    elif [ -n "$base" ] && [ "$(git -C "$root" rev-parse "$base^{commit}")" != "$start" ] \
         && git -C "$root" merge-base --is-ancestor "$start" "$base" 2>/dev/null; then
      start="$base"   # slice started on top of commits not yet on the integration branch
    fi
    out="$(git -C "$root" -c core.quotePath=false diff --no-renames --name-only "$start" HEAD -- "$@" 2>&1)" \
      || { SLICE_ERROR="git diff failed: $out"; return 1; }
  fi
  SLICE_FILES="$(printf '%s\n' "$out" | sed '/^$/d' | LC_ALL=C sort -u)"
  return 0
}

# slice_changes [BASE] [-- path...]: print the list. rc 0 ok, 2 BASE missing (reason on stderr), 1 error.
slice_changes() {
  slice_files --allow-skip "$@"
  case $? in
    0) [ -z "$SLICE_FILES" ] || printf '%s\n' "$SLICE_FILES"; return 0 ;;
    3) echo "slice_changes: $SLICE_ERROR, skipped" >&2; return 2 ;;
    *) echo "slice_changes: $SLICE_ERROR" >&2; return 1 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  slice_changes "$@"
fi
