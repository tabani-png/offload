#!/usr/bin/env bash
# Tests for scripts/lib/slice-changes.sh against throwaway git repos. Run: bash scripts/tests/slice-changes.test.sh
# Also compares the candidate approaches so the choice stays documented:
#   old   git diff --name-only BASE...HEAD                      (fixed BASE: counts main's changes after a merge)
#   logA  git log --no-merges --name-only BASE..HEAD --not main (misses edits made inside a merge commit)
#   net   slice_changes default: diff merge-base(HEAD, main)..HEAD (chosen)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../lib/slice-changes.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/slice-changes-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
pass=0; failn=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; echo "     want: [$2]"; echo "     got:  [$3]"; failn=$((failn + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi }
join() { tr '\n' ' ' | sed 's/ $//'; }

g() { git -C "$R" -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }
edit() { mkdir -p "$R/$(dirname "$1")"; echo "$2" >> "$R/$1"; g add -A; }
commit() { g commit -qm "$1"; }
net() { SLICE_ROOT="$R" slice_changes "$@" | join; }
grepmode() { SLICE_GREP='^s99' SLICE_ROOT="$R" slice_changes "$@" | join; }
old() { g diff --name-only "$1"...HEAD | sort -u | join; }
logA() { g log --no-merges --format= --name-only "$1"..HEAD --not main | sed '/^$/d' | sort -u | join; }

new_repo() {
  R="$TMP/$1"; mkdir -p "$R"; g init -q
  edit slice/in.txt base; edit out/x.txt base; commit "init"
  BASE="$(g rev-parse HEAD)"
}

echo "== (a) plain branch, no merges"
new_repo a
g checkout -qb s99
edit slice/in.txt s1; commit "s99: first"
edit slice/new.txt s2; commit "s99: second"
eq "(a) net" "slice/in.txt slice/new.txt" "$(net "$BASE")"
eq "(a) grep" "slice/in.txt slice/new.txt" "$(grepmode "$BASE")"
eq "(a) old agrees" "slice/in.txt slice/new.txt" "$(old "$BASE")"

echo "== (b) branch merged main once, then twice"
new_repo b
g checkout -qb s99
edit slice/in.txt s1; commit "s99: first"
g checkout -q main; edit out/x.txt m1; edit out/y.txt m1; commit "main: other slice"
g checkout -q s99; g merge -q --no-edit main
eq "(b1) net ignores main's files" "slice/in.txt" "$(net "$BASE")"
eq "(b1) grep ignores main's files" "slice/in.txt" "$(grepmode "$BASE")"
eq "(b1) old is the bug (counts main)" "out/x.txt out/y.txt slice/in.txt" "$(old "$BASE")"
g checkout -q main; edit out/z.txt m2; commit "main: third slice"
g checkout -q s99; edit slice/more.txt s2; commit "s99: after merge"; g merge -q --no-edit main
eq "(b2) net after second merge" "slice/in.txt slice/more.txt" "$(net "$BASE")"
eq "(b2) grep after second merge" "slice/in.txt slice/more.txt" "$(grepmode "$BASE")"
eq "(b2) net limited to paths" "" "$(net "$BASE" -- out)"
g checkout -q main; edit out/w.txt m3; commit "main: moved on, not merged yet"; g checkout -q s99
eq "(b3) main moved after last merge" "slice/in.txt slice/more.txt" "$(net "$BASE")"

echo "== (c) merge-conflict resolution edits an out-of-scope file inside the merge commit"
new_repo c
g checkout -qb s99
edit slice/in.txt s1; commit "s99: first"
g checkout -q main; edit slice/in.txt m1; edit out/y.txt m1; commit "main: conflicting"
g checkout -q s99
g merge -q --no-edit main >/dev/null 2>&1   # conflicts on slice/in.txt
printf 'resolved\n' > "$R/slice/in.txt"; edit out/x.txt sneaky; g commit -qm "merge main"
eq "(c) net catches the conflict edit" "out/x.txt slice/in.txt" "$(net "$BASE")"
eq "(c) grep catches it via remerge-diff" "out/x.txt slice/in.txt" "$(grepmode "$BASE")"
eq "(c) logA misses it (why it is not used alone)" "slice/in.txt" "$(logA "$BASE")"
echo "-- (c2) clean conflict resolution adds nothing out of scope"
new_repo c2
g checkout -qb s99
edit slice/in.txt s1; commit "s99: first"
g checkout -q main; edit slice/in.txt m1; edit out/y.txt m1; commit "main: conflicting"
g checkout -q s99
g merge -q --no-edit main >/dev/null 2>&1
printf 'resolved\n' > "$R/slice/in.txt"; g add -A; g commit -qm "merge main"
eq "(c2) net" "slice/in.txt" "$(net "$BASE")"
eq "(c2) grep" "slice/in.txt" "$(grepmode "$BASE")"

echo "== (d) run on main after the slice merged"
g checkout -q main; g merge -q --no-ff --no-edit s99
eq "(d) net on main reports nothing" "" "$(net "$BASE")"
eq "(d) grep on main reports nothing" "" "$(grepmode "$BASE")"
SLICE_ROOT="$R" slice_changes "$BASE" >/dev/null 2>&1; eq "(d) exit 0" "0" "$?"

echo "== (e) shallow clone: BASE missing"
new_repo e-src
g checkout -qb s99; edit slice/in.txt s1; commit "s99: first"; edit slice/in.txt s2; commit "s99: second"
git clone -q --depth 1 --branch s99 "file://$R" "$TMP/e" 2>/dev/null
out="$(SLICE_ROOT="$TMP/e" slice_changes "$BASE" 2>"$TMP/e.err")"; rc=$?
eq "(e) exit 2 (skip)" "2" "$rc"
eq "(e) prints nothing" "" "$out"
grep -q "not in history (shallow clone), skipped" "$TMP/e.err" && ok "(e) skip reason on stderr" || bad "(e) skip reason" "shallow message" "$(cat "$TMP/e.err")"

echo "== (f) origin/main preferred over a stale local main"
new_repo f-origin
g checkout -q main
git clone -q "file://$R" "$TMP/f" 2>/dev/null
ORIG="$R"; R="$TMP/f"
g checkout -qb s99; edit slice/in.txt s1; commit "s99: first"
R="$ORIG"; edit out/x.txt m1; commit "main: on the remote"; R="$TMP/f"
g fetch -q origin; g merge -q --no-edit origin/main   # local main stays stale
eq "(f) net uses origin/main" "slice/in.txt" "$(net "$BASE")"
eq "(f) explicit SLICE_INTEGRATION=main shows the stale-main effect" "out/x.txt slice/in.txt" "$(SLICE_INTEGRATION=main net "$BASE")"
out="$(SLICE_INTEGRATION=nope SLICE_ROOT="$R" slice_changes "$BASE" 2>/dev/null)"; eq "(f) unknown SLICE_INTEGRATION skips" "2" "$?"

echo "== (g) slice started on an unmerged parent branch (BASE ahead of merge-base)"
new_repo g
g checkout -qb parent; edit out/p.txt p1; commit "parent slice"
PBASE="$(g rev-parse HEAD)"
g checkout -qb s99; edit slice/in.txt s1; commit "s99: first"
eq "(g) net starts at BASE" "slice/in.txt" "$(net "$PBASE")"
eq "(g) without BASE it includes the parent" "out/p.txt slice/in.txt" "$(net)"

echo
echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
