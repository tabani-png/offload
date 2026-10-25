#!/usr/bin/env bash
# S2-01 done-signal. Contract: slices/S2-01-control-core/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"
s2_install "$C"; s2_pg_up
s2_typecheck "$C"
s2_suite "$C" tests/S2-01 90
s2_tags "$C" tests/S2-01 RLS TENANT AUTH DEVICE RBAC AUDIT DSYNC ORG SCHEMA LOADER
s2_forbid "migrations must not bypass RLS" "BYPASSRLS|SECURITY DEFINER" "$C/migrations"
s2_forbid "tests must not call real WorkOS" "api\.workos\.com" "$C/tests"
[ -f "$C/src/ports.ts" ] && [ -f "$C/src/rbac/permissions.ts" ] || fail "ports.ts and rbac/permissions.ts are required"
s2_schemas_frozen
s2_untouched "${S2_BASE:-main}" brain engine app web packages
s2_finish S2-01-control-core
