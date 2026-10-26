#!/usr/bin/env bash
# S2-10 done-signal. Contract: slices/S2-10-continuity/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"
s2_install "$C"; s2_pg_up; s2_typecheck "$C"
s2_suite "$C" tests/S2-10 50
s2_tags "$C" tests/S2-10 STATES FREEZE DSYNC HANDOVER SUCCESSOR RESUME INFLIGHT LINKEDIN SOP AUDIT
s2_migrations_in 10 1000-1099
o="$(cd "$C" && bun test tests/S2-01 2>&1)"; echo "$o" | grep -qE "^ *0 fail$" || fail "S2-01 suite regressed"
s2_untouched "${S2_BASE:-main}" control/src/modules/broker control/src/modules/registry control/src/modules/workers control/src/app.ts control/src/ports.ts brain web
s2_schemas_frozen
s2_finish S2-10-continuity
