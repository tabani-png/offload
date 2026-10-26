#!/usr/bin/env bash
# S2-06 done-signal. Contract: slices/S2-06-registry/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"
s2_install "$C"; s2_pg_up
s2_typecheck "$C"
s2_suite "$C" tests/S2-06 50
s2_tags "$C" tests/S2-06 PROPOSAL PROMOTE VERSION BINDING STRIP SOP RBAC AUDIT
# Migrations of this slice stay in its number range.
for m in $(s2_changed "${S2_BASE:-main}" control/migrations); do
  case "$(basename "$m")" in 06[0-9][0-9]_*) ;; *) fail "migration outside range 0600-0699: $m";; esac
done
s2_forbid "migrations must not bypass RLS" "BYPASSRLS|SECURITY DEFINER" "$C/migrations"
# Core and earlier slices stay green.
core="$(cd "$C" && bun test tests/S2-01 2>&1)"; echo "$core" | grep -qE "^ *0 fail$" || fail "S2-01 suite regressed"
s2_untouched "${S2_BASE:-main}" control/src/app.ts control/src/ports.ts control/src/rbac control/src/db control/src/auth control/src/audit control/src/schema control/tests/helpers brain engine
s2_schemas_frozen
s2_untouched "${S2_BASE:-main}" web
s2_finish S2-06-registry
