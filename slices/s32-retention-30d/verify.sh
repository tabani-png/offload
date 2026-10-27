#!/usr/bin/env bash
# s32-retention-30d done-signal. Contract: slices/s32-retention-30d/SPEC.md.
# 1. ENGINE (real offload-observer purge-now + status)  2. BRAIN (real cli.ts purge)  3. STATUS (serve, GET /status)
# 4. ONE SOURCE  5. COPY  6. SCOPE. One "FAIL ..." line per failing check. Bash 3.2 compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/s32-verify.XXXXXX")"
SERVE_PID=""
cleanup() { [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
H="$T/home"
D8="$(date -v-8d +%Y-%m-%d)"
D31="$(date -v-31d +%Y-%m-%d)"
echo "kept day $D8 (8 days old), expired day $D31 (31 days old)"

plant() {
  local d="$1"
  mkdir -p "$H/days" "$H/keys" "$H/frames/$d" "$H/brain-keys" "$H/sync/outbox"
  printf '{"x":1}\n{"x":2}\n' > "$H/days/$d.jsonl.enc"
  head -c 32 /dev/urandom > "$H/keys/$d.key"
  head -c 64 /dev/urandom > "$H/frames/$d/f1.enc"
  head -c 64 /dev/urandom > "$H/keys/brain-$d.key"
  head -c 32 /dev/urandom > "$H/brain-keys/$d.key"
  printf 'x\n' > "$H/sync/outbox/$d.json.enc"
  printf '{}\n' > "$H/frames/$d.jsonl"
}
chmod 700 "$T"; plant "$D8"; plant "$D31"
chmod -R go-rwx "$H"
ENGINE_FILES() { echo "days/$1.jsonl.enc keys/$1.key frames/$1/f1.enc keys/brain-$1.key"; }
BRAIN_FILES() { echo "brain-keys/$1.key sync/outbox/$1.json.enc frames/$1.jsonl"; }

echo "== ENGINE (offload-observer purge-now)"
EB="$T/engine-build"
if OFFLOAD_BUILD_DIR="$EB" "$ROOT/engine/build.sh" >"$T/engine-build.log" 2>&1; then
  OBS="$EB/offload-observer"
  out="$(OFFLOAD_KEYS=file "$OBS" purge-now --home "$H" 2>&1)"; echo "$out" | tail -2
  for f in $(ENGINE_FILES "$D8"); do [ -e "$H/$f" ] || fail "observer purge deleted $f (8 days old, inside 30 days)"; done
  for f in $(ENGINE_FILES "$D31"); do [ -e "$H/$f" ] && fail "observer purge kept $f (31 days old)"; done
  [ -d "$H/frames/$D31" ] && fail "observer purge kept frames/$D31/"
  kd="$(OFFLOAD_KEYS=file "$OBS" status --json --home "$H" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("keepDays"))' 2>/dev/null)"
  [ "$kd" = "30" ] && echo "observer status keepDays 30" || fail "observer status keepDays is '$kd', not 30"
else
  tail -15 "$T/engine-build.log"; fail "engine/build.sh failed"
fi

echo "== BRAIN (cli.ts purge)"
: > "$H/purge-log.jsonl"
bout="$(OFFLOAD_PLAIN=1 bun "$ROOT/brain/src/cli.ts" purge --home "$H" 2>&1)" || fail "brain purge exited non-zero: $(echo "$bout" | tail -1)"
echo "$bout" | tail -3
for f in $(BRAIN_FILES "$D8"); do [ -e "$H/$f" ] || fail "brain purge deleted $f (8 days old, inside 30 days)"; done
for f in $(BRAIN_FILES "$D31"); do [ -e "$H/$f" ] && fail "brain purge kept $f (31 days old)"; done
grep -q "\"day\":\"$D31\"" "$H/purge-log.jsonl" || fail "no brain purge-log line for $D31"
grep -q "\"day\":\"$D8\"" "$H/purge-log.jsonl" && fail "a brain purge-log line for $D8 (kept day)"

echo "== STATUS (serve, GET /status)"
OFFLOAD_PLAIN=1 bun "$ROOT/brain/src/cli.ts" serve --home "$H" --port 0 --model stub >"$T/serve.out" 2>"$T/serve.err" &
SERVE_PID=$!
ready=""
for _ in $(seq 1 120); do ready="$(grep -m1 '^OFFLOAD_BRAIN_READY ' "$T/serve.out" 2>/dev/null)"; [ -n "$ready" ] && break; sleep 0.25; done
if [ -n "$ready" ]; then
  port="$(echo "${ready#OFFLOAD_BRAIN_READY }" | python3 -c 'import json,sys; print(json.load(sys.stdin)["port"])')"
  token="$(echo "${ready#OFFLOAD_BRAIN_READY }" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  kd="$(curl -s -H "Authorization: Bearer $token" "http://127.0.0.1:$port/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["retention"]["keepDays"])' 2>/dev/null)"
  [ "$kd" = "30" ] && echo "brain /status retention.keepDays 30" || fail "brain /status retention.keepDays is '$kd', not 30"
else
  tail -5 "$T/serve.err"; fail "brain serve printed no ready line"
fi

echo "== ONE SOURCE"
g() { git -C "$ROOT" grep -nE "$1" -- "${@:2}"; }
g 'KEEP_DAYS = 7\b|defaultKeepDays = 7\b' engine brain && fail "a 7-day retention constant is left"
g 'keepDays\) \?\? 7' brain/src && fail "observer-route still falls back to 7"
g '^export const KEEP_DAYS' brain/src/api/dto.ts && fail "api/dto.ts still has its own KEEP_DAYS"
g 'keepDays: 7;' brain/src/api/types.ts && fail "api/types.ts still types keepDays as the literal 7"
g 'KEEP_DAYS = 30' brain/src/store/vault.ts >/dev/null || fail "brain/src/store/vault.ts KEEP_DAYS is not 30"
g 'defaultKeepDays = 30' engine/Sources >/dev/null || fail "engine Retention.defaultKeepDays is not 30"

echo "== COPY"
g 'deleted after 7 days|older than 7 days: deleted|older than 7 (local )?days|7-day (purge|deletion|rule|window)|kept 7 days|Data is kept for 7 days' \
  app/Sources README.md docs engine/README.md engine/Sources brain/API.md && fail "copy or docs still state a 7-day retention"

echo "== SCOPE"
BASE="$(git -C "$ROOT" merge-base HEAD origin/main)"
bad="$( { git -C "$ROOT" diff --name-only "$BASE"; git -C "$ROOT" ls-files --others --exclude-standard; } | sort -u \
  | grep -vE '^(engine/(Sources|Tests)/|engine/README\.md$|brain/(src|tests|fixtures)/|brain/(API|CONNECTORS)\.md$|app/Sources/(Core|Surfaces)/|slices/[^/]+/tests/|slices/s31-local-jobs/|slices/s32-retention-30d/|docs/|plan/|README\.md$)')"
[ -z "$bad" ] || fail "out of scope: $(echo $bad)"

[ $fails -eq 0 ] && { echo "s32-retention-30d: all checks pass"; exit 0; }
echo "s32-retention-30d: $fails failing check(s)"; exit 1
