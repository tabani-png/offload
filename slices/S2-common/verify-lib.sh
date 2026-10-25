#!/usr/bin/env bash
# Shared helpers for Stage 2 done-signals. Contract file: builders never edit it (coordinator only).
# Source from a slice's verify.sh:  . "$(dirname "$0")/../S2-common/verify-lib.sh"
# Bash 3.2 compatible. Every check prints one "FAIL ..." line on failure; s2_finish exits non-zero if any failed.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S2_FAILS=0
fail() { echo "FAIL $*"; S2_FAILS=$((S2_FAILS + 1)); }
need() { command -v "$1" >/dev/null 2>&1 || { echo "FAIL $1 not on PATH"; exit 1; }; }

# s2_install <pkgdir>: frozen-lockfile install when node_modules is missing.
s2_install() {
  [ -f "$1/package.json" ] || { fail "no $1/package.json"; return; }
  [ -d "$1/node_modules" ] || (cd "$1" && bun install --frozen-lockfile >/dev/null 2>&1) || fail "bun install failed in $1"
}

# s2_typecheck <pkgdir>
s2_typecheck() {
  local out; out="$(cd "$1" && bunx tsc --noEmit 2>&1)"
  if [ $? -ne 0 ]; then echo "$out" | head -20; fail "typecheck $1"; else echo "typecheck ok ($1)"; fi
}

# s2_pg_up: export OFFLOAD_PG_URL, starting control/docker-compose.yml when it is not set. Never touches a remote DB.
s2_pg_up() {
  if [ -n "${OFFLOAD_PG_URL:-}" ]; then
    case "$OFFLOAD_PG_URL" in *localhost*|*127.0.0.1*) ;; *) echo "FAIL OFFLOAD_PG_URL must be local"; exit 1;; esac
    return
  fi
  need docker
  [ -f "$ROOT/control/docker-compose.yml" ] || { fail "no control/docker-compose.yml"; return; }
  docker compose -f "$ROOT/control/docker-compose.yml" up -d --wait >/dev/null 2>&1 || { fail "docker compose up (is Docker running? disk space?)"; return; }
  export OFFLOAD_PG_URL="postgres://offload_migrator:offload@127.0.0.1:${OFFLOAD_PG_PORT:-54329}/offload_test"
}

# s2_suite <pkgdir> <testdir relative to pkgdir> <min tests>: run the slice suite; sets S2_RAN.
s2_suite() {
  local out code failed
  [ -d "$1/$2" ] || { fail "no $1/$2"; S2_RAN=0; return; }
  out="$(cd "$1" && bun test "$2" 2>&1)"; code=$?
  S2_RAN="$(echo "$out" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)"
  failed="$(echo "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
  [ $code -eq 0 ] && [ "${failed:-1}" = "0" ] || { echo "$out" | grep -E "\(fail\)|error:" | head -20; fail "suite $2 (${failed:-?} failing)"; }
  [ "${S2_RAN:-0}" -ge "$3" ] || fail "only ${S2_RAN:-0} tests in $2, need at least $3"
  echo "suite $2: ${S2_RAN:-0} tests"
}

# s2_tags <pkgdir> <testdir> TAG...: every tag has at least one passing test named "TAG: ...".
s2_tags() {
  local pkg="$1" dir="$2"; shift 2
  local tag t n
  for tag in "$@"; do
    grep -rqE "test\(\"$tag: " "$pkg/$dir" || { fail "no test named \"$tag: ...\""; continue; }
    t="$(cd "$pkg" && bun test "$dir" -t "$tag: " 2>&1)"
    n="$(echo "$t" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
    echo "$t" | grep -qE "^ *0 fail$" && [ "${n:-0}" -gt 0 ] && echo "$tag: $n passing" || fail "tests for $tag did not pass"
  done
}

# s2_forbid <message> <extended regex> <path...>: fail when the pattern appears.
s2_forbid() {
  local msg="$1" re="$2"; shift 2
  if grep -rnE "$re" "$@" 2>/dev/null | grep -v "// allowed:" >/dev/null; then
    grep -rnE "$re" "$@" 2>/dev/null | grep -v "// allowed:" | head -5 >&2; fail "$msg"
  fi
}

# s2_untouched <base ref> <path...>: no commit on this branch since <base> changed these paths.
s2_untouched() {
  local base="$1"; shift
  local changed; changed="$(git -C "$ROOT" diff --name-only "$base"...HEAD -- "$@" 2>/dev/null)"
  [ -z "$changed" ] || { echo "$changed" | head -10; fail "out-of-scope paths changed: $*"; }
}

# s2_schemas_frozen: schemas/stage2 matches main (contract changes go through the coordinator).
s2_schemas_frozen() { s2_untouched "${S2_BASE:-main}" schemas/stage2 slices/S2-common; }

s2_finish() {
  if [ "$S2_FAILS" -ne 0 ]; then echo "$1 verify: $S2_FAILS check(s) failed"; exit 1; fi
  echo "PASS $1"
}
