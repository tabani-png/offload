#!/usr/bin/env bash
# S2-09 done-signal. Contract: slices/S2-09-cloud-workers/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
C="$ROOT/control"; unset OFFLOAD_CMA_REAL
s2_install "$C"; s2_pg_up; s2_typecheck "$C"
s2_suite "$C" tests/S2-09 70
s2_tags "$C" tests/S2-09 PROVISION SESSION CONFIRM CUSTOM BUDGET SCHEDULE KILL INJECTION DIGEST HERMETIC
for m in $(s2_changed "${S2_BASE:-main}" control/migrations); do
  case "$(basename "$m")" in 09[0-9][0-9]_*) ;; *) fail "migration outside range 0900-0999: $m";; esac
done
if grep -rln "new Anthropic(" "$C/src/modules/workers" "$C/tests/S2-09" 2>/dev/null | grep -v "/workers/managed-agents.ts$" >/dev/null; then
  fail "real model client created outside workers/managed-agents.ts"
fi
s2_forbid "tests must not enable the real Managed Agents client" "OFFLOAD_CMA_REAL\s*[:=]" "$C/tests"
grep -q '"@anthropic-ai/sdk": "1.3.0"' "$C/package.json" || fail "@anthropic-ai/sdk must be pinned to 1.3.0 (ADR 0008)"
for t in S2-01 S2-07; do o="$(cd "$C" && bun test tests/$t 2>&1)"; echo "$o" | grep -qE "^ *0 fail$" || fail "$t suite regressed"; done
s2_untouched "${S2_BASE:-main}" control/src/modules/broker control/src/modules/policies control/src/modules/registry control/src/app.ts control/src/ports.ts brain
s2_schemas_frozen
s2_finish S2-09-cloud-workers
