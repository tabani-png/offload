#!/usr/bin/env bash
# S2-13 done-signal. Contract: slices/S2-13-mac-company-surfaces/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need swiftc
(cd "$ROOT/app" && bash build.sh >/dev/null 2>&1) || fail "app/build.sh"
[ -d "$ROOT/app/Sources/Surfaces/Company" ] || fail "no app/Sources/Surfaces/Company"
for s in connect notice share status; do ls "$ROOT/app/snapshots/company/"*"$s"* >/dev/null 2>&1 || fail "missing snapshot for $s"; done
# Model tests: the app's existing test entry point must include a Company group (wired by the test author).
grep -rqE "Company" "$ROOT/app/Sources/Surfaces/Company" || fail "Company surfaces empty"
s2_untouched "${S2_BASE:-main}" app/Sources/Design brain engine control web
s2_schemas_frozen
s2_finish S2-13-mac-company-surfaces
