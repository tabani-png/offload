#!/usr/bin/env bash
# S2-11 done-signal. Contract: slices/S2-11-dashboard-wiring/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"; Wb="$ROOT/web"
s2_install "$C"; s2_install "$Wb"; s2_pg_up
s2_typecheck "$C"; s2_typecheck "$Wb"
s2_suite "$C" tests/S2-11 15
s2_suite "$Wb" tests/S2-11 15
s2_tags "$C" tests/S2-11 SERVE REAL CSRF
s2_tags "$Wb" tests/S2-11 FLOOR GATED EVIDENCE NORANK
(cd "$Wb" && bunx vite build >/dev/null 2>&1) || fail "vite build"
o="$(cd "$Wb" && bun test tests 2>&1)"; echo "$o" | grep -qE "^ *0 fail$" || fail "web suite (incl. S2-04) regressed"
s2_untouched "${S2_BASE:-main}" brain app control/src/app.ts control/src/ports.ts
s2_schemas_frozen
s2_finish S2-11-dashboard-wiring
