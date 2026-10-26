#!/usr/bin/env bash
# S2-08 done-signal. Contract: slices/S2-08-compliance/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"
s2_install "$C"; s2_pg_up
s2_typecheck "$C"
s2_suite "$C" tests/S2-08 60
s2_tags "$C" tests/S2-08 FEATURE PERIOD NOTICE CONSENT SELFVIEW ACCESSLOG CHAIN HIDDEN TEMPLATES RETENTION
# Migrations of this slice stay in its number range.
s2_migrations_in 08 0800-0899
s2_forbid "migrations must not bypass RLS" "BYPASSRLS|SECURITY DEFINER" "$C/migrations"
# Core and earlier slices stay green.
core="$(cd "$C" && bun test tests/S2-01 2>&1)"; echo "$core" | grep -qE "^ *0 fail$" || fail "S2-01 suite regressed"
s2_untouched "${S2_BASE:-main}" control/src/app.ts control/src/ports.ts control/src/rbac control/src/db control/src/auth control/src/audit control/src/schema control/tests/helpers brain engine
s2_schemas_frozen
for t in ontario-esa-policy ct-posting ny-notice-and-ack de-daily-notice bc-ab-notification quebec-8-1-8-2 ca-notice-at-collection uk-eu-transparency dpia ca-risk-assessment de-works-agreement; do
  [ -s "$ROOT/compliance/templates/$t.md" ] || fail "missing compliance/templates/$t.md"
  grep -q "Not legal advice" "$ROOT/compliance/templates/$t.md" 2>/dev/null || fail "$t.md lacks the counsel line"
done
s2_untouched "${S2_BASE:-main}" app web
s2_finish S2-08-compliance
