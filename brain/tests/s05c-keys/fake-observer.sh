#!/bin/bash
# Fake offload-observer for brain tests: wrap-key / unwrap-key / status --json with the real CLI's contract
# (engine/README.md "Brain keys"), minus the Keychain. Keys are kept as base64 text in keys/brain-NAME.key.
# FAKE_OBSERVER_LOG: append each argv line. FAKE_OBSERVER_FAIL_UNWRAP=1: unwrap-key exits 1. FAKE_OBSERVER_STATUS: file printed by `status`. FAKE_OBSERVER_EXIT: status exit.
[ -n "$FAKE_OBSERVER_LOG" ] && echo "$*" >> "$FAKE_OBSERVER_LOG"
cmd="$1"; shift
home="$OFFLOAD_HOME"; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) home="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$cmd" in
  wrap-key|unwrap-key)
    if [ "$OFFLOAD_KEYS" = "file" ]; then echo "$cmd: brain keys need the Keychain; unset OFFLOAD_KEYS=file" >&2; exit 1; fi
    echo "$name" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$' || { echo "--name has an invalid value" >&2; exit 2; }
    f="$home/keys/brain-$name.key"
    if [ "$cmd" = "unwrap-key" ]; then
      [ -n "$FAKE_OBSERVER_FAIL_UNWRAP" ] && { echo "unwrap-key: keychain locked" >&2; exit 1; }
      [ -f "$f" ] || { echo "unwrap-key: no brain key $name" >&2; exit 1; }
      sed -n 2p "$f"; exit 0
    fi
    input="$(cat | tr -d '\n')"
    if [ -f "$f" ]; then
      stored="$(sed -n 2p "$f")"
      if [ -n "$input" ] && [ "$input" != "$stored" ]; then echo "wrap-key: a different key is stored" >&2; exit 1; fi
      echo "$stored"; exit 0
    fi
    [ -z "$input" ] && input="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
    [ ${#input} -eq 44 ] || { echo "wrap-key: stdin must be one base64 line holding exactly 32 bytes" >&2; exit 1; }
    mkdir -p "$home/keys"; chmod 700 "$home/keys"
    printf 'FAKEOKW1\n%s\n' "$input" > "$f"; chmod 600 "$f"
    echo "$input"; exit 0 ;;
  status)
    [ -n "$FAKE_OBSERVER_STATUS" ] && cat "$FAKE_OBSERVER_STATUS"
    exit "${FAKE_OBSERVER_EXIT:-0}" ;;
esac
echo "unknown command '$cmd'" >&2
exit 2
