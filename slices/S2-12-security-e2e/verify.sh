#!/usr/bin/env bash
# S2-12 done-signal. Contract: slices/S2-12-security-e2e/SPEC.md. Runs every S2 done-signal, then the e2e suite.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
for v in "$ROOT"/slices/S2-0*/verify.sh "$ROOT"/slices/S2-1[0-13]*/verify.sh; do
  case "$v" in *S2-12-*) continue;; esac
  bash "$v" >/dev/null 2>&1 || fail "$(basename "$(dirname "$v")") verify"
done
s2_pg_up
E="$ROOT/tests/e2e-stage2"
[ -f "$E/package.json" ] && s2_install "$E"
s2_suite "$E" . 25
s2_tags "$E" . ISOLATION RBAC LEAK INJECTION E2E CHAIN REVIEW
for d in docs/security/stage2-review.md docs/security/break-glass.md compliance/REVIEW-CHECKLIST.md; do [ -s "$ROOT/$d" ] || fail "missing $d"; done
s2_schemas_frozen
s2_finish S2-12-security-e2e
