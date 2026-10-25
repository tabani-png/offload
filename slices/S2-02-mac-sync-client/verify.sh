#!/usr/bin/env bash
# S2-02 done-signal. Contract: slices/S2-02-mac-sync-client/SPEC.md.
. "$(dirname "$0")/../S2-common/verify-lib.sh"
need bun
B="$ROOT/brain"
unset OFFLOAD_CONTROL_URL
s2_install "$B"; s2_typecheck "$B"
s2_suite "$B" tests/S2-02-sync 70
s2_tags "$B" tests/S2-02-sync PROJECT CONSENT ENVELOPE REF OUTBOX ENROLL ROUTES HERMETIC
all="$(cd "$B" && bun test 2>&1)"; echo "$all" | grep -qE "^ *0 fail$" || fail "full brain suite"
# Projectors may not see raw data.
s2_forbid "projectors import raw stores" "from ['\"]\.\./\.\./(store|understanding|vision|tone)/|EventRecord|FrameNote" "$B/src/sync/project"
if grep -rnoE "https?://[A-Za-z0-9.-]+" "$B/tests/S2-02-sync" 2>/dev/null | grep -vE "https?://(127\.0\.0\.1|localhost)" | grep -v "// allowed:" >/dev/null; then
  fail "sync tests use a non-loopback host"
fi
grep -q "Company sync" "$B/API.md" || fail "brain/API.md has no 'Company sync' section"
s2_schemas_frozen
s2_untouched "${S2_BASE:-main}" brain/src/workflows engine app control web
s2_finish S2-02-mac-sync-client
