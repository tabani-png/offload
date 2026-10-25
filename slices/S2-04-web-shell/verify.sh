#!/usr/bin/env bash
# S2-04 done-signal. Contract: slices/S2-04-web-shell/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
Wb="$ROOT/web"
s2_install "$Wb"; s2_typecheck "$Wb"
s2_suite "$Wb" tests 50
s2_tags "$Wb" tests TOKENS SCHEMA ROUTES STATES NORANK A11Y BUILD
(cd "$Wb" && bunx vite build >/dev/null 2>&1) || fail "vite build"
grep -q "cubic-bezier(0.16, *1, *0.3, *1)" "$Wb/src/design/tokens.ts" 2>/dev/null || fail "tokens.ts lacks the app easing"
s2_forbid "no CSS framework or component kit" "tailwindcss|@mui/|antd|chakra-ui|bootstrap" "$Wb/package.json"
s2_schemas_frozen
s2_untouched "${S2_BASE:-main}" app brain control engine packages
s2_finish S2-04-web-shell
