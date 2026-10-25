#!/usr/bin/env bash
# S2-03 done-signal. Contract: slices/S2-03-hours-saved/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
P="$ROOT/packages/hours-saved"
s2_install "$P"; s2_typecheck "$P"
s2_suite "$P" tests 60
s2_tags "$P" tests MEDIAN GRADE RUN TOTAL FLOOR DISPLAY GOLDEN PURE
s2_forbid "hs-1 must be pure" "Date\.now|new Date\(|Math\.random|fetch\(|Bun\.|process\.|from ['\"]node:" "$P/src"
grep -q '"dependencies"' "$P/package.json" && fail "packages/hours-saved must have no runtime dependencies"
s2_schemas_frozen
s2_untouched "${S2_BASE:-main}" brain engine app control web
s2_finish S2-03-hours-saved
