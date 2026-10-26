#!/usr/bin/env bash
# S2-07 done-signal. Contract: slices/S2-07-policies-broker/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"
s2_install "$C"; s2_pg_up
s2_typecheck "$C"
s2_suite "$C" tests/S2-07 80
s2_tags "$C" tests/S2-07 HASH TOKEN ITEM EXEC POLICY OVERNIGHT KILL LINKEDIN RBAC AUDIT
# Migrations of this slice stay in its number range.
for m in $(s2_changed "${S2_BASE:-main}" control/migrations); do
  case "$(basename "$m")" in 07[0-9][0-9]_*) ;; *) fail "migration outside range 0700-0799: $m";; esac
done
s2_forbid "migrations must not bypass RLS" "BYPASSRLS|SECURITY DEFINER" "$C/migrations"
# Core and earlier slices stay green.
core="$(cd "$C" && bun test tests/S2-01 2>&1)"; echo "$core" | grep -qE "^ *0 fail$" || fail "S2-01 suite regressed"
s2_untouched "${S2_BASE:-main}" control/src/app.ts control/src/ports.ts control/src/rbac control/src/db control/src/auth control/src/audit control/src/schema control/tests/helpers brain engine
s2_schemas_frozen
grep -rqE "brain/src/workflows" "$C/src/modules/broker" || fail "broker must reuse the brain gate functions (or a parity-tested copy under broker/stage1/)"
s2_finish S2-07-policies-broker
